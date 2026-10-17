import { expect, test } from "bun:test";
import {
  GOAL_CONTROL_ACTION,
  decidePermission,
  type PermissionInput,
} from "../src/permission.ts";

/** Default unix scenario; every case overrides only what it needs. */
function input(over: Partial<PermissionInput> = {}): PermissionInput {
  return {
    action: "fs.write",
    resources: ["/root/proj/a.txt"],
    sessionDirectory: "/root/proj",
    goalActive: true,
    incoming: "ask",
    ...over,
  };
}

/** Assert the deny decision plus the required message parts. */
function expectDeny(d: unknown, ...messageParts: string[]) {
  const decision = d as { effect: "deny"; message?: string };
  expect(decision.effect).toBe("deny");
  for (const part of messageParts) {
    expect(decision.message).toContain(part);
  }
}

// ── group 1 — rule 1: incoming deny is never relaxed ─────────────────────────

test("rule 1: incoming deny leaves, even with an active goal and in-dir resources", () => {
  expect(decidePermission(input({ incoming: "deny" }))).toEqual({ effect: "leave" });
});

test("rule 1: incoming deny beats the goal.control self-grant", () => {
  expect(
    decidePermission(input({ action: GOAL_CONTROL_ACTION, resources: ["goal:42"], incoming: "deny" })),
  ).toEqual({ effect: "leave" });
});

// ── group 2 — rule 2: goal.control self-grant, before any path check ──────────

test("rule 2: goal.control during an active goal allows on ask", () => {
  expect(decidePermission(input({ action: GOAL_CONTROL_ACTION }))).toEqual({ effect: "allow" });
});

test("rule 2: goal.control during an active goal passes allow through", () => {
  expect(
    decidePermission(input({ action: GOAL_CONTROL_ACTION, incoming: "allow" })),
  ).toEqual({ effect: "allow" });
});

test("rule 2: goal.control without an active goal leaves", () => {
  expect(
    decidePermission(input({ action: GOAL_CONTROL_ACTION, goalActive: false })),
  ).toEqual({ effect: "leave" });
});

test("rule 2: goal.control is decided before path and sessionDirectory checks", () => {
  expect(
    decidePermission(
      input({ action: GOAL_CONTROL_ACTION, sessionDirectory: undefined, resources: ["goal:42"] }),
    ),
  ).toEqual({ effect: "allow" });
});

// ── group 3 — rule 3: all resources inside the session directory ─────────────

test("rule 3: all unix paths inside the directory are allowed on ask", () => {
  expect(
    decidePermission(input({ resources: ["/root/proj/a.txt", "/root/proj/sub/b.txt"] })),
  ).toEqual({ effect: "allow" });
});

test("rule 3: all paths inside leave on allow (nothing to change)", () => {
  expect(
    decidePermission(
      input({ resources: ["/root/proj/a.txt", "/root/proj/sub/b.txt"], incoming: "allow" }),
    ),
  ).toEqual({ effect: "leave" });
});

test("rule 3: all windows paths inside the directory are allowed on ask", () => {
  expect(
    decidePermission(
      input({
        sessionDirectory: "D:\\dev\\proj",
        resources: ["D:\\dev\\proj\\file.txt", "D:/dev/proj/x/y.txt"],
      }),
    ),
  ).toEqual({ effect: "allow" });
});

test("rule 3: windows paths inside leave on allow", () => {
  expect(
    decidePermission(
      input({
        sessionDirectory: "D:\\dev\\proj",
        resources: ["D:\\dev\\proj\\file.txt"],
        incoming: "allow",
      }),
    ),
  ).toEqual({ effect: "leave" });
});

// ── group 4 — rule 4: any resource outside the directory denies ──────────────

test("rule 4: unix path outside the directory denies with the original path and goal_block", () => {
  expectDeny(
    decidePermission(input({ resources: ["/etc/passwd"] })),
    "/etc/passwd",
    "goal_block",
    "/root/proj",
  );
});

test("rule 4: windows path on another drive denies with the original path", () => {
  expectDeny(
    decidePermission(input({ sessionDirectory: "D:\\dev\\proj", resources: ["E:\\other\\file.txt"] })),
    "E:\\other\\file.txt",
    "goal_block",
    "D:\\dev\\proj",
  );
});

test("rule 4: a sibling prefix of the directory name denies (slash boundary)", () => {
  expectDeny(
    decidePermission(input({ resources: ["/root/projection/file.txt"] })),
    "/root/projection/file.txt",
    "goal_block",
  );
});

