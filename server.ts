import express from "express";
import Stripe from "stripe";
import { pool, logEvent } from "./db.js";
import { onCustomer, onSubscription, onCheckoutCompleted, onInvoicePaymentFailed, onSetupCompleted } from "./stripeHandlers.js";
import { mountRoutes } from "./routes.js";
import { mountInquiries, nudgeStaleInquiries } from "./inquiries.js";
import { syncMemberNumbersToStripe, queueMemberNumberNotices } from "./members.js";
import { dispatchOutbox, kickOutbox } from "./notify.js";

const app = express();
// Never let a stray promise rejection take the service down; log it and keep serving.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
// Trimmed: a stray space or newline pasted into Render must never break Stripe again.
const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
const whSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
const stripe = stripeKey ? new Stripe(stripeKey) : null;
mountRoutes(app);
mountInquiries(app);

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
    kickOutbox(); // send anything the handlers queued, without delaying Stripe's response
    setTimeout(kickOutbox, 25_000).unref(); // and pick up the messages that are held back briefly
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
  // Once a minute: retry anything unsent, re-alert on event inquiries nobody has answered,
  // email member numbers to members whose welcome didn't carry one, and copy numbers onto Stripe.
  setInterval(() => {
    void (async () => {
      try { await nudgeStaleInquiries(); } catch (e) { console.error("nudge failed:", (e as Error).message); }
      try { await queueMemberNumberNotices(); } catch (e) { console.error("member number notices failed:", (e as Error).message); }
      if (stripe) try { await syncMemberNumbersToStripe(stripe); } catch (e) { console.error("member number sync failed:", (e as Error).message); }
      await dispatchOutbox();
    })();
  }, 60_000).unref();
}
export { app };
