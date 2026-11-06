// Swing tempo smoke test.
// Part 1 (always): the tempo math on simulated swings, no server needed:
//   node swing_smoke.mjs --math
// Part 2: the API. Start the server first (local database, after npm run migrate):
//   DATABASE_URL=... OTG_STAFF_KEY=k PORT=3999 node dist/server.js
// then: DATABASE_URL=... OTG_STAFF_KEY=k node swing_smoke.mjs
import * as T from "./public/swing-tempo.mjs";

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };

// ---- simulated swings -----------------------------------------------------------
// Hands start still at address, rise to the top over `back` ms (smooth start and stop), then
// accelerate down to impact over `down` ms, then rise into the finish. Tracking jitter added.
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
function simulate({ back = 900, down = 300, fps = 120, jitter = 0.002, addressMs = 900, waggle = false, scale = 0.25, t0 = 10_000 }) {
  const out = [], dt = 1000 / fps;
  const addr = { x: 0.5, y: 0.72 }, topP = { x: 0.62, y: 0.28 }, finish = { x: 0.38, y: 0.22 };
  const takeawayT = t0 + addressMs, topT = takeawayT + back, impactT = topT + down, end = impactT + 450;
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * u);           // smooth start and stop
  const accel = (u) => u * u * (1.6 - 0.6 * u);                    // speeds up into impact
  for (let t = t0; t <= end; t += dt) {
    let p;
    if (t < takeawayT) {
      p = { ...addr };
      // A waggle well before takeaway, then settle: the detector should still find the real takeaway.
      if (waggle && t < takeawayT - 450 && t > t0 + 100) p.x += 0.04 * Math.sin(((t - t0) / 250) * Math.PI);
    } else if (t < topT) {
      const u = ease((t - takeawayT) / back);
      p = { x: addr.x + (topP.x - addr.x) * u, y: addr.y + (topP.y - addr.y) * u };
    } else if (t < impactT) {
      const u = accel((t - topT) / down);
      p = { x: topP.x + (addr.x - topP.x) * u, y: topP.y + (addr.y - topP.y) * u };
    } else {
      const u = Math.min(1, (t - impactT) / 400), e = Math.sin((u * Math.PI) / 2);
      p = { x: addr.x + (finish.x - addr.x) * e, y: addr.y + (finish.y - addr.y) * e };
    }
    out.push({ t, x: p.x + gauss() * jitter, y: p.y + gauss() * jitter, scale });
  }
  return { samples: out, takeawayT, topT, impactT, ratio: back / down };
}

