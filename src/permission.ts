/**
 * Permission decisions for the goal loop: path sandboxing (unix + windows
 * absolute paths) plus the goal.control self-grant.
 *
 * Pure functions, zero imports. Rule order (first match wins):
 *  1. incoming === "deny"                    -> leave (a deny is never relaxed)
 *  2. action === GOAL_CONTROL_ACTION         -> allow iff goalActive (before any path check)
 *  3. !goalActive                             -> leave (path rules only apply to an active goal)
 *  4. sessionDirectory missing/empty/degenerate (normalizes to "") -> leave
 *  5. empty resources                         -> leave (nothing to sandbox)
 *  6. any resource not an absolute path       -> leave (never a partial opinion)
 *  7. any resource outside the session dir    -> deny, message names the path and goal_block
 *  8. every resource inside                   -> allow on ask, leave on allow
 */

export const GOAL_CONTROL_ACTION = "goal.control";

export type PermissionDecision =
  | { effect: "allow" | "deny"; message?: string }
  | { effect: "leave" };

export interface PermissionInput {
  action: string;
  resources: readonly string[];
  sessionDirectory?: string;
  goalActive: boolean;
  incoming: "allow" | "ask" | "deny";
}

export function decidePermission(input: PermissionInput): PermissionDecision {
  if (input.incoming === "deny") return { effect: "leave" };

  if (input.action === GOAL_CONTROL_ACTION) {
    return input.goalActive ? { effect: "allow" } : { effect: "leave" };
  }

  if (!input.goalActive) return { effect: "leave" };

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
