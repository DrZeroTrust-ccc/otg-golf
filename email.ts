import { pool } from "./db.js";

// Email primitive: one send function over Resend's REST API. No SDK.
// Dormant until RESEND_API_KEY is set. Values are trimmed: a stray space or newline pasted into
// an environment variable must never break sending.
const KEY = process.env.RESEND_API_KEY?.trim();
const FROM = process.env.EMAIL_FROM?.trim() || "On The Green Indoor Golf <hello@otg.golf>";

export const emailConfigured = Boolean(KEY);

export type EmailResult = { ok: boolean; status: "sent" | "skipped" | "failed"; id?: string; error?: string };

export async function sendEmail(m: {
  to: string; subject: string; text: string; replyTo?: string | null; idempotencyKey?: string; outboxId?: number | null;
}): Promise<EmailResult> {
  const record = async (status: string, id: string | null, error: string | null) => {
    await pool.query(
      "insert into email_messages (to_addr, subject, status, provider_id, error, outbox_id) values ($1,$2,$3,$4,$5,$6)",
      [m.to, m.subject, status, id, error, m.outboxId ?? null]
    );
  };
  if (!KEY) {
    await record("skipped", null, "email not configured");
    return { ok: false, status: "skipped", error: "email not configured" };
  }
  try {
    const r = await fetch(process.env.RESEND_API_URL ?? "https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify({
        from: FROM, to: [m.to], subject: m.subject, text: m.text,
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
    });
    const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!r.ok || !j.id) {
      const err = j.message ?? j.name ?? `http ${r.status}`;
      await record("failed", null, err);
      return { ok: false, status: "failed", error: err };
    }
    await record("sent", j.id, null);
    return { ok: true, status: "sent", id: j.id };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await record("failed", null, err);
    return { ok: false, status: "failed", error: err };
  }
}