const cases = [
  { back: 900, down: 300 }, { back: 750, down: 250 }, { back: 1050, down: 350 },
  { back: 800, down: 400 }, { back: 1000, down: 250 }, { back: 700, down: 300, fps: 60 },
  { back: 900, down: 300, fps: 240 }, { back: 900, down: 300, fps: 60, jitter: 0.004 },
  { back: 900, down: 300, waggle: true }, { back: 900, down: 300, scale: 0.12, jitter: 0.001 },
];
for (const c of cases) {
  const sim = simulate(c);
  const r = T.analyzeSwing(sim.samples, { soundImpactT: sim.impactT });
  const label = `${c.back}/${c.down} ms @${c.fps ?? 120}fps${c.waggle ? " with waggle" : ""}${c.jitter ? ` jitter ${c.jitter}` : ""}${c.scale ? ` far away` : ""}`;
  check(`tempo ${label}: ratio within 0.3 of ${sim.ratio.toFixed(2)}`, r.ok && Math.abs(r.ratio - sim.ratio) <= 0.3, JSON.stringify(r.ok ? { ratio: r.ratio, back: r.backswingMs, down: r.downswingMs, conf: r.confidence } : r));
}
{
  // Over many swings the readings should center on the truth, not lean one way.
  const errs = [];
  for (let k = 0; k < 30; k++) { const sim = simulate({ back: 800 + k * 10, down: 280 + (k % 5) * 10 }); const r = T.analyzeSwing(sim.samples, { soundImpactT: sim.impactT }); if (r.ok) errs.push(r.ratio - sim.ratio); }
  const bias = errs.reduce((n, v) => n + v, 0) / errs.length;
  check("30 swings: all read, average error under 0.1", errs.length === 30 && Math.abs(bias) < 0.1, `bias ${bias.toFixed(3)}`);
}
{
  const sim = simulate({ back: 900, down: 300 });
  const r = T.analyzeSwing(sim.samples);
  check("no sound: impact found from the hands, ratio still close", r.ok && r.impactSource === "motion" && Math.abs(r.ratio - 3) <= 0.35, JSON.stringify(r));
  check("no sound: impact within 40 ms of the real one", r.ok && Math.abs(r.impactT - sim.impactT) <= 40, r.ok ? `${Math.round(r.impactT - sim.impactT)} ms` : "");
  const off = T.analyzeSwing(sim.samples, { soundImpactT: sim.impactT + 600 });
  check("a sound that doesn't match the hands (another bay) is ignored", !off.ok && /line up/.test(off.reason), JSON.stringify(off));
  const lowFps = T.analyzeSwing(simulate({ back: 900, down: 300, fps: 30 }).samples);
  check("30 fps is marked low confidence (or rejected)", !lowFps.ok || lowFps.confidence === "low", JSON.stringify(lowFps));
}
{
  const still = Array.from({ length: 200 }, (_, i) => ({ t: i * 8, x: 0.5 + gauss() * 0.002, y: 0.7 + gauss() * 0.002, scale: 0.25 }));
  check("a player standing still is not a swing", !T.analyzeSwing(still).ok);
  check("nobody in view is not a swing", !T.analyzeSwing([]).ok);
  const half = simulate({ back: 300, down: 150 });
  check("a tiny chip-like motion is rejected as a full swing", !T.analyzeSwing(half.samples, { soundImpactT: half.impactT }).ok);
}
check("3.0 rates good, 2.6 close, 2.2 off", T.rateRatio(3) === "good" && T.rateRatio(2.6) === "close" && T.rateRatio(2.2) === "off");
const sum = T.summarize([2.9, 3.0, 3.1, 3.0]);
check("summary: mean 3.0, steady", sum.mean === 3 && sum.consistency === "steady", JSON.stringify(sum));
check("summary: spread out swings are 'all over'", T.summarize([2.2, 3.8, 2.5, 3.6]).consistency === "all over");
check("beat for a 0.9 s backswing: 0, 900, 1200 ms", JSON.stringify(T.beatTimes(900)) === "[0,900,1200]");
{
  const d = T.createImpactDetector();
  let hits = [];
  for (let t = 0; t < 1000; t += 3) { const h = d.push(0.01 + rand() * 0.005, t); if (h !== null) hits.push(h); }
  check("room noise alone never triggers", hits.length === 0);
  hits = [];
  for (const [rms, t] of [[0.5, 1003], [0.4, 1006], [0.45, 1060], [0.01, 1100], [0.6, 2700]]) { const h = d.push(rms, t); if (h !== null) hits.push(h); }
  check("a loud hit triggers once; the ball hitting the screen 57 ms later doesn't; the next shot does", JSON.stringify(hits) === "[1003,2700]", JSON.stringify(hits));
}

if (process.argv.includes("--math")) { console.log(fails ? `\n${fails} FAILED` : "\nall passed"); process.exit(fails ? 1 : 0); }

