import express from "express";
import Stripe from "stripe";
import { pool, logEvent } from "./db.js";
import { onCustomer, onSubscription, onCheckoutCompleted, onInvoicePaymentFailed, onSetupCompleted } from "./stripeHandlers.js";
import { mountRoutes } from "./routes.js";

const app = express();
const stripeKey = process.env.STRIPE_SECRET_KEY;
const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeKey ? new Stripe(stripeKey) : null;
mountRoutes(app);

app.get("/health", async (_req, res) => {
  try { await pool.query("select 1"); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

// Raw body is required for signature verification. Parse nothing before verifying.
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !whSecret) return res.status(500).send("stripe not configured");
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, whSecret);
  } catch (e) {
    return res.status(400).send(`signature failed: ${(e as Error).message}`);
  }

  const client = await pool.connect();
  try {
    // Idempotency: the event id is the primary key. A duplicate is acknowledged and ignored.
    const seen = await client.query(
      "insert into stripe_events (id, type) values ($1, $2) on conflict (id) do nothing returning id",
      [event.id, event.type]
    );
    if (!seen.rowCount) return res.status(200).send("duplicate");

    await client.query("begin");
    await handle(client, event, stripe);
    await client.query("update stripe_events set processed_at = now() where id = $1", [event.id]);
    await client.query("commit");
    return res.status(200).send("ok");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    const msg = (e as Error).message;
    // Clear the seen-marker so Stripe's retry can process it again.
    await pool.query("update stripe_events set error = $2 where id = $1", [event.id, msg]).catch(() => {});
    await pool.query("delete from stripe_events where id = $1 and processed_at is null", [event.id]).catch(() => {});
    console.error(`webhook ${event.id} ${event.type} failed: ${msg}`);
    return res.status(500).send("error");
  } finally {
    client.release();
  }
});

export async function handle(client: import("pg").PoolClient, event: Stripe.Event, s: Stripe) {
  switch (event.type) {
    case "customer.created":
    case "customer.updated":
      return onCustomer(client, event.data.object as Stripe.Customer);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return onSubscription(client, event.data.object as Stripe.Subscription);
    case "checkout.session.completed": {
      const sess = event.data.object as Stripe.Checkout.Session;
      if (sess.mode === "setup") {
        const full = await s.checkout.sessions.retrieve(sess.id, { expand: ["setup_intent"] });
        return onSetupCompleted(client, full, s);
      }
      let priceId: string | null = null;
      let productId: string | null = null;
      try {
        const items = await s.checkout.sessions.listLineItems(sess.id, { limit: 1 });
        const price = items.data[0]?.price;
        priceId = price?.id ?? null;
        productId = typeof price?.product === "string" ? price.product : price?.product?.id ?? null;
      } catch (e) {
        await logEvent(client, "checkout.line_items_unavailable", { checkout: sess.id, error: (e as Error).message });
      }
      return onCheckoutCompleted(client, sess, priceId, productId);
    }
    case "invoice.payment_failed":
      return onInvoicePaymentFailed(client, event.data.object as Stripe.Invoice);
    default:
      return; // recorded in stripe_events, otherwise ignored
  }
}

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`otg-ops listening on ${port}`));
}
export { app };
