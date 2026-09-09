import Stripe from "stripe";
import { pool, logEvent } from "./db.js";
import { onCustomer, onSubscription, onCheckoutCompleted } from "./stripeHandlers.js";

// One-time import of existing Stripe data through the SAME handlers the webhook uses.
//   npm run backfill            -> dry run: counts only, writes nothing
//   npm run backfill -- --write -> real run
type StripeLike = Pick<Stripe, "customers" | "subscriptions" | "checkout">;

export async function runBackfill(stripe: StripeLike, write: boolean) {
    const counts = { customers: 0, subscriptions: 0, checkouts: 0, checkouts_skipped_unpaid: 0 };
    const client = await pool.connect();
    try {
          await client.query("begin");

      for await (const cust of stripe.customers.list({ limit: 100 })) {
              counts.customers++;
              if (write) await onCustomer(client, cust);
      }
          for await (const sub of stripe.subscriptions.list({ limit: 100, status: "all" })) {
                  counts.subscriptions++;
                  if (write) await onSubscription(client, sub);
          }
          for await (const cs of stripe.checkout.sessions.list({ limit: 100 })) {
                  if (cs.payment_status !== "paid" && cs.payment_status !== "no_payment_required") { counts.checkouts_skipped_unpaid++; continue; }
                  counts.checkouts++;
                  if (write) {
                            let priceId: string | null = null;
                            try { priceId = (await stripe.checkout.sessions.listLineItems(cs.id, { limit: 1 })).data[0]?.price?.id ?? null; } catch {}
                            await onCheckoutCompleted(client, cs, priceId);
                  }
          }

      if (write) {
              await logEvent(client, "backfill.completed", counts);
              await client.query("commit");
              console.log("WRITE run committed:", counts);
      } else {
              await client.query("rollback");
              console.log("DRY run (nothing written):", counts);
              console.log("Re-run with --write to import.");
      }
    } catch (e) {
          await client.query("rollback").catch(() => {});
          throw e;
    } finally {
          client.release();
    }
    return counts;
}

// CLI entry
if (process.argv[1]?.endsWith("backfill.js")) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    runBackfill(new Stripe(key), process.argv.includes("--write"))
      .then(() => pool.end())
      .catch((e) => { console.error(e); process.exit(1); });
}
