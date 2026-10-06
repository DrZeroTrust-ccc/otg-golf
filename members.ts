import { pool, logEvent } from "./db.js";
import { formatMemberNumber } from "./templates.js";

// Narrow view of the Stripe client so the smoke test can pass a fake.
type StripeForMembers = { customers: { update: (id: string, p: { metadata: Record<string, string> }) => Promise<unknown> } };

// Copy member numbers onto the Stripe customer, so they show in the Stripe dashboard.
// Runs from the ticker: picks up new members and anyone a previous run failed on.
export async function syncMemberNumbersToStripe(stripe: StripeForMembers, limit = 20): Promise<number> {
  const q = await pool.query(
    `select id, stripe_customer_id, member_number from players
      where member_number is not null and stripe_customer_id is not null and member_number_stripe_at is null
      order by member_number limit $1`,
    [limit]
  );
  let n = 0;
  for (const p of q.rows) {
    const num = formatMemberNumber(p.member_number) as string;
    try {
      await stripe.customers.update(p.stripe_customer_id, { metadata: { member_number: num } });
      await pool.query("update players set member_number_stripe_at = now() where id = $1", [p.id]);
      await logEvent(pool, "member_number.stripe_synced", { player_id: p.id, member_number: num });
      n++;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      console.error(`member number sync failed for ${p.stripe_customer_id}:`, err.message);
      // A customer Stripe doesn't have will never succeed; stop retrying it so it can't block the queue.
      if (err.code === "resource_missing") {
        await pool.query("update players set member_number_stripe_at = now() where id = $1", [p.id]);
        await logEvent(pool, "member_number.stripe_missing", { player_id: p.id, stripe_customer_id: p.stripe_customer_id, error: err.message ?? null });
      }
    }
  }
  return n;
}
