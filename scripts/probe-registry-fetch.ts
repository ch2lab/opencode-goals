import { startHost, readLogFile } from "./host.ts";
const host = await startHost({
  keepDir: true,
  config: { plugins: [{ package: "@ch2lab/opencode-goals", options: {} }] },
});
let ours: any = undefined;
for (let i = 0; i < 30; i++) {
  ours = (await host.api.plugins()).find((p: any) => p.id === "opencode-goal");
  if (ours) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("plugin:", ours ? `state=${ours.state.status} source=${JSON.stringify(ours.source)}` : "MISSING after 60s");
console.log("=== host log tail ===");
console.log(await readLogFile(host, 40));
console.log("host dir kept at:", host.directory);
await host.stop();
