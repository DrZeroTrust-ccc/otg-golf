import express from "express";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { pool, logEvent } from "./db.js";
import { staffOnly } from "./bookings.js";
import { swingPage, tempoJs } from "./booking_pages.js";
import { etToUtc, addDays, todayEt, etParts, fmtHm } from "./booking_rules.js";
import { formatMemberNumber } from "./templates.js";

// Swing coaching, phase 1: the tempo analyzer. The bay screen (/swing) runs on the Premier bay
// computer: it watches the camera, hears the impact, works out tempo, and saves each swing here.
// Everything is behind the staff key, which the bay computer keeps.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((e) => {
    console.error(`${req.method} ${req.path} failed:`, (e as Error).message);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
  });
};

async function summary(sessionId: string) {
  const r = (await pool.query(
    `select count(*)::int count, round(avg(ratio), 2)::float mean, round(coalesce(stddev_samp(ratio), 0), 2)::float sd,
            min(ratio)::float min, max(ratio)::float max,
            round(avg(backswing_ms))::int backswing_ms, round(avg(downswing_ms))::int downswing_ms
       from swings where session_id = $1`, [sessionId])).rows[0];
  const consistency = r.count < 3 ? null : r.sd <= 0.15 ? "steady" : r.sd <= 0.3 ? "fair" : "all over";
  return { ...r, consistency };
}

