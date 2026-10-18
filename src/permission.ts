/**
 * Permission decisions for the goal loop: path sandboxing of known write
 * actions (unix + windows absolute paths) plus the goal.control self-grant.
 *
 * Pure functions, zero imports. Rule order (first match wins):
 *  1. incoming === "deny"                    -> leave (a deny is never relaxed)
 *  2. action === GOAL_CONTROL_ACTION         -> allow iff a goal record exists,
 *                                               ANY status (2026-10-18 ruling: the
 *                                               conversational surface — paused /
 *                                               blocked / budget_limited goals must
 *                                               stay manageable via tools; terminal
 *                                               goals stay viewable) — before any path check
 *  3. action not in WRITE_ACTIONS            -> leave (reads and indistinguishable
 *                                               actions are unrestricted — 2026-10-17
 *                                               ruling: only writes are contained)
 *  4. goalStatus !== "active"                -> leave (path containment applies
 *                                               only to an ACTIVE goal — the data
 *                                               plane was NOT widened by the 2026-10-18
 *                                               control-plane ruling)
 *  5. sessionDirectory missing/empty/degenerate (normalizes to "") -> leave
 *  6. empty resources                         -> leave (nothing to sandbox)
 *  7. any resource not an absolute path       -> leave (never a partial opinion)
 *  8. any resource outside the session dir    -> deny, message names the path and goal_block
 *  9. every resource inside                   -> allow on ask, leave on allow
 */

export const GOAL_CONTROL_ACTION = "goal.control";

/** Actions whose resources are path-contained while a goal is active. */
export const WRITE_ACTIONS: readonly string[] = ["fs.write"];

export type PermissionDecision =
  | { effect: "allow" | "deny"; message?: string }
  | { effect: "leave" };

export interface PermissionInput {
  action: string;
  resources: readonly string[];
  sessionDirectory?: string;
  /**
   * The session's goal status (undefined = no goal record). The control plane
   * (rule 2) only cares whether a goal EXISTS; the data plane (rule 4) only
   * engages for "active".
   */
  goalStatus?: string;
  incoming: "allow" | "ask" | "deny";
}

export function decidePermission(input: PermissionInput): PermissionDecision {
  if (input.incoming === "deny") return { effect: "leave" };

  // Control plane: self-grant goal.control for any existing goal record (any
  // status) — conversational management (2026-10-18 ruling).
  if (input.action === GOAL_CONTROL_ACTION) {
    return input.goalStatus !== undefined ? { effect: "allow" } : { effect: "leave" };
  }

  // Only known write actions are path-contained; reads and indistinguishable
  // actions get no opinion (2026-10-17 ruling: reads are unrestricted).
  if (!WRITE_ACTIONS.includes(input.action)) return { effect: "leave" };

  // Data plane: containment engages only while the goal is active.
  if (input.goalStatus !== "active") return { effect: "leave" };

  const sessionDirectory = input.sessionDirectory;
  if (!sessionDirectory) return { effect: "leave" };

  if (input.resources.length === 0) return { effect: "leave" };

  const root = normalizePath(sessionDirectory);
  // A sessionDirectory that normalizes to nothing ("." / ".." / "a/../") is
  // unusable: there is no sandbox to check against, so no opinion. Without
  // this, an empty root would match every unix path via prefix "startsWith('/')".
  if (!root) return { effect: "leave" };

  // Pass 1: every resource must normalize to an absolute path; otherwise
  // the whole request is left undecided (never a partial opinion).
  const bases: string[] = [];
  for (const resource of input.resources) {
    const base = stripGlob(normalizePath(resource));
    if (!isAbsolutePath(base)) return { effect: "leave" };
    bases.push(base);
  }

  // Pass 2: fail closed — one outside resource denies the whole request.
  for (let i = 0; i < bases.length; i++) {
    if (!isPathInside(bases[i], root)) {
      return {
        effect: "deny",
        message:
          `Denied by goals plugin: ${input.resources[i]} is outside the session ` +
          `working directory ${sessionDirectory}. Call goal_block to report the ` +
          `blocker instead of forcing the operation.`,
      };
    }
  }

  return input.incoming === "ask" ? { effect: "allow" } : { effect: "leave" };
}

/**
 * Normalize an absolute path for comparison: backslashes to slashes, drop
 * `.` segments, resolve `..` segments without climbing above the unix root
 * or a windows drive root, keep a leading `/`.
 */
function normalizePath(raw: string): string {
  const forward = raw.replace(/\\/g, "/");
  const absolute = forward.startsWith("/");
  const out: string[] = [];
  for (const part of forward.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const atRoot = out.length === 0 || (out.length === 1 && /^[a-zA-Z]:$/.test(out[0]));
      if (!atRoot) out.pop();
      continue;
    }
    out.push(part);
  }
  if (absolute) return out.length > 0 ? `/${out.join("/")}` : "/";
  return out.join("/");
}

/** Strip trailing `/**` and `/*` glob suffixes; bare `*`/`**` become `""`. */
function stripGlob(path: string): string {
  let out = path;
  for (;;) {
    if (out.endsWith("/**")) {
      out = out.slice(0, -3);
      continue;
    }
    if (out.endsWith("/*")) {
      out = out.slice(0, -2);
      continue;
    }
    if (out === "*" || out === "**") return "";
    return out;
  }
}

/** Absolute = leading `/` or a drive letter followed by a separator. */
function isAbsolutePath(path: string): boolean {
  return path !== "" && (path.startsWith("/") || isWindowsDrivePath(path));
}

/** Drive-letter form, e.g. `D:/dev` or `D:\dev` (a separator is required). */
function isWindowsDrivePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path);
}

/**
 * `candidate` is inside `root` when equal or prefixed by `root + "/"`
 * (a `/` root uses no separator, so every absolute unix path is inside;
 * drive paths are not). Case-insensitive when at least one side is a
 * windows drive path; unix roots stay case-sensitive. An empty root
 * contains nothing (defense in depth against a future caller).
 */
function isPathInside(candidate: string, root: string): boolean {
  if (root === "") return false;
  const caseInsensitive = isWindowsDrivePath(candidate) || isWindowsDrivePath(root);
  const a = caseInsensitive ? candidate.toLowerCase() : candidate;
  const b = caseInsensitive ? root.toLowerCase() : root;
  if (a === b) return true;
  if (b === "/") return a.startsWith("/");
  return a.startsWith(`${b}/`);
}
