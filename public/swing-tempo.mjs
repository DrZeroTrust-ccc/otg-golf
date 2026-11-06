// Swing tempo math, shared by the bay screen (/swing) and the tests (swing_smoke.mjs).
// No browser or server dependencies: everything here works on plain numbers.
//
// Input is a run of "hand samples" from body tracking: { t, x, y, scale }
//   t      time in milliseconds (performance.now() timebase on the bay screen)
//   x, y   the midpoint of the two wrists, in image coordinates 0..1 (y grows downward)
//   scale  torso length (mid-shoulders to mid-hips) in the same units, so thresholds
//          work the same whether the player stands near or far from the camera.
//
// A swing has three moments:
//   takeaway  hands start moving away from address
//   top       hands at their highest point before the downswing
//   impact    club meets ball (from the impact sound, or from the hands when there's no sound)
// Backswing = takeaway -> top. Downswing = top -> impact. Tempo ratio = backswing / downswing.

export const TARGET_RATIO = 3;

// Limits for a believable full swing. Anything outside is treated as a bad read, not a swing.
export const LIMITS = {
  backswingMs: [350, 2000],
  downswingMs: [120, 700],
  ratio: [1.2, 6],
};

const median = (a) => { const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Centered moving average on x and y over +/- halfMs (at least one neighbor each side).
// Body tracking jitters a little frame to frame.
export function smooth(samples, halfMs = 0) {
  return samples.map((s, i) => {
    let a = Math.max(0, i - 1), b = Math.min(samples.length - 1, i + 1);
    while (a > 0 && s.t - samples[a - 1].t <= halfMs) a--;
    while (b < samples.length - 1 && samples[b + 1].t - s.t <= halfMs) b++;
    const w = samples.slice(a, b + 1);
    return { ...s, x: w.reduce((n, p) => n + p.x, 0) / w.length, y: w.reduce((n, p) => n + p.y, 0) / w.length };
  });
}

// Hand speed per sample, in torso lengths per second.
function speeds(s, scale) {
  return s.map((p, i) => (i === 0 ? 0 : dist(p, s[i - 1]) / scale / Math.max(1e-3, (p.t - s[i - 1].t) / 1000)));
}

// Impact from the hands alone: the fastest hand speed comes just before impact, and impact is
// where the hands bottom out (lowest point) right around that peak.
export function poseImpact(s, scale) {
  if (s.length < 5) return null;
  const v = speeds(s, scale);
  let peak = 1;
  for (let i = 1; i < v.length; i++) if (v[i] > v[peak]) peak = i;
  let best = peak;
  for (let i = 0; i < s.length; i++) {
    if (Math.abs(s[i].t - s[peak].t) <= 120 && s[i].y > s[best].y) best = i;
  }
  return { index: best, t: s[best].t, peakSpeed: v[peak] };
}

/**
 * Work out tempo for one swing.
 * @param samples hand samples covering at least ~2.5 s before impact and ~0.2 s after.
 * @param opts.soundImpactT impact time from the impact sound, if there was one.
 * @param opts.maxSoundMismatchMs how far the sound may be from the hands' impact before we
 *        decide the sound came from somewhere else (a neighboring bay).
 * @returns { ok: true, backswingMs, downswingMs, ratio, takeawayT, topT, impactT, impactSource, confidence, fps }
 *       or { ok: false, reason }
 */
export function analyzeSwing(samples, opts = {}) {
  const raw = (samples ?? []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.scale > 0);
  if (raw.length < 15) return { ok: false, reason: "not enough tracking (is the player in view?)" };
  const s = smooth(raw, 20);
  const scale = median(s.map((p) => p.scale));
  const fps = (s.length - 1) / ((s[s.length - 1].t - s[0].t) / 1000);

  // 1. Impact.
  const pose = poseImpact(s, scale);
  if (!pose || pose.peakSpeed < 3) return { ok: false, reason: "no swing found (hands never moved fast)" };
  let impactT = pose.t, impactSource = "motion";
  if (Number.isFinite(opts.soundImpactT)) {
    const maxGap = opts.maxSoundMismatchMs ?? 150;
    if (Math.abs(opts.soundImpactT - pose.t) > maxGap) return { ok: false, reason: "impact sound didn't line up with this player's swing" };
    impactT = opts.soundImpactT; impactSource = "sound";
  }

  // 2. Top: highest hands (smallest y) in the 2.5 s before impact, ignoring the last 100 ms.
  let top = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i].t < impactT - 2500 || s[i].t > impactT - 100) continue;
    if (top < 0 || s[i].y < s[top].y) top = i;
  }
  if (top < 0) return { ok: false, reason: "couldn't find the top of the swing" };
  // The hands hover at the top while they change direction, so the single highest sample is
  // mostly noise. The downswing starts from rest, so the drop from the peak grows with the square
  // of time: where the hands fall 2% and 8% of a torso below the peak tells us when the drop began.
  let a = top, b = top;
  while (a > 0 && s[a - 1].y <= s[top].y + 0.02 * scale) a--;
  while (b < s.length - 1 && s[b + 1].y <= s[top].y + 0.02 * scale) b++;
  let b2 = b;
  while (b2 < s.length - 1 && s[b2].y < s[top].y + 0.08 * scale && s[b2].t < impactT) b2++;
  const r1 = Math.sqrt(Math.max(0, s[b].y - s[top].y) / scale), r2 = Math.sqrt(Math.max(0, s[b2].y - s[top].y) / scale);
  const est = r2 > r1 ? s[b].t - ((s[b2].t - s[b].t) * r1) / (r2 - r1) : (s[a].t + s[b].t) / 2;
  const topT = Math.min(s[b].t, Math.max(s[a].t, est));

  // 3. Takeaway. Walk back from the top until the hands were still for ~100 ms (address).
  //    "Still" = moved less than 8% of a torso length across that window.
  //    The hands also slow down at the top as they change direction, so the search starts once
  //    they are well below the top (40% of a torso length), on the way back to address.
  const windowMs = 100, stillDist = 0.08 * scale;
  let from = top;
  while (from > 0 && s[from].y - s[top].y < 0.4 * scale) from--;
  let stillEnd = -1;
  for (let j = from; j >= 0; j--) {
    let k = j;
    while (k > 0 && s[j].t - s[k - 1].t <= windowMs) k--;
    if (s[j].t - s[k].t < windowMs * 0.6) continue; // not enough history for a full window yet
    if (dist(s[j], s[k]) < stillDist) { stillEnd = j; break; }
  }
  let confidence = fps >= 100 ? "high" : fps >= 45 ? "medium" : "low";
  let takeaway, takeawayT;
  if (stillEnd < 0) {
    takeaway = 0; takeawayT = s[0].t; confidence = "low"; // never saw address; use the earliest sample we have
  } else {
    // Address position = average over the still window; takeaway = first sample after it that
    // leaves address by more than 2.5% of a torso length and doesn't come back before the top.
    // The still window can overlap the first slow inches of the takeaway, so address is taken
    // as the median over the 300 ms leading up to it, which is mostly before any motion.
    const win = s.filter((p) => p.t <= s[stillEnd].t && p.t >= s[stillEnd].t - 300);
    const addr = { x: median(win.map((p) => p.x)), y: median(win.map((p) => p.y)) };
    takeaway = top;
    for (let i = top; i > 0; i--) {
      if (dist(s[i], addr) <= 0.025 * scale) break;
      takeaway = i;
    }
    // Hands start from rest, so early on distance grows with the square of time. Where the hands
    // pass 2.5% and 10% of a torso tells us, by that curve, when they really started moving.
    let far = takeaway;
    while (far < top && dist(s[far], addr) < 0.1 * scale) far++;
    const d1 = Math.sqrt(dist(s[takeaway], addr) / scale), d2 = Math.sqrt(dist(s[far], addr) / scale);
    const back = d2 > d1 ? ((s[far].t - s[takeaway].t) * d1) / (d2 - d1) : 0;
    takeawayT = s[takeaway].t - Math.min(back, 250);
  }

  const backswingMs = Math.round(topT - takeawayT);
  const downswingMs = Math.round(impactT - topT);
  const ratio = downswingMs > 0 ? backswingMs / downswingMs : Infinity;
  const out = (lo, hi, v) => v < lo || v > hi;
  if (out(...LIMITS.backswingMs, backswingMs)) return { ok: false, reason: `backswing ${backswingMs} ms doesn't look like a full swing` };
  if (out(...LIMITS.downswingMs, downswingMs)) return { ok: false, reason: `downswing ${downswingMs} ms doesn't look like a full swing` };
  if (out(...LIMITS.ratio, ratio)) return { ok: false, reason: `ratio ${ratio.toFixed(2)} is outside what a real swing does` };
  return {
    ok: true, backswingMs, downswingMs, ratio: Math.round(ratio * 100) / 100,
    takeawayT, topT, impactT, impactSource, confidence, fps: Math.round(fps),
  };
}