test("rule 4: dot-dot traversal is resolved before the containment check", () => {
  expectDeny(
    decidePermission(input({ resources: ["/root/proj/../../../etc/passwd"] })),
    "/root/proj/../../../etc/passwd",
    "goal_block",
  );
});

test("rule 4: windows dot-dot traversal above the drive root denies", () => {
  expectDeny(
    decidePermission(
      input({
        sessionDirectory: "D:\\dev\\proj",
        resources: ["D:\\dev\\proj\\..\\..\\..\\Windows\\system32\\cmd.exe"],
      }),
    ),
    "goal_block",
  );
});

// ── group 5 — rule 5: any non-absolute resource leaves the whole request ─────

test("rule 5: a url resource leaves", () => {
  expect(
    decidePermission(input({ resources: ["https://example.com/file.txt"] })),
  ).toEqual({ effect: "leave" });
});

test("rule 5: a command-text resource leaves", () => {
  expect(decidePermission(input({ resources: ["npm install"] }))).toEqual({ effect: "leave" });
});

test("rule 5: a relative path leaves", () => {
  expect(decidePermission(input({ resources: ["src/foo.ts"] }))).toEqual({ effect: "leave" });
});

test("rule 5: an empty string resource leaves", () => {
  expect(decidePermission(input({ resources: [""] }))).toEqual({ effect: "leave" });
});

test("rule 5: bare * and ** resources leave", () => {
  expect(decidePermission(input({ resources: ["*"] }))).toEqual({ effect: "leave" });
  expect(decidePermission(input({ resources: ["**"] }))).toEqual({ effect: "leave" });
});

test("rule 5: a drive letter without a separator (D:foo) is not an absolute path", () => {
  expect(decidePermission(input({ resources: ["D:foo.txt"] }))).toEqual({ effect: "leave" });
});

test("rule 5: D:/foo is an absolute path and denies when outside (unlike D:foo)", () => {
  expectDeny(decidePermission(input({ resources: ["D:/foo.txt"] })), "D:/foo.txt", "goal_block");
});

test("rule 5: one non-path among in/out paths leaves the whole request (never partial)", () => {
  expect(
    decidePermission(input({ resources: ["/etc/passwd", "npm install"] })),
  ).toEqual({ effect: "leave" });
});

test("rule 5: no resources at all leaves (nothing to sandbox)", () => {
  expect(decidePermission(input({ resources: [] }))).toEqual({ effect: "leave" });
});

// ── group 6 — rule 6: traversal + glob suffixes ──────────────────────────────

test("rule 6: dir/** stays a path and compares as dir (allowed inside)", () => {
  expect(decidePermission(input({ resources: ["/root/proj/**"] }))).toEqual({ effect: "allow" });
});

test("rule 6: dir/* stays a path and compares as dir (allowed inside)", () => {
  expect(decidePermission(input({ resources: ["/root/proj/*"] }))).toEqual({ effect: "allow" });
});

test("rule 6: a glob of the parent directory denies (the parent is not inside)", () => {
  expectDeny(decidePermission(input({ resources: ["/root/**"] })), "/root/**", "goal_block");
});

test("rule 6: bare /* and /** have no absolute base and leave", () => {
  expect(decidePermission(input({ resources: ["/*"] }))).toEqual({ effect: "leave" });
  expect(decidePermission(input({ resources: ["/**"] }))).toEqual({ effect: "leave" });
});

test("rule 6: windows dir glob with backslashes compares as dir", () => {
  expect(
    decidePermission(
      input({ sessionDirectory: "D:\\dev\\proj", resources: ["D:\\dev\\proj\\**"] }),
    ),
  ).toEqual({ effect: "allow" });
});

// ── group 7 — rule 7: sessionDirectory missing / no active goal ──────────────

test("rule 7: a missing sessionDirectory leaves even for in-dir-looking paths", () => {
  expect(decidePermission(input({ sessionDirectory: undefined }))).toEqual({ effect: "leave" });
});

test("rule 7: an empty sessionDirectory leaves", () => {
  expect(decidePermission(input({ sessionDirectory: "" }))).toEqual({ effect: "leave" });
});

test("path rules are silent when the goal is not active", () => {
  expect(decidePermission(input({ goalActive: false }))).toEqual({ effect: "leave" });
});

// ── group 8 — windows path rules ─────────────────────────────────────────────

