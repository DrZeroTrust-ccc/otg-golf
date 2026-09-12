// SMS primitive smoke test. Runs against DATABASE_URL with Twilio unconfigured (dormant) and
// with a fake token to exercise signature verification and the inbound keyword handling.
import crypto from "node:crypto";
import pg from "pg";

process.env.TWILIO_AUTH_TOKEN = "testtoken";
process.env.PUBLIC_BASE_URL = "https://otg-ops.onrender.com";
delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_MESSAGING_SERVICE_SID;

const { sendSms, onInboundSms, verifyTwilioSignature, smsConfigured, HELP_REPLY, START_REPLY } = await import("./dist/sms.js");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const c = await pool.connect();
const phone = "+15405550199";
const t0 = new Date();
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };

await c.query("delete from sms_messages where phone = $1", [phone]);
for (const t of ["tags", "purchases", "memberships"]) await c.query(`delete from ${t} where player_id in (select id from players where phone = $1)`, [phone]);
await c.query("delete from players where phone = $1", [phone]);
await c.query("insert into players (name, phone) values ('Smoke Tester', $1)", [phone]);

check("dormant when unconfigured", smsConfigured === false);
let r = await sendSms("540-555-0199", "hello");
check("send skipped while unconfigured", r.ok === false && r.status === "skipped", JSON.stringify(r));

// Inbound STOP → opt-out recorded, no reply
let reply = await onInboundSms({ From: phone, Body: "STOP", MessageSid: "SMtest1" });
let p = (await c.query("select sms_opt_out, sms_opt_out_at from players where phone=$1", [phone])).rows[0];
check("STOP sets opt-out", p.sms_opt_out === true && p.sms_opt_out_at && reply === null);

r = await sendSms(phone, "should not send");
check("send refused after opt-out", r.status === "skipped" && r.error === "opted out");

// Inbound START → cleared, opt-in reply
reply = await onInboundSms({ From: phone, Body: "start", MessageSid: "SMtest2" });
p = (await c.query("select sms_opt_out from players where phone=$1", [phone])).rows[0];
check("START clears opt-out and replies", p.sms_opt_out === false && reply === START_REPLY);

reply = await onInboundSms({ From: phone, Body: "Help?", MessageSid: "SMtest3" });
check("HELP replies with help text", reply === HELP_REPLY);

reply = await onInboundSms({ From: phone, Body: "can I book bay 2 tonight", MessageSid: "SMtest4" });
check("free text: logged, no auto-reply", reply === null);

// Duplicate delivery of the same MessageSid is a no-op
await onInboundSms({ From: phone, Body: "can I book bay 2 tonight", MessageSid: "SMtest4" });
const inbound = (await c.query("select count(*) from sms_messages where phone=$1 and direction='in'", [phone])).rows[0].count;
check("inbound log has 4 rows (dup ignored)", Number(inbound) === 4, `got ${inbound}`);

// Signature verification
const url = "https://otg-ops.onrender.com/webhooks/twilio";
const params = { From: phone, Body: "STOP", MessageSid: "SMx", To: "+15403409067" };
const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
const good = crypto.createHmac("sha1", "testtoken").update(data).digest("base64");
check("valid signature accepted", verifyTwilioSignature(url, params, good));
check("tampered body rejected", !verifyTwilioSignature(url, { ...params, Body: "START" }, good));
check("missing signature rejected", !verifyTwilioSignature(url, params, undefined));

const ev = (await c.query("select kind from events where at >= $1 and kind like 'sms.%' order by id", [t0])).rows.map((r) => r.kind);
check("events trail", JSON.stringify(ev) === JSON.stringify(["sms.skipped","sms.opt_out","sms.skipped","sms.opt_in","sms.help","sms.received","sms.received"]), ev.join(","));

c.release(); await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
