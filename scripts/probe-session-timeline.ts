// One-off §60 post-mortem: dump the kept r4 host's session timeline
// (user items with time.created, assistant tool calls, goal_wait windows).
import { Database } from "bun:sqlite";

const dir = process.argv[2];
const db = new Database(`${dir}\\data\\opencode\\opencode.db`, { readonly: true });
const rows = db.query("SELECT session_id, data FROM session_message").all() as Array<{ session_id: string; data: string }>;
const bySes = new Map<string, any[]>();
for (const r of rows) {
  try {
    const data = JSON.parse(r.data) as Record<string, unknown>;
    bySes.set(r.session_id, [...(bySes.get(r.session_id) ?? []), data]);
  } catch {
    // keep scanning
  }
}
  } catch {
    // keep scanning
  }
}
for (const [ses, msgs] of bySes) {
  if (!msgs.length) continue;
  console.log(`\n=== session ${ses} ===`);
  const sorted = [...msgs].sort((a, b) => Number(a?.time?.created ?? 0) - Number(b?.time?.created ?? 0));
  for (const m of sorted) {
    const t = m?.time?.created ? new Date(Number(m.time.created)).toISOString().slice(11, 23) : "?";
    const type = String(m?.type ?? "?");
    const content = (Array.isArray(m?.content) ? m.content : []) as Array<Record<string, unknown>>;
    const parts = content
      .map((p) => {
        const pt = String(p?.type ?? "");
        if (pt === "text") return `text="${String(p?.text ?? "").slice(0, 70).replace(/\n/g, " ")}"`;
        if (pt === "tool") return `tool=${String(p?.name ?? p?.tool ?? "?")}${p?.state?.status ? ` [${p.state.status}]` : ""}`;
        return pt;
      })
      .filter(Boolean)
      .join(" | ");
    const text = typeof m?.text === "string" ? `text="${m.text.slice(0, 70).replace(/\n/g, " ")}"` : "";
    console.log(`${t}  ${type}  ${text} ${parts}`);
  }
}
