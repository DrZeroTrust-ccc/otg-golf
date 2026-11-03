// Booking rules, prices and opening hours. Pure functions only (no database), so they can be
// read and tested on their own. Every number here is a default: staff can override any key from
// the staff screen (stored in booking_settings.config), with no code change or redeploy.

export const TZ = "America/New_York";
export type Plan = "founding" | "full" | "weekday" | "none";
export type Band = "offpeak" | "standard" | "prime";
type DayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
const DAY_KEYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type PlanRules = { ahead_days: number; max_upcoming: number; max_minutes: number };

export const DEFAULTS = {
  // First day bookings can be made for (YYYY-MM-DD). Blank = opening day from OPENING_DAY;
  // if that isn't set either, booking is closed and the page says "opening soon".
  first_day: "" as string,
  // Opening hours, US Eastern. [open, close] as "HH:MM"; empty array = closed that day.
  hours: {
    sun: ["08:00", "21:00"], mon: ["10:00", "22:00"], tue: ["10:00", "22:00"], wed: ["10:00", "22:00"],
    thu: ["10:00", "22:00"], fri: ["10:00", "23:00"], sat: ["08:00", "23:00"],
  } as Record<DayKey, string[]>,
  // Per bay per hour, from the website: Off-peak Mon-Thu before 4pm, Standard Mon-Thu evenings
  // and Fri-Sun daytime, Prime Fri-Sun evenings and holidays.
  rates_cents: { offpeak: 5000, standard: 6000, prime: 7500 } as Record<Band, number>,
  evening_starts: "16:00",
  holidays: [] as string[],                        // "YYYY-MM-DD", charged at the Prime rate
  premier_premium_cents: 1500,                     // extra per hour for non-members on the Premier Bay
  premier_nonmember_within_hours: 48,              // non-members can only book it this close to the time
  puttview_cents_per_hour: 4000,                   // PLACEHOLDER until Chase sets the PuttView price
  members_free_puttview: true,
  plans: {
    founding: { ahead_days: 21, max_upcoming: 4, max_minutes: 180 },
    full: { ahead_days: 14, max_upcoming: 3, max_minutes: 120 },
    weekday: { ahead_days: 14, max_upcoming: 3, max_minutes: 120 },
    none: { ahead_days: 5, max_upcoming: 2, max_minutes: 120 },
  } as Record<Plan, PlanRules>,
  // Weekday plan plays free inside this window; outside it they pay the normal rate.
  weekday_free: { days: ["mon", "tue", "wed", "thu"], from: "10:00", to: "18:00" },
  slot_minutes: 30,
  min_minutes_sim: 60,
  min_minutes_putt: 30,
  max_guests: 5,                                   // bays take up to 6 players
  refund_cutoff_hours: 24,                         // paid bookings cancelled this far ahead are refunded in full
  reminder_hours: 3,                               // reminder text this long before the start
  // Check-in and no-shows
  checkin_opens_minutes: 30,                       // "I'm here" works from this long before your start
  // Where OTG is, for "I'm here" check-in. Set from the staff screen while standing in the building.
  venue: { lat: null as number | null, lng: null as number | null, radius_m: 200 },
  no_show_after_minutes: 15,                       // not checked in by then: the bay is released
  no_show_fees_on: false,                          // off for the soft launch; turn on when ready
  no_show_fee_cents: 2000,                         // members only, added to their next membership bill
  strikes: { limit: 3, window_days: 60, pause_days: 30 }, // this many no-shows (or late cancels) pauses Prime booking
  late_cancel_strike: true,                        // a member cancelling inside refund_cutoff_hours counts as a strike
  // Guests of members. null = unlimited free guests.
  guest_passes_per_year: { founding: null, full: 6, weekday: 4 } as Record<"founding" | "full" | "weekday", number | null>,
  guest_fee_cents: 1000,                           // per guest per booking once passes run out
  // Early access: members can ask to start up to this long before opening, by the deadline the day before.
  early_access_minutes: 60,
  early_access_deadline: "18:00",
};
export type Settings = typeof DEFAULTS;

// Shallow merge per top-level key, one level deeper for objects, so a partial override such as
// {"rates_cents":{"prime":8000}} keeps the other rates.
export function mergeSettings(over: unknown): Settings {
  const s = structuredClone(DEFAULTS) as Record<string, unknown>;
  if (over && typeof over === "object") {
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      if (!(k in s)) continue;
      const cur = s[k];
      if (cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object" && !Array.isArray(v)) {
        s[k] = { ...(cur as object), ...(v as object) };
      } else s[k] = v;
    }
  }
  return s as Settings;
}