export function mountSwing(app: Express) {
  const json = express.json({ limit: "16kb" });
  app.get("/swing", (_req, res) => { res.set("Cache-Control", "no-cache"); res.type("html").send(swingPage); });
  app.get("/swing/tempo.mjs", (_req, res) => { res.set("Cache-Control", "no-cache"); res.type("text/javascript").send(tempoJs); });
  // Body tracking (Google's MediaPipe), served from our own package so the bay screen doesn't
  // depend on a third-party script CDN. Only the bundle and its wasm folder are exposed.
  const mp = path.resolve("node_modules", "@mediapipe", "tasks-vision");
  app.get("/swing/mp/vision_bundle.mjs", (_req, res) => { res.set("Cache-Control", "public, max-age=86400"); res.type("text/javascript").sendFile(path.join(mp, "vision_bundle.mjs")); });
  app.use("/swing/mp/wasm", express.static(path.join(mp, "wasm"), { maxAge: "1d", index: false }));

  // Today's Premier bay bookings, so the bay screen can attach a session to whoever is hitting.
  app.get("/api/swing/premier-today", staffOnly, wrap(async (_req, res) => {
    const date = todayEt();
    const rows = (await pool.query(
      `select b.id, b.starts_at, b.ends_at, b.checked_in_at, p.name, p.member_number
         from bookings b join bays y on y.id = b.bay_id left join players p on p.id = b.player_id
        where y.premier and b.kind = 'booking' and b.status = 'confirmed'
          and b.starts_at < $2 and b.ends_at > $1
        order by b.starts_at`, [etToUtc(date, 0), etToUtc(addDays(date, 1), 0)])).rows;
    res.json({
      date,
      bookings: rows.map((r) => ({
        id: r.id, name: r.name, member_number: formatMemberNumber(r.member_number), checked_in: !!r.checked_in_at,
        start: fmtHm(etParts(new Date(r.starts_at)).minutes), end: fmtHm(etParts(new Date(r.ends_at)).minutes),
        now: new Date(r.starts_at).getTime() <= Date.now() && Date.now() < new Date(r.ends_at).getTime(),
      })),
    });
  }));

  app.post("/api/swing/sessions", staffOnly, json, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    let bookingId: string | null = null, playerId: string | null = null;
    if (b.booking_id != null && b.booking_id !== "") {
      const id = String(b.booking_id);
      const row = UUID.test(id) ? (await pool.query("select id, player_id from bookings where id = $1", [id])).rows[0] : null;
      if (!row) return res.status(400).json({ error: "That booking wasn't found." });
      bookingId = row.id; playerId = row.player_id;
    }
    const fps = Number(b.fps);
    const row = (await pool.query(
      `insert into swing_sessions (booking_id, player_id, label, camera, fps) values ($1,$2,$3,$4,$5) returning id, started_at`,
      [bookingId, playerId, str(b.label, 80), str(b.camera, 120), Number.isFinite(fps) && fps > 0 && fps < 1000 ? Math.round(fps) : null])).rows[0];
    await logEvent(pool, "swing.session_started", { session_id: row.id, booking_id: bookingId });
    res.json({ id: row.id, started_at: row.started_at, booking_id: bookingId, player_id: playerId });
  }));

  app.post("/api/swing/sessions/:id/end", staffOnly, wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: "Session not found." });
    const r = await pool.query("update swing_sessions set ended_at = coalesce(ended_at, now()) where id = $1 returning id", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Session not found." });
    res.json({ ok: true, summary: await summary(req.params.id) });
  }));

  app.post("/api/swing/sessions/:id/swings", staffOnly, json, wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: "Session not found." });
    const sess = (await pool.query("select id, ended_at from swing_sessions where id = $1", [req.params.id])).rows[0];
    if (!sess) return res.status(404).json({ error: "Session not found." });
    if (sess.ended_at) return res.status(400).json({ error: "That session has ended. Start a new one." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const back = Math.round(Number(b.backswing_ms)), down = Math.round(Number(b.downswing_ms));
    if (!(back >= 350 && back <= 2000 && down >= 120 && down <= 700)) return res.status(400).json({ error: "Those times don't look like a full swing." });
    const source = b.impact_source === "motion" ? "motion" : "sound";
    const confidence = ["high", "medium", "low"].includes(String(b.confidence)) ? String(b.confidence) : "medium";
    const swing = (await pool.query(
      `insert into swings (session_id, backswing_ms, downswing_ms, ratio, impact_source, confidence)
       values ($1, $2::int, $3::int, round($2::int::numeric / $3::int, 2), $4, $5) returning id, swung_at, backswing_ms, downswing_ms, ratio::float, impact_source, confidence`,
      [sess.id, back, down, source, confidence])).rows[0];
    res.json({ swing, summary: await summary(sess.id) });
  }));

  // Staff throw out a bad read (someone walked through the shot, a practice waggle, etc.).
  app.delete("/api/swing/swings/:id", staffOnly, wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: "Swing not found." });
    const r = await pool.query("delete from swings where id = $1 returning session_id", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Swing not found." });
    res.json({ ok: true, summary: await summary(r.rows[0].session_id) });
  }));

  app.get("/api/swing/sessions/:id", staffOnly, wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: "Session not found." });
    const session = (await pool.query(
      `select s.*, coalesce(p.name, s.label) player_name, p.member_number
         from swing_sessions s left join players p on p.id = s.player_id where s.id = $1`, [req.params.id])).rows[0];
    if (!session) return res.status(404).json({ error: "Session not found." });
    const swings = (await pool.query(
      "select id, swung_at, backswing_ms, downswing_ms, ratio::float, impact_source, confidence from swings where session_id = $1 order by swung_at", [session.id])).rows;
    res.json({ session: { ...session, member_number: formatMemberNumber(session.member_number) }, swings, summary: await summary(session.id) });
  }));

  // Recent sessions, newest first, with their averages.
  app.get("/api/swing/sessions", staffOnly, wrap(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const rows = (await pool.query(
      `select s.id, s.started_at, s.ended_at, coalesce(p.name, s.label) player_name, p.member_number,
              count(w.id)::int swings, round(avg(w.ratio), 2)::float mean, round(coalesce(stddev_samp(w.ratio), 0), 2)::float sd
         from swing_sessions s left join players p on p.id = s.player_id left join swings w on w.session_id = s.id
        group by s.id, p.name, p.member_number order by s.started_at desc limit $1`, [limit])).rows;
    res.json({ sessions: rows.map((r) => ({ ...r, member_number: formatMemberNumber(r.member_number) })) });
  }));
}
