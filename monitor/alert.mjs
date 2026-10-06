// Sends a short alert to the owner when a scheduled check fails. Uses whatever is configured:
// a text through Twilio (same account the backend uses) and/or an email through Resend.
// If neither is configured it does nothing; the failed GitHub Actions run is still the record.
export async function alert(subject, details) {
  // A pull request run is a test of the checks themselves; don't text anyone about it.
  if (process.env.GITHUB_EVENT_NAME === "pull_request") return console.log("alert: skipped on pull request runs");
  const env = (k) => process.env[k]?.trim() || "";
  const sent = [];
  const sid = env("TWILIO_ACCOUNT_SID"), token = env("TWILIO_AUTH_TOKEN"), svc = env("TWILIO_MESSAGING_SERVICE_SID"), phone = env("OWNER_ALERT_PHONE");
  const run = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "";
  if (sid && token && svc && phone) {
    const body = `OTG check: ${subject}${run ? `\n${run}` : ""}`.slice(0, 600);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: phone, MessagingServiceSid: svc, Body: body }),
    }).catch((e) => ({ ok: false, status: e.message }));
    sent.push(`sms ${r.ok ? "sent" : `failed (${r.status})`}`);
  }
  const resend = env("RESEND_API_KEY");
  if (resend) {
    const to = (env("OWNER_ALERT_EMAILS") || "chase@otg.golf").split(",").map((s) => s.trim()).filter(Boolean);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env("EMAIL_FROM") || "On The Green Indoor Golf <hello@otg.golf>", to, subject: `OTG check: ${subject}`, text: `${details}\n\n${run}` }),
    }).catch((e) => ({ ok: false, status: e.message }));
    sent.push(`email ${r.ok ? "sent" : `failed (${r.status})`}`);
  }
  console.log(sent.length ? `alert: ${sent.join(", ")}` : "alert: no SMS or email configured; relying on GitHub's failed-run email");
}
