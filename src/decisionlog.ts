// Boundary decision log (2026-10-17): one JSON line per gate decision
// (wake / hold / skip), append-only, best-effort — a broken log never
// breaks the loop.
//
// Path: <dir | <tempdir>/opencode-goal>/decisions-<pid>.jsonl
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DecisionEntry {
  ts: string;
  sessionID: string;
  goalID?: string;
  own?: number;
  other?: number;
  /** Queued undelivered inbox items at the boundary (2026-10-20 queued-input ruling). */
  queued?: number;
  ownKnown: boolean;
  decision: "wake" | "hold" | "skip";
  reason: string;
}

/** <dir | <tempdir>/opencode-goal>/decisions-<pid>.jsonl */
export function decisionLogPath(pid: number, dir?: string): string {
  const base = dir ?? path.join(os.tmpdir(), "opencode-goal");
  return path.join(base, `decisions-${pid}.jsonl`);
}

/**
 * Append one decision line. All failures are swallowed: the log is an
 * observability aid, never a dependency of the loop.
 */
export async function appendDecision(
  entry: DecisionEntry,
  opts?: { pid?: number; dir?: string },
): Promise<void> {
  try {
    const file = decisionLogPath(opts?.pid ?? process.pid, opts?.dir);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // best-effort: the decision log must never break the loop
  }
}