// ---- API ----------------------------------------------------------------------------
const base = "http://localhost:3999";
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) { console.error("swing_smoke.mjs runs against a local database only"); process.exit(2); }
const pg = (await import("pg")).default;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const key = process.env.OTG_STAFF_KEY ?? "k";
const api = async (method, path, body, k = key) => {
  const r = await fetch(base + path, { method, headers: { "X-OTG-Key": k, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

const page = await fetch(base + "/swing");
check("GET /swing serves the bay screen", page.status === 200 && /Tempo/.test(await page.text()));
const js = await fetch(base + "/swing/tempo.mjs");
check("GET /swing/tempo.mjs serves the math as JavaScript", js.status === 200 && /javascript/.test(js.headers.get("content-type") ?? ""));
check("API needs the staff key", (await api("POST", "/api/swing/sessions", {}, "wrong")).status === 401);

const run = Date.now().toString(36);
const player = (await pool.query("insert into players (name, phone) values ($1, $2) returning id", [`Swing Test ${run}`, `+1555${String(Date.now()).slice(-7)}`])).rows[0];
const start = new Date(Date.now() - 10 * 60_000), end = new Date(Date.now() + 50 * 60_000);
const booking = (await pool.query(
  "insert into bookings (bay_id, player_id, starts_at, ends_at, status, source) values ('bay1',$1,$2,$3,'confirmed','staff') returning id",
  [player.id, start, end])).rows[0];

const today = await api("GET", "/api/swing/premier-today");
check("today's Premier bay bookings include the test booking", today.status === 200 && today.body.bookings.some((b) => b.id === booking.id), JSON.stringify(today.body).slice(0, 200));

const bad = await api("POST", "/api/swing/sessions", { booking_id: "00000000-0000-0000-0000-000000000000" });
check("a session for a booking that doesn't exist is refused", bad.status === 400);
const s = await api("POST", "/api/swing/sessions", { booking_id: booking.id, camera: "Test cam", fps: 120 });
check("start a session linked to the booking", s.status === 200 && s.body.id && s.body.player_id === player.id, JSON.stringify(s.body));
const sid = s.body.id;

const saved = [];
for (const [b, d] of [[900, 300], [870, 300], [930, 310]]) {
  const r = await api("POST", `/api/swing/sessions/${sid}/swings`, { backswing_ms: b, downswing_ms: d, impact_source: "sound", confidence: "high" });
  saved.push(r);
}
check("three swings saved", saved.every((r) => r.status === 200 && r.body.swing?.id), JSON.stringify(saved.map((r) => r.status)));
check("ratio is worked out on the server", Math.abs(saved[1].body.swing.ratio - 2.9) < 0.01, JSON.stringify(saved[1].body.swing));
check("each save returns the session summary", saved[2].body.summary.count === 3 && Math.abs(saved[2].body.summary.mean - 2.97) < 0.02, JSON.stringify(saved[2].body.summary));
const nonsense = await api("POST", `/api/swing/sessions/${sid}/swings`, { backswing_ms: 50, downswing_ms: 300 });
check("an impossible swing is refused", nonsense.status === 400);

const del = await api("DELETE", `/api/swing/swings/${saved[0].body.swing.id}`);
check("staff can throw out a bad read", del.status === 200);
const got = await api("GET", `/api/swing/sessions/${sid}`);
check("session shows 2 swings after the delete", got.status === 200 && got.body.swings.length === 2 && got.body.summary.count === 2, JSON.stringify(got.body.summary));
check("session shows who was hitting", got.body.session.player_name === `Swing Test ${run}`);

const ended = await api("POST", `/api/swing/sessions/${sid}/end`);
check("end the session", ended.status === 200);
const late = await api("POST", `/api/swing/sessions/${sid}/swings`, { backswing_ms: 900, downswing_ms: 300 });
check("an ended session takes no more swings", late.status === 400);
const recent = await api("GET", "/api/swing/sessions");
check("recent sessions list includes it", recent.status === 200 && recent.body.sessions.some((x) => x.id === sid && x.swings === 2), JSON.stringify(recent.body.sessions?.[0] ?? null));

const walkup = await api("POST", "/api/swing/sessions", { label: "Walk-in" });
check("a session with no booking works too", walkup.status === 200 && walkup.body.player_id === null);

await pool.query("delete from swing_sessions where id = any($1)", [[sid, walkup.body.id]]);
await pool.query("delete from bookings where id = $1", [booking.id]);
await pool.query("delete from players where id = $1", [player.id]);
await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
