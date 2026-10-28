// Opening-day smoke test: wording and founding billing start with and without OPENING_DAY.
// Needs DATABASE_URL with migrations applied; no server.
import pg from "pg";
import { alignFoundingTrials, foundingTrialEnd } from "./dist/stripeHandlers.js";
import { memberWelcome, purchaseConfirmation, memberNumberNotice } from "./dist/templates.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };
const q = async (sql, a = []) => (await pool.query(sql, a)).rows;
const run = Date.now().toString(36);
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

const calls = [];
const fake = { subscriptions: { update: async (id, p) => { calls.push({ id, ...p }); return {}; } } };
const sub = async (name, trialEndSecs, status = "trialing", tier = "founding") => {
  const [p] = await q("insert into players (name) values ($1) returning id", [name]);
  const id = `sub_${name.replace(/\W/g, "")}_${run}`;
  await q("insert into memberships (player_id, stripe_subscription_id, tier, status, trial_end) values ($1,$2,$3,$4,to_timestamp($5))", [p.id, id, tier, status, trialEndSecs]);
  return id;
};
const trialOf = async (id) => Math.round(new Date((await q("select trial_end from memberships where stripe_subscription_id = $1", [id]))[0].trial_end).getTime() / 1000);

// Leave earlier runs' trialing founders out of the counts.
await q("update memberships set status = 'canceled' where tier = 'founding' and status = 'trialing'");

// --- no date set ---
delete process.env.OPENING_DAY;
const w = memberWelcome("founding", false, 7);
check("no date: welcome says opening soon", w.text.includes("opening soon") && !/November|undefined|null|Invalid/.test(w.text + w.sms));
check("no date: billing waits for a date", w.text.includes("tell you the date before anything is charged"));
check("no date: other emails say opening soon", purchaseConfirmation("winter_league_s1", 10000).text.includes("opening soon") && memberNumberNotice("founding", 7).text.includes("opening soon"));
const placeholder = foundingTrialEnd(now);
check("no date: new founders get a far-off trial", placeholder >= now + 690 * DAY && placeholder <= now + 729 * DAY);

const soon = await sub("Soon Founder", now + 12 * DAY);           // e.g. the old Nov 9 date
const later = await sub("Later Founder", now + 500 * DAY);         // already pushed out
const full = await sub("Full Member", now + 12 * DAY, "trialing", "full");
await alignFoundingTrials(fake);
check("no date: founder billing soon is pushed out", calls.some((c) => c.id === soon && c.trial_end >= now + 690 * DAY && c.proration_behavior === "none"));
check("no date: already-pushed founder left alone", !calls.some((c) => c.id === later));
check("no date: non-founding untouched", !calls.some((c) => c.id === full));
check("no date: db trial_end updated", (await trialOf(soon)) >= now + 690 * DAY);
calls.length = 0;
await alignFoundingTrials(fake);
check("no date: second run does nothing", calls.length === 0);

// --- date set ---
const opening = now + 40 * DAY;
process.env.OPENING_DAY = new Date(opening * 1000).toISOString();
const w2 = memberWelcome("founding", false, 7);
check("date set: welcome names the date", w2.text.includes("We open ") && w2.text.includes("Billing starts on opening day, ") && !w2.text.includes("opening soon"));
check("date set: new founders billed on opening day", foundingTrialEnd(now) === opening);
await alignFoundingTrials(fake);
check("date set: every founder moved to opening day", [soon, later].every((id) => calls.some((c) => c.id === id && c.trial_end === opening)) && !calls.some((c) => c.id === full));
calls.length = 0;
await alignFoundingTrials(fake);
check("date set: second run does nothing", calls.length === 0);

// --- date passed ---
process.env.OPENING_DAY = new Date((now - DAY) * 1000).toISOString();
check("date passed: bill now", foundingTrialEnd(now) === null && (await alignFoundingTrials(fake)) === 0);

// --- junk value is treated as no date ---
process.env.OPENING_DAY = "soon";
check("junk OPENING_DAY means no date", foundingTrialEnd(now) >= now + 690 * DAY && memberWelcome("founding", false).text.includes("opening soon"));

await pool.end();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
