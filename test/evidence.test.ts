import { expect, test } from "bun:test";
import {
  MIN_CLEAR_REQUEST_LENGTH,
  MIN_EVIDENCE_LENGTH,
  validateClearRequest,
  validateEvidence,
  type TranscriptMessage,
} from "../src/evidence.ts";

test("fixed constants", () => {
  expect(MIN_EVIDENCE_LENGTH).toBe(24);
  expect(MIN_CLEAR_REQUEST_LENGTH).toBe(12);
});

// --- validateEvidence: length gate ---

test("evidence under 24 chars is rejected as too weak", () => {
  expect(validateEvidence("")).toStartWith("Goal NOT completed: evidence is too weak");
  expect(validateEvidence("all done now")).toStartWith(
    "Goal NOT completed: evidence is too weak",
  );
});

test("boundary: 23 chars rejected, 24 chars passes length check", () => {
  expect(validateEvidence("a".repeat(23))).toStartWith(
    "Goal NOT completed: evidence is too weak",
  );
  // 24 chars but no anchor -> passes length, fails anchor
  expect(validateEvidence("a".repeat(24))).toContain("no checkable anchor");
});

// --- validateEvidence: anchor gate ---

test("long evidence without any anchor is rejected", () => {
  const msg = validateEvidence("the morning meeting went well overall");
  expect(msg).toStartWith("Goal NOT completed: ");
  expect(msg).toContain("no checkable anchor");
});

test("path, digit, or the word 'test' each satisfy the anchor check", () => {
  expect(validateEvidence("see /path/to/file for details")).toBeUndefined();
  expect(validateEvidence("finished in 42 seconds total")).toBeUndefined();
  expect(validateEvidence("the test suite ran this morning")).toBeUndefined();
});

// --- validateEvidence: grounding gate ---

test("fabricated evidence (length + anchor ok, zero transcript overlap) is rejected", () => {
  const fabricated = "bun test passed with exit code 0 see log output";
  const transcript: TranscriptMessage[] = [{ type: "user", text: "please finish this" }];
  const msg = validateEvidence(fabricated, transcript);
  expect(msg).toStartWith("Goal NOT completed: ");
  expect(msg).toContain("not grounded");
});

test("evidence with a token present in the transcript is accepted", () => {
  const evidence = "bun test passed with exit code 0";
  const transcript: TranscriptMessage[] = [
    { type: "user", text: "the last run passed cleanly" },
  ];
  expect(validateEvidence(evidence, transcript)).toBeUndefined();
});

test("empty transcript array skips the grounding check", () => {
  expect(validateEvidence("the test suite ran this morning", [])).toBeUndefined();
  expect(validateEvidence("see /path/to/file for details", [])).toBeUndefined();
});

test("stopwords are removed before the overlap check", () => {
  // only shared word between evidence and transcript is "should",
  // which must be dropped as a stopword -> no real overlap -> rejected
  const evidence = "this should happen today 2";
  const transcript: TranscriptMessage[] = [{ type: "user", text: "should we start now?" }];
  const msg = validateEvidence(evidence, transcript);
  expect(msg).toStartWith("Goal NOT completed: ");
  expect(msg).toContain("not grounded");
});

test("path-like tokens survive tokenization and can ground evidence", () => {
  const evidence = "see /tmp/build-log for output";
  const transcript: TranscriptMessage[] = [
    { type: "user", text: "check /tmp/build-log later" },
  ];
  expect(validateEvidence(evidence, transcript)).toBeUndefined();
});

// --- validateClearRequest ---

test("empty request is rejected", () => {
  expect(validateClearRequest("")).toStartWith("Goal NOT cleared: ");
});

test("request under 12 chars is rejected", () => {
  expect(validateClearRequest("clear this!")).toStartWith("Goal NOT cleared: ");
  expect(validateClearRequest("stop it")).toStartWith("Goal NOT cleared: ");
});

test("12 chars passes the length gate (fails later on grounding)", () => {
  expect(validateClearRequest("please clear")).toContain("not grounded");
});

