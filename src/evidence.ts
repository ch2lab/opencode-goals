// Evidence and clear-request gates. Pure functions, no imports.

export interface TranscriptMessage {
  type?: string;
  text?: string;
  content?: Array<{ text?: string }>;
}

export const MIN_EVIDENCE_LENGTH = 24;
export const MIN_CLEAR_REQUEST_LENGTH = 12;

const EVIDENCE_PREFIX = "Goal NOT completed: ";
const CLEAR_PREFIX = "Goal NOT cleared: ";

/**
 * Stopwords dropped during tokenization. Must include at least the common
 * function words that would otherwise pollute the overlap check; short
 * entries are harmless (the length filter already drops them).
 */
const STOPWORDS = new Set([
  "the", "and", "but", "not", "you", "are", "was", "were", "has", "had",
  "they", "this", "that", "there", "their", "them", "then", "from", "with",
  "have", "been", "about", "should", "would", "could", "after", "before",
  "during", "through", "which", "whose", "where", "because", "between",
  "however", "therefore",
]);

/** Words whose presence makes an evidence claim checkable. */
const ANCHOR_KEYWORDS = [
  "test", "tests", "passed", "passing", "verify", "verified", "verification",
  "commit", "commits", "log", "logs", "output", "result", "results",
  "complete", "completed", "done", "success", "successful", "fixed", "built",
];
const ANCHOR_KEYWORD_RE = new RegExp(`\\b(${ANCHOR_KEYWORDS.join("|")})\\b`);
const EXTENSION_RE = /\.\w{2,}/;
// CJK anchor keywords (Task 14 Fix 2): any occurrence makes the evidence
// checkable at the anchor layer (OR-ed with the 4 latin criteria below).
const CJK_ANCHOR_RE =
  /测试|通过|完成|验证|修复|构建|日志|输出|结果|成功|提交|部署|跑通|编译|安装/;
// Exported so the controller's `/goal clear` command path can pre-select a
// candidate user message from the transcript (the gate itself still runs in
// validateClearRequest — this regex is only a candidate filter).
// Task 14 Fix 2: CJK clear keywords added (the project UI copy is Chinese, so
// clear requests are naturally stated in Chinese).
export const CLEAR_KEYWORD_RE =
  /\b(clear|remove|delete|reset|abort|discard|stop|cancel)\b|清除|清掉|删掉|删除|取消|放弃|停止|停掉|结束|丢弃|作废/;

/** CJK ideograph runs (Task 14 Fix 2): the three main ideograph blocks. */
const CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;

/**
 * Fixed tokenizer: lowercase, split on `[^a-z0-9_./-]+` (so `/` and `.`
 * stay inside tokens and path fragments survive intact), keep tokens with
 * >= 6 characters, drop stopwords.
 *
 * Task 14 Fix 2 (CJK): OUTSIDE the latin result, CJK ideograph runs (>=2
 * chars) yield ALL sliding-window bigrams — "测试通过" →
 * ["测试","试通","通过"]. A length-1 run yields nothing (single chars have
 * too large a false-match surface — controller ruling). The latin path is
 * byte-identical to before: the same lowered string, same split/filter.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const lowered = text.toLowerCase();
  for (const raw of lowered.split(/[^a-z0-9_./-]+/)) {
    if (raw.length < 6) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  for (const run of lowered.match(CJK_RUN_RE) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

function messageText(m: TranscriptMessage): string {
  const parts: string[] = [];
  if (m.text) parts.push(m.text);
  for (const c of m.content ?? []) if (c.text) parts.push(c.text);
  return parts.join(" ");
}

function tokenSet(messages: TranscriptMessage[], includeAssistant: boolean): Set<string> {
  const set = new Set<string>();
  for (const m of messages) {
    if (!includeAssistant && m.type === "assistant") continue;
    for (const t of tokenize(messageText(m))) set.add(t);
  }
  return set;
}

function hasOverlap(tokens: string[], set: Set<string>): boolean {
  return tokens.some((t) => set.has(t));
}

/**
 * Structural evidence gate. Three layers, fail-closed:
 * 1. length >= MIN_EVIDENCE_LENGTH
 * 2. at least one checkable anchor: `/`, a digit, a `.\w{2,}` extension,
 *    a latin anchor keyword, or a CJK anchor keyword (Task 14 Fix 2)
 * 3. when a non-empty transcript is given, at least one evidence token
 *    must occur in the transcript (stopwords removed on both sides)
 */
export function validateEvidence(
  evidence: string,
  transcript?: TranscriptMessage[],
): string | undefined {
  if (evidence.length < MIN_EVIDENCE_LENGTH) {
    return `${EVIDENCE_PREFIX}evidence is too weak`;
  }
  const lowered = evidence.toLowerCase();
  const anchored =
    lowered.includes("/") ||
    /\d/.test(lowered) ||
    EXTENSION_RE.test(lowered) ||
    ANCHOR_KEYWORD_RE.test(lowered) ||
    CJK_ANCHOR_RE.test(lowered);
  if (!anchored) {
    return `${EVIDENCE_PREFIX}evidence has no checkable anchor`;
  }
  if (transcript && transcript.length > 0) {
    if (!hasOverlap(tokenize(evidence), tokenSet(transcript, true))) {
      return `${EVIDENCE_PREFIX}evidence is not grounded in the transcript`;
    }
  }
  return undefined;
}

/**
 * Clear-request gate. Four layers, fail-closed:
 * 1. length >= MIN_CLEAR_REQUEST_LENGTH
 * 2. contains a clear-family keyword
 * 3. a non-empty transcript is present (no transcript -> rejected)
 * 4. at least one request token occurs in a non-assistant message
 *    (assistant text is never the user's own words)
 */
export function validateClearRequest(
  request: string,
  transcript?: TranscriptMessage[],
): string | undefined {
  if (request.length < MIN_CLEAR_REQUEST_LENGTH) {
    return `${CLEAR_PREFIX}request is too weak`;
  }
  if (!CLEAR_KEYWORD_RE.test(request.toLowerCase())) {
    return `${CLEAR_PREFIX}request does not ask to clear`;
  }
  if (!transcript || transcript.length === 0) {
    return `${CLEAR_PREFIX}request is not grounded in the transcript (no transcript)`;
  }
  if (!hasOverlap(tokenize(request), tokenSet(transcript, false))) {
    return `${CLEAR_PREFIX}request is not grounded in user messages`;
  }
  return undefined;
}
