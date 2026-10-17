// src/decisionlog — boundary decision log: one JSON line per gate decision
// (wake / hold / skip), append-only, best-effort (a broken log never breaks
// the loop).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "bun:test";
import { appendDecision, decisionLogPath, type DecisionEntry } from "../src/decisionlog";

test("decisionLogPath: <dir>/decisions-<pid>.jsonl", () => {
  expect(decisionLogPath(4242, "D:/tmp/x")).toBe(path.join("D:/tmp/x", "decisions-4242.jsonl"));
});

test("decisionLogPath: default dir is <tempdir>/opencode-goal", () => {
  expect(decisionLogPath(7)).toBe(path.join(os.tmpdir(), "opencode-goal", "decisions-7.jsonl"));
});

test("appendDecision appends one JSON line per call, readable back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-goal-test-"));
  try {
    const entry: DecisionEntry = {
      ts: "2026-10-17T00:00:00.000Z",
      sessionID: "s1",
      goalID: "g1",
      own: 1,
      other: 0,
      ownKnown: true,
      decision: "hold",
      reason: "in-flight",
    };
    await appendDecision(entry, { pid: 4242, dir });
    const raw = fs.readFileSync(path.join(dir, "decisions-4242.jsonl"), "utf8").trim();
    expect(JSON.parse(raw)).toEqual(entry);
    await appendDecision({ ...entry, ts: "t2", decision: "wake" }, { pid: 4242, dir });
    const lines = fs
      .readFileSync(path.join(dir, "decisions-4242.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ ts: "t2", decision: "wake" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendDecision swallows failures (a broken dir never throws)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-goal-test-"));
  try {
    const dir = path.join(base, "blocked");
    fs.writeFileSync(dir, "i am a file, not a directory");
    await expect(
      appendDecision({ ts: "t", sessionID: "s1", ownKnown: false, decision: "skip", reason: "x" }, { pid: 9, dir }),
    ).resolves.toBeUndefined();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
