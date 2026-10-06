// Daily scan of otg-ops logs on Render for the last 24 hours. Flags server errors (5xx responses)
// and app log lines that report an error. The app's console.error lines arrive labelled "info"
// on Render, so lines are matched on their text as well as their level. Ignores noise: 404s from bots, bad-signature 400s, warnings,
// and npm's "N vulnerabilities" build notice.
import { alert } from "./alert.mjs";

const KEY = process.env.RENDER_API_KEY?.trim();
const SERVICE = process.env.RENDER_SERVICE_ID?.trim() || "srv-dagqk8vqj5pc73fcf1t0";
const OWNER = process.env.RENDER_OWNER_ID?.trim() || "tea-dagpt7uq1p3s73c2adsg";
const HOURS = Number(process.env.HOURS || 24);

if (!KEY) {
  console.log("FAIL  RENDER_API_KEY secret is not set");
  await alert("daily log check can't run: RENDER_API_KEY missing", "Add the RENDER_API_KEY secret in GitHub.");
  process.exit(1);
}

const end = new Date(), start = new Date(end.getTime() - HOURS * 3600_000);
const label = (l, n) => l.labels.find((x) => x.name === n)?.value;
const IGNORE = [/\d+ vulnerabilit/i];

async function fetchLogs(extra) {
  const out = [];
  let startTime = start.toISOString(), endTime = end.toISOString();
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ ownerId: OWNER, startTime, endTime, direction: "backward", limit: "100" });
    qs.append("resource", SERVICE);
    for (const [k, vs] of Object.entries(extra)) for (const v of vs) qs.append(k, v);
    const r = await fetch(`${process.env.RENDER_API_URL || "https://api.render.com/v1"}/logs?${qs}`, { headers: { Authorization: `Bearer ${KEY}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Render API http ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    out.push(...(j.logs ?? []));
    if (!j.hasMore) break;
    startTime = j.nextStartTime; endTime = j.nextEndTime;
  }
  return out;
}

let problems;
try {
  const [server, byLevel, byText] = await Promise.all([
    fetchLogs({ type: ["request"], statusCode: ["5*"] }),
    fetchLogs({ type: ["app"], level: ["error", "critical", "alert", "emergency"] }),
    fetchLogs({ type: ["app"], text: ["*failed*", "*Failed*", "*error*", "*Error*", "*ERROR*", "*nhandled*", "*FATAL*"] }),
  ]);
  const app = [...new Map([...byLevel, ...byText].map((l) => [l.id ?? `${l.timestamp} ${l.message}`, l])).values()];
  problems = [
    ...server.map((l) => ({ t: l.timestamp, line: `${label(l, "statusCode")} ${label(l, "method")} ${label(l, "path")}` })),
    ...app.filter((l) => !IGNORE.some((re) => re.test(l.message))).map((l) => ({ t: l.timestamp, line: l.message.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 300) })),
  ].sort((a, b) => a.t.localeCompare(b.t));
} catch (e) {
  console.log(`FAIL  could not read Render logs: ${e.message}`);
  await alert("daily log check couldn't read Render logs", e.message);
  process.exit(1);
}

console.log(`otg-ops, ${start.toISOString()} to ${end.toISOString()}: ${problems.length} error(s)`);
for (const p of problems) console.log(`${p.t}  ${p.line}`);
if (problems.length) {
  const top = problems.slice(0, 3).map((p) => p.line.slice(0, 80)).join("; ");
  await alert(`${problems.length} otg-ops error(s) in the last ${HOURS}h: ${top}`, problems.map((p) => `${p.t}  ${p.line}`).join("\n"));
  process.exit(1);
}
console.log("No errors.");
