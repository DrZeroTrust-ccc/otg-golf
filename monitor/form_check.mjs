// Weekly live check of the Events inquiry form. Creates no inquiries and sends no messages:
// it uses the honeypot (accepted, then silently dropped) and a submission with no contact details
// (rejected before anything is stored), plus the health check and the browser preflight.
import { alert } from "./alert.mjs";

const OPS = (process.env.OPS_URL || "https://otg-ops.onrender.com").replace(/\/+$/, "");
const SITE = (process.env.SITE_URL || "https://otg.golf").replace(/\/+$/, "");
const fails = [];
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails.push(`${name} ${extra}`.trim()); };
const attempt = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, `(${e.message})`); } };
const timeout = () => AbortSignal.timeout(30_000);

await attempt("otg-ops is up", async () => {
  const r = await fetch(`${OPS}/health`, { signal: timeout() });
  check("otg-ops is up", r.status === 200 && (await r.json()).ok === true, `(http ${r.status})`);
});

await attempt("preflight from the site allowed", async () => {
  const r = await fetch(`${OPS}/inquiries`, { method: "OPTIONS", signal: timeout(),
    headers: { origin: SITE, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  check("preflight from the site allowed", r.status === 204 && r.headers.get("access-control-allow-origin") === SITE, `(http ${r.status}, allow-origin ${r.headers.get("access-control-allow-origin")})`);
});

await attempt("form endpoint accepts a submission", async () => {
  const r = await fetch(`${OPS}/inquiries`, { method: "POST", signal: timeout(),
    headers: { "content-type": "application/json", accept: "application/json", origin: SITE },
    body: JSON.stringify({ name: "Weekly check", email: "weekly-check@example.com", company_website: "monitor" }) });
  const j = await r.json().catch(() => ({}));
  check("form endpoint accepts a submission", r.status === 200 && j.ok === true && r.headers.get("access-control-allow-origin") === SITE, `(http ${r.status})`);
});

await attempt("form endpoint validates input", async () => {
  const r = await fetch(`${OPS}/inquiries`, { method: "POST", signal: timeout(),
    headers: { "content-type": "application/json", accept: "application/json", origin: SITE },
    body: JSON.stringify({ name: "Weekly check" }) });
  check("form endpoint validates input", r.status === 400, `(http ${r.status})`);
});

// The Events page must still point its form at otg-ops (not an old form service). The reference
// can sit in the page, an iframe, or a script bundle on any host (including lazily loaded chunks),
// so this follows scripts, module preloads and iframes, then one level of JS chunk imports.
await attempt("events page posts to otg-ops", async () => {
  const page = await fetch(`${SITE}/events`, { signal: timeout(), headers: { "user-agent": "otg-weekly-check" } });
  check("events page loads", page.status === 200, `(http ${page.status})`);
  const html = await page.text();
  const opsHost = new URL(OPS).host;
  // The URL may be built from parts (API base + "/inquiries"), so look for both in one file.
  const hit = (t) => (t.includes(opsHost) || t.includes("go.otg.golf")) && t.includes("/inquiries");
  const refs = (text, base, re) => [...text.matchAll(re)].map((m) => { try { return new URL(m[1] ?? m[2], base).href; } catch { return null; } }).filter(Boolean);
  const seen = new Set();
  let queue = refs(html, page.url, /<(?:script|iframe)[^>]+src=["']([^"']+)["']|<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/gi);
  queue = [...queue, ...refs(html, page.url, /<link[^>]+href=["']([^"']+\.m?js[^"']*)["']/gi)];
  let found = hit(html) ? "the page itself" : null;
  for (let depth = 0; depth < 2 && !found && queue.length; depth++) {
    const next = [];
    for (const u of queue) {
      if (found || seen.has(u) || seen.size >= 60) continue;
      seen.add(u);
      const r = await fetch(u, { signal: timeout() }).catch(() => null);
      const t = r ? await r.text().catch(() => "") : "";
      if (hit(t)) { found = u; break; }
      if (/\.m?js$/.test(new URL(u).pathname) || /javascript/.test(r?.headers.get("content-type") ?? ""))
        next.push(...refs(t, u, /["'`]((?:\.{0,2}\/|https:\/\/)[^"'`\s]+?\.m?js)["'`]/g));
      else next.push(...refs(t, u, /<(?:script|iframe)[^>]+src=["']([^"']+)["']/gi));
    }
    queue = next;
  }
  const hosts = [...new Set([...seen].map((u) => new URL(u).host))].join(", ");
  check("events page posts to otg-ops", Boolean(found),
    found ? `(found in ${found})` : `(no reference to ${opsHost}/inquiries in the page or ${seen.size} linked files on ${hosts || "no hosts"})`);
});

// Optional: any owner alert or auto-reply that failed to send in the last week.
const key = process.env.OTG_READ_KEY?.trim();
if (key) await attempt("no failed messages this week", async () => {
  const r = await fetch(`${OPS}/outbox?status=failed`, { signal: timeout(), headers: { "X-OTG-Key": key } });
  const j = await r.json();
  const recent = (j.messages ?? []).filter((m) => Date.now() - new Date(m.created_at).getTime() < 7 * 86400_000);
  check("no failed messages this week", r.status === 200 && recent.length === 0,
    recent.length ? `(${recent.length} failed: ${recent.slice(0, 3).map((m) => `${m.channel} to ${m.to_addr}: ${m.last_error}`).join("; ")})` : `(http ${r.status})`);
});

if (fails.length) {
  console.log(`\n${fails.length} FAILED`);
  await alert("events form check failed", fails.join("\n"));
  process.exit(1);
}
console.log("\nALL PASS");
