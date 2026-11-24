import crypto from "node:crypto";
import express from "express";
import type { Express, Request, Response } from "express";
import type pg from "pg";
import { pool, logEvent } from "./db.js";
import { currentPlayerId } from "./auth.js";

// The waiver every player signs online before their first booking.
//
// PLACEHOLDER WORDING: replace WAIVER_TEXT with the text OTG's lawyer approves, then change
// WAIVER_VERSION (for example to "2027-01-v1"). A new version means everyone signs again.
// Signing is only required once staff turn on "waivers_on" in Rules and prices on the staff screen;
// leave it off until the real wording is in.
export const WAIVER_VERSION = "draft-1";
export const WAIVER_TEXT = `On The Green Indoor Golf: Release and Waiver of Liability

DRAFT: this wording is a placeholder and has not been reviewed by a lawyer.

I understand that golf, including simulator golf, involves risks such as being struck by a club or ball, slips and falls, and strain injuries. I take part voluntarily and accept those risks.

I agree to follow the rules posted at On The Green and the directions of its staff, to use the bays and equipment with care, and to pay for any damage I cause through misuse.

I release On The Green Golf Club Inc., its owners, staff and agents from claims for injury or loss arising from my use of the facility, except where caused by their gross negligence or willful misconduct.

I am 18 or older. I have read this waiver and agree to it.`;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const WAIVER_SHA = sha(WAIVER_TEXT);

type Db = pg.Pool | pg.PoolClient;

// When this player signed the current version, or null.
export async function waiverSignedAt(db: Db, playerId: string | null): Promise<Date | null> {
  if (!playerId) return null;
  const r = await db.query(
    "select signed_at from waivers where player_id = $1 and version = $2 order by signed_at desc limit 1", [playerId, WAIVER_VERSION]);
  return r.rows[0]?.signed_at ?? null;
}

// SQL for "has this player signed the current version", for staff lists. $n is the version parameter.
export const signedSql = (playerCol: string, versionParam: string) =>
  `exists (select 1 from waivers w where w.player_id = ${playerCol} and w.version = ${versionParam})`;

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((e) => {
    console.error(`${req.method} ${req.path} failed:`, (e as Error).message);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
  });
};

export function mountWaivers(app: Express, required: () => Promise<boolean>) {
  const json = express.json({ limit: "8kb" });

  app.get("/api/waiver", wrap(async (req, res) => {
    const pid = await currentPlayerId(req);
    const signed = await waiverSignedAt(pool, pid);
    res.json({ version: WAIVER_VERSION, text: WAIVER_TEXT, required: await required(), signed: !!signed, signed_at: signed });
  }));

  app.post("/api/waiver", json, wrap(async (req, res) => {
    const pid = await currentPlayerId(req);
    if (!pid) return res.status(401).json({ error: "Sign in first." });
    const src = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof src.name === "string" ? src.name.trim().replace(/\s+/g, " ").slice(0, 120) : "";
    if (src.agree !== true) return res.status(400).json({ error: "Tick the box to agree to the waiver." });
    if (name.length < 3) return res.status(400).json({ error: "Type your full name to sign." });
    // The page may have been open across a wording change: make them read the new one.
    if (src.version !== WAIVER_VERSION) return res.status(409).json({ error: "The waiver has been updated. Read the new version and sign again.", version: WAIVER_VERSION });
    if (await waiverSignedAt(pool, pid)) return res.json({ ok: true, already: true });
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
    const ua = (req.headers["user-agent"] ?? "").slice(0, 300) || null;
    const r = await pool.query(
      `insert into waivers (player_id, version, text_sha256, signed_name, ip, user_agent) values ($1,$2,$3,$4,$5,$6) returning id, signed_at`,
      [pid, WAIVER_VERSION, WAIVER_SHA, name, ip, ua]);
    await pool.query("update players set name = coalesce(name, $2) where id = $1", [pid, name]);
    await logEvent(pool, "waiver.signed", { player_id: pid, waiver_id: r.rows[0].id, version: WAIVER_VERSION });
    res.json({ ok: true, signed_at: r.rows[0].signed_at });
  }));
}