// ---- time (US Eastern) -----------------------------------------------------------

export const hm = (s: string): number => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };
export const fmtHm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z"));
export const dowOf = (date: string): number => new Date(date + "T12:00:00Z").getUTCDay();
export const addDays = (date: string, n: number): string => new Date(Date.parse(date + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
export function etParts(d: Date): { date: string; minutes: number } {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
// The instant that is `minutes` after midnight on `date`, Eastern time (handles daylight saving).
export function etToUtc(date: string, minutes: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, 0, minutes);
  let t = want + 5 * 3600_000;
  for (let i = 0; i < 3; i++) {
    const p = etParts(new Date(t));
    const [py, pm, pd] = p.date.split("-").map(Number);
    const shown = Date.UTC(py, pm - 1, pd, 0, p.minutes);
    if (shown === want) break;
    t += want - shown;
  }
  return new Date(t);
}
export const todayEt = (now = new Date()) => etParts(now).date;

export function describeSlot(date: string, start: number, minutes: number): string {
  const d = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const t = (m: number) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`; };
  return `${d}, ${t(start)} to ${t(start + minutes)}`;
}

// ---- hours and prices -------------------------------------------------------------

export function hoursFor(s: Settings, date: string): [number, number] | null {
  const h = s.hours[DAY_KEYS[dowOf(date)]];
  if (!h || h.length < 2) return null;
  return [hm(h[0]), hm(h[1])];
}

export function bandAt(s: Settings, date: string, minute: number): Band {
  if (s.holidays.includes(date)) return "prime";
  const dow = dowOf(date);
  const evening = minute >= hm(s.evening_starts);
  if (dow >= 1 && dow <= 4) return evening ? "standard" : "offpeak";
  return evening ? "prime" : "standard";
}

export function weekdayPlanCovers(s: Settings, date: string, minute: number): boolean {
  const w = s.weekday_free;
  return w.days.includes(DAY_KEYS[dowOf(date)]) && minute >= hm(w.from) && minute < hm(w.to);
}

// Price of one slot (slot_minutes long) for this plan, in cents.
export function slotPrice(s: Settings, bay: { kind: string; premier: boolean }, plan: Plan, date: string, minute: number): number {
  const frac = s.slot_minutes / 60;
  if (bay.kind === "putt") {
    if (plan !== "none" && s.members_free_puttview && (plan !== "weekday" || weekdayPlanCovers(s, date, minute))) return 0;
    return Math.round(s.puttview_cents_per_hour * frac);
  }
  if (plan === "founding" || plan === "full") return 0;
  if (plan === "weekday" && weekdayPlanCovers(s, date, minute)) return 0;
  const premium = bay.premier && plan === "none" ? s.premier_premium_cents : 0;
  return Math.round((s.rates_cents[bandAt(s, date, minute)] + premium) * frac);
}

export function priceFor(s: Settings, bay: { kind: string; premier: boolean }, plan: Plan, date: string, start: number, minutes: number): number {
  let total = 0;
  for (let m = start; m < start + minutes; m += s.slot_minutes) total += slotPrice(s, bay, plan, date, m);
  return total;
}

// ---- who may book what -----------------------------------------------------------

export type Request = { bay: { id: string; kind: string; premier: boolean }; date: string; start: number; minutes: number; guests: number };

// First bookable day: the settings value, else opening day, else null (booking closed).
export function firstDay(s: Settings, openingDay: Date | null): string | null {
  if (isDate(s.first_day)) return s.first_day;
  return openingDay ? etParts(openingDay).date : null;
}
export function lastDay(s: Settings, plan: Plan, now = new Date()): string {
  return addDays(todayEt(now), s.plans[plan].ahead_days);
}

// Returns a plain-language reason the booking isn't allowed, or null if it is.
// Overlap with other bookings and the per-player limit are checked against the database separately.
export function ruleProblem(s: Settings, plan: Plan, r: Request, opening: Date | null, now = new Date()): string | null {
  const first = firstDay(s, opening);
  if (!first) return "Booking opens once our opening day is announced.";
  if (!isDate(r.date)) return "Pick a date.";
  if (r.date < first) return "We aren't open yet on that date.";
  if (r.date > lastDay(s, plan, now)) {
    const n = s.plans[plan].ahead_days;
    return plan === "none" ? `Bookings open ${n} days ahead. Members can book further out.` : `Your plan books up to ${n} days ahead.`;
  }
  const hours = hoursFor(s, r.date);
  if (!hours) return "We're closed that day.";
  const step = s.slot_minutes;
  if (r.start % step || r.minutes % step) return `Times go in ${step}-minute steps.`;
  const min = r.bay.kind === "putt" ? s.min_minutes_putt : s.min_minutes_sim;
  if (r.minutes < min) return `The shortest booking is ${min} minutes.`;
  const max = s.plans[plan].max_minutes;
  if (r.minutes > max) return `The longest booking on your plan is ${max / 60} hours.`;
  const early = r.start < hours[0];
  if (early) {
    if (plan === "none" || r.start < hours[0] - s.early_access_minutes || r.start + r.minutes > hours[1])
      return `We're open ${fmtHm(hours[0])} to ${fmtHm(hours[1])} that day.`;
    if (now.getTime() >= earlyDeadline(s, r.date).getTime())
      return `Early starts need asking for by ${fmtHm(hm(s.early_access_deadline))} the day before.`;
  } else if (r.start + r.minutes > hours[1]) return `We're open ${fmtHm(hours[0])} to ${fmtHm(hours[1])} that day.`;
  const startsAt = etToUtc(r.date, r.start);
  if (startsAt.getTime() <= now.getTime()) return "That time has already started.";
  if (!Number.isInteger(r.guests) || r.guests < 0 || r.guests > s.max_guests) return `A bay takes up to ${s.max_guests + 1} players.`;
  if (r.bay.premier) {
    let prime = false;
    for (let m = r.start; m < r.start + r.minutes; m += step) if (bandAt(s, r.date, m) === "prime") prime = true;
    if (plan === "none" && prime) return "The Premier Bay is for members at Prime times. Bays 2 to 4 are open to everyone.";
    if (plan === "none" && startsAt.getTime() - now.getTime() > s.premier_nonmember_within_hours * 3600_000)
      return `Non-members can book the Premier Bay up to ${s.premier_nonmember_within_hours} hours ahead.`;
  }
  return null;
}

// ---- early access, guests, strikes -----------------------------------------------

export const earlyDeadline = (s: Settings, date: string): Date => etToUtc(addDays(date, -1), hm(s.early_access_deadline));
export const isEarly = (s: Settings, date: string, start: number): boolean => { const h = hoursFor(s, date); return !!h && start < h[0]; };

// How many of this booking's guests ride on free passes, and what the rest cost.
// usedThisYear = passes the member has already used this calendar year.
export function guestSplit(s: Settings, plan: Plan, guests: number, usedThisYear: number): { passes: number; feeCents: number; left: number | null } {
  if (plan === "none" || guests <= 0) return { passes: 0, feeCents: 0, left: plan === "none" ? 0 : remaining(s, plan, usedThisYear) };
  const left = remaining(s, plan, usedThisYear);
  const passes = left === null ? guests : Math.min(guests, left);
  return { passes, feeCents: (guests - passes) * s.guest_fee_cents, left };
}
function remaining(s: Settings, plan: Exclude<Plan, "none">, used: number): number | null {
  const a = s.guest_passes_per_year[plan];
  return a === null || a === undefined ? null : Math.max(0, a - used);
}

// Strikes: no-shows and member late cancels inside the window. At the limit, Prime booking pauses
// until pause_days after the latest strike.
export function primePausedUntil(s: Settings, strikeTimes: Date[], now = new Date()): Date | null {
  const since = now.getTime() - s.strikes.window_days * 86400_000;
  const recent = strikeTimes.map((d) => d.getTime()).filter((t) => t >= since).sort((a, b) => a - b);
  if (recent.length < s.strikes.limit) return null;
  const until = new Date(recent[recent.length - 1] + s.strikes.pause_days * 86400_000);
  return until.getTime() > now.getTime() ? until : null;
}
export function touchesPrime(s: Settings, date: string, start: number, minutes: number): boolean {
  for (let m = start; m < start + minutes; m += s.slot_minutes) if (bandAt(s, date, m) === "prime") return true;
  return false;
}

// Distance in meters between two points (haversine).
export function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Is a phone reporting this position (accuracy in meters) at OTG? Indoors GPS is rough, so allow for
// the phone's own stated accuracy, up to 150 m of it.
export function atVenue(s: Settings, pos: { lat: number; lng: number; accuracy?: number }): boolean | null {
  const v = s.venue;
  if (typeof v?.lat !== "number" || typeof v?.lng !== "number") return null;
  const slack = Math.min(Math.max(pos.accuracy ?? 0, 0), 150);
  return metersBetween({ lat: v.lat, lng: v.lng }, pos) <= v.radius_m + slack;
}