test("windows: drive and dir case mismatch is insensitive (c:/dev/proj root vs C:\\DEV\\proj\\x.txt)", () => {
  expect(
    decidePermission(
      input({ sessionDirectory: "c:/dev/proj", resources: ["C:\\DEV\\proj\\x.txt"] }),
    ),
  ).toEqual({ effect: "allow" });
});

test("windows: case insensitivity holds with an uppercase root too", () => {
  expect(
    decidePermission(
      input({ sessionDirectory: "C:\\dev\\proj", resources: ["c:/dev/proj/x.txt"] }),
    ),
  ).toEqual({ effect: "allow" });
});

test("windows: mixed / and \\ separators normalize", () => {
  expect(
    decidePermission(
      input({ sessionDirectory: "D:/dev/proj", resources: ["D:/dev/proj\\file.txt"] }),
    ),
  ).toEqual({ effect: "allow" });
});

test("windows: a directory on another drive denies", () => {
  expectDeny(
    decidePermission(input({ sessionDirectory: "D:\\dev\\proj", resources: ["E:\\other"] })),
    "E:\\other",
    "goal_block",
    "D:\\dev\\proj",
  );
});

test("unix: case differences still deny (unix roots stay case-sensitive)", () => {
  expectDeny(decidePermission(input({ resources: ["/root/PROJ/file.txt"] })), "goal_block");
});

// ── group 9 — degenerate sessionDirectory fails closed (review fix) ──────────

test("degenerate sessionDirectory '.' leaves instead of matching every unix path", () => {
  expect(
    decidePermission(input({ sessionDirectory: ".", resources: ["/etc/passwd"] })),
  ).toEqual({ effect: "leave" });
});

test("degenerate sessionDirectory '..' leaves", () => {
  expect(
    decidePermission(input({ sessionDirectory: "..", resources: ["/etc/passwd"] })),
  ).toEqual({ effect: "leave" });
});

test("segment-only sessionDirectory 'a/../' (normalizes to empty) leaves", () => {
  expect(
    decidePermission(input({ sessionDirectory: "a/../", resources: ["/etc/passwd"] })),
  ).toEqual({ effect: "leave" });
});

test("bare drive root 'D:/' is still a legitimate directory (contains its paths)", () => {
  expect(
    decidePermission(
      input({ sessionDirectory: "D:/", resources: ["D:/dev/proj/a.txt"] }),
    ),
  ).toEqual({ effect: "allow" });
});

test("bare drive root with backslashes 'D:\\' behaves the same", () => {
  expect(
    decidePermission(
      input({ sessionDirectory: "D:\\", resources: ["D:\\dev\\proj\\a.txt"] }),
    ),
  ).toEqual({ effect: "allow" });
});

test("filesystem root '/' contains every unix absolute path (boundary, not a deny-all)", () => {
  expect(
    decidePermission(input({ sessionDirectory: "/", resources: ["/etc/passwd"] })),
  ).toEqual({ effect: "allow" });
});

test("filesystem root '/' does not contain windows drive paths", () => {
  expectDeny(
    decidePermission(input({ sessionDirectory: "/", resources: ["C:\\temp\\x.txt"] })),
    "C:\\temp\\x.txt",
    "goal_block",
  );
});

// ── group 10 — 2026-10-17 ruling: reads unrestricted, only write actions are
// path-contained; indistinguishable actions are unrestricted ─────────────────

test("fs.read outside the directory leaves (reads are unrestricted)", () => {
  expect(
    decidePermission(input({ action: "fs.read", resources: ["/etc/passwd"] })),
  ).toEqual({ effect: "leave" });
});

test("fs.read inside the directory also leaves (the plugin takes no stance on reads)", () => {
  expect(
    decidePermission(input({ action: "fs.read", resources: ["/root/proj/a.txt"] })),
  ).toEqual({ effect: "leave" });
});

test("fs.read outside on a windows path leaves", () => {
  expect(
    decidePermission(
      input({
        action: "fs.read",
        sessionDirectory: "D:\\dev\\proj",
        resources: ["E:\\other\\file.txt"],
      }),
    ),
  ).toEqual({ effect: "leave" });
});

test("an unknown action with an outside path leaves (indistinguishable = unrestricted)", () => {
  expect(
    decidePermission(input({ action: "bash", resources: ["/etc/passwd"] })),
  ).toEqual({ effect: "leave" });
});

test("fs.write outside the directory still denies (write containment is kept)", () => {
  expectDeny(
    decidePermission(input({ action: "fs.write", resources: ["/etc/passwd"] })),
    "/etc/passwd",
    "goal_block",
  );
});
