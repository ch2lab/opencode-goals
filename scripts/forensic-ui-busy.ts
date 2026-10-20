// One-shot forensic (v4): extract working() definitions + send/stop button
// wiring in the session-view logic chunks.
import { readFileSync } from "node:fs";

const dir = "C:\\Users\\Adminstrator\\AppData\\Local\\Temp\\asar-ui\\out\\renderer\\assets";
const files = ["incompatible-server-panel-E6eAqdis.js", "route-BYzALZ62.js", "main-CZyBNj5O.js"];
const toks = [
  "working(){",
  "working(){",
  `data-action`,
  `===`+ "`busy`",
  `type:`, 
  "stop",
];
for (const f of files) {
  const s = readFileSync(`${dir}\\${f}`, "utf8");
  console.log(`\n===== ${f} (${(s.length / 1024).toFixed(0)} KB) =====`);
  for (const t of ["working(){", `active-session`, `data-action:`+ "`se", `get busy`, `busy(){`, `queue.busy`]) {
    let i = s.indexOf(t);
    let n = 0;
    while (i !== -1 && n < 6) {
      console.log(`\n[${t}]`);
      console.log(s.slice(i - 300, i + 300).replace(/\n/g, " "));
      i = s.indexOf(t, i + t.length);
      n++;
    }
  }
}