// Green / yellow / red for one swing's ratio.
export function rateRatio(r) {
  const off = Math.abs(r - TARGET_RATIO);
  return off <= 0.3 ? "good" : off <= 0.6 ? "close" : "off";
}

// Session summary. Consistency is the standard deviation of the ratio: small is steady.
export function summarize(ratios) {
  const a = ratios.filter(Number.isFinite);
  if (!a.length) return { count: 0, mean: null, sd: null, min: null, max: null, consistency: null };
  const mean = a.reduce((n, v) => n + v, 0) / a.length;
  const sd = a.length > 1 ? Math.sqrt(a.reduce((n, v) => n + (v - mean) ** 2, 0) / (a.length - 1)) : 0;
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    count: a.length, mean: r2(mean), sd: r2(sd), min: r2(Math.min(...a)), max: r2(Math.max(...a)),
    consistency: a.length < 3 ? null : sd <= 0.15 ? "steady" : sd <= 0.3 ? "fair" : "all over",
  };
}

// The training beat: three tones (start back, top, impact) for a chosen backswing length.
export function beatTimes(backswingMs, ratio = TARGET_RATIO) {
  return [0, backswingMs, Math.round(backswingMs + backswingMs / ratio)];
}

/**
 * Impact-sound detector. Feed it loudness readings (peak level per audio block, 0..1) as they arrive; it answers with
 * an impact time when a sharp spike stands well above the room's background noise.
 * One impact per `refractoryMs`, so the ball hitting the screen a moment later isn't counted.
 */
export function createImpactDetector({ sensitivity = 1, refractoryMs = 1500, minLevel = 0.08 } = {}) {
  let floor = 0.01, last = -Infinity;
  return {
    get floor() { return floor; },
    push(rms, t) {
      const threshold = Math.max(minLevel / sensitivity, (floor * 8) / sensitivity);
      if (rms > threshold && t - last > refractoryMs) { last = t; return t; }
      // Background follows the quieter readings slowly, so a hit doesn't raise it.
      if (rms < threshold) floor = floor * 0.995 + rms * 0.005;
      return null;
    },
  };
}
