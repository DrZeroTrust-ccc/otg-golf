import { readFile } from "node:fs/promises";
import Stripe from "stripe";
import { pool, logEvent } from "./db.js";
import { seedPartners, ensureStripeOffers } from "./partners.js";

// Loads seed/price_map.csv into price_map. Safe to re-run: upserts by price id.
async function main() {
  const text = await readFile("price_map.csv", "utf8");
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(",");
  if (cols.join() !== "stripe_price_id,tier,product,tag,seat_cap")
    throw new Error("price_map.csv header must be: stripe_price_id,tier,product,tag,seat_cap");
  let n = 0;
  for (const line of rows) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [id, tier, product, tag, cap] = line.split(",").map((s) => s.trim());
    if (id.includes("REPLACE")) { console.log(`skip placeholder ${id}`); continue; }
    await pool.query(
      `insert into price_map (stripe_price_id, tier, product, tag, seat_cap)
       values ($1, nullif($2,''), nullif($3,''), nullif($4,''), nullif($5,'')::int)
       on conflict (stripe_price_id) do update
         set tier = excluded.tier, product = excluded.product, tag = excluded.tag, seat_cap = excluded.seat_cap`,
      [id, tier, product, tag, cap]
    );
    await logEvent(pool, "price_map.upserted", { stripe_price_id: id, tier, product, tag, seat_cap: cap });
    n++;
  }
  console.log(`price_map: ${n} rows upserted`);
  console.log(`partners: ${await seedPartners(pool)} rows upserted`);
  const key = process.env.STRIPE_SECRET_KEY;
  if (key) {
    try { for (const line of await ensureStripeOffers(new Stripe(key), pool)) console.log(`stripe offers: ${line}`); }
    catch (e) { console.error("stripe offers: skipped —", (e as Error).message); }
  } else console.log("stripe offers: skipped (no STRIPE_SECRET_KEY)");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