test("request without a clear-family keyword is rejected", () => {
  const msg = validateClearRequest("please update the docs file");
  expect(msg).toStartWith("Goal NOT cleared: ");
  expect(msg).not.toContain("not grounded");
});

test("tokens present only in assistant messages do not ground (assistant text does not count)", () => {
  const request = "please clear this goal now";
  const transcript: TranscriptMessage[] = [
    { type: "assistant", text: "please finish the task" },
  ];
  expect(validateClearRequest(request, transcript)).toStartWith("Goal NOT cleared: ");
});

test("no transcript at all is fail-closed rejected", () => {
  expect(validateClearRequest("please clear this goal now")).toContain("not grounded");
  expect(
    validateClearRequest("please clear this goal now", []),
  ).toStartWith("Goal NOT cleared: ");
});

test("a non-assistant message containing the cited tokens is accepted", () => {
  const request = "stop the background session";
  const transcript: TranscriptMessage[] = [
    { type: "user", text: "the background shell is waiting" },
    { type: "assistant", text: "i will stop it now" },
  ];
  expect(validateClearRequest(request, transcript)).toBeUndefined();
});

// --- CJK support (Task 14 Fix 2): latin path stays byte-identical; CJK bigrams
// are APPENDED to the latin tokens, CJK anchor/clear keywords join the gates ---

test("CJK evidence: shared CJK bigram with the transcript grounds the claim", () => {
  // 27 chars (>=24), CJK anchors 测试/通过/完成/日志/结果 all present in the
  // anchor list; the transcript shares the bigram 测试 (and 试全/全部).
  const evidence = "测试全部通过，构建成功，编译安装完成，日志输出结果正常";
  const transcript: TranscriptMessage[] = [
    { type: "user", text: "我把测试全部跑完了" },
  ];
  expect(validateEvidence(evidence, transcript)).toBeUndefined();
});

test("CJK evidence with zero transcript overlap is rejected as not grounded", () => {
  // Anchored (输出/日志) but its CJK bigrams share nothing with the transcript.
  const evidence = "界面渲染正常，渲染体验很好，输出日志没有发现任何问题";
  const transcript: TranscriptMessage[] = [
    { type: "user", text: "今天天气不错，我们去逛街吧" },
  ];
  const msg = validateEvidence(evidence, transcript);
  expect(msg).toStartWith("Goal NOT completed: ");
  expect(msg).toContain("not grounded");
});

test("CJK evidence without any anchor keyword is rejected at the anchor layer", () => {
  // 29 chars, no CJK anchor keyword (测试/通过/完成/… all absent), no
  // latin path / digit / extension either.
  const msg = validateEvidence("我感觉应该没有问题了吧，大概都差不多了，差不多就这个情况了");
  expect(msg).toStartWith("Goal NOT completed: ");
  expect(msg).toContain("no checkable anchor");
});

test("CJK clear request: keyword + shared bigram with a user message pass; no transcript is still rejected", () => {
  // 16 chars (>=12), clear keyword 清除; the user message shares bigrams
  // (这个/个目/目标/标清/清除/除掉/掉吧). The brief's example phrase
  // "请把这个目标清除掉吧" is 10 chars and would trip the 12-char length
  // gate itself — extended here to satisfy the brief's own (>=12) constraint.
  const request = "请把这个目标清除掉吧，今天不用继续了";
  const transcript: TranscriptMessage[] = [
    { type: "user", text: "这个目标清除掉吧，先停掉手上的活" },
  ];
  expect(validateClearRequest(request, transcript)).toBeUndefined();
  // fail-closed without a transcript (original behavior)
  expect(validateClearRequest(request)).toContain("not grounded");
});

test("mixed latin + CJK evidence passes on the union of both token streams", () => {
  // "tests" (5 chars) and "2026" (<6) are dropped by the latin length filter;
  // "logs/2026" survives, the CJK bigrams 全部/通过/成功 carry the overlap.
  const evidence = "tests 全部通过，见 logs/2026 构建成功";
  const transcript: TranscriptMessage[] = [
    { type: "user", text: "全部通过之后把构建成功的日志贴出来" },
  ];
  expect(validateEvidence(evidence, transcript)).toBeUndefined();
});
