// Every automatic message's wording lives in this file. Edit the text here and redeploy.
// {{first_name}} is filled in at send time ("there" when we don't know the name).

const ADDRESS = "7144 Farm Station Rd, Vint Hill, VA 20187";
const PHONE = "(540) 340-9067";
const SIGNOFF = `Chase Cunningham\nOn The Green Indoor Golf\n${ADDRESS}\n${PHONE} | otg.golf`;

export function openingText(): string {
  const d = new Date(process.env.OPENING_DAY ?? "2026-11-09T14:00:00Z");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
}

export const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export type Msg = { subject: string; text: string; sms?: string };

// ---- customers: memberships ---------------------------------------------------

const TIER_LABEL: Record<string, string> = {
  founding: "Founding Membership", full: "Full Membership", weekday: "Weekday Membership", corporate: "Corporate Membership",
};
const TIER_PERKS: Record<string, string> = {
  founding: "Your founding rate is locked for life, and you get the lounge and lockers, 12 guest passes a year and priority booking.",
  full: "You get unlimited play, 6 guest passes a year and booking up to 14 days ahead.",
  weekday: "You get play Monday through Thursday, 10am to 6pm, and 4 guest passes a year.",
};
export const tierLabel = (tier: string, annual = false) => (TIER_LABEL[tier] ?? "Membership") + (annual ? " (annual)" : "");

export function memberWelcome(tier: string, annual: boolean): Msg {
  const label = tierLabel(tier, annual);
  const open = openingText();
  const billing = tier === "founding"
    ? `Your card is saved and nothing has been charged. Billing starts on opening day, ${open}.`
    : "Stripe has emailed your receipt separately.";
  return {
    subject: tier === "founding" ? "You're a founding member of On The Green" : `Welcome to On The Green: your ${label}`,
    text:
`Hi {{first_name}},

Thank you for joining On The Green. Your ${label} is confirmed.

${billing}

${TIER_PERKS[tier] ?? ""}

We open ${open} at ${ADDRESS}. Before then I'll send you how to book your first bay. If you'd like a look around before we open, reply to this email and I'll set up a time.

${SIGNOFF}`.replace(/\n{3,}/g, "\n\n"),
    sms: `On The Green: Welcome, {{first_name}}! Your ${label} is confirmed. We open ${open}. Questions? Call or text ${PHONE}. Reply STOP to opt out.`,
  };
}

// ---- customers: one-time purchases -------------------------------------------

const PRODUCT_LABEL: Record<string, string> = {
  opening_week_bay_hour: "Opening Week Bay Hour",
  winter_league_s1: "Winter League Season 1",
  coaching_bay_hour: "Coaching Bay Hour",
};
const PRODUCT_NEXT: Record<string, string> = {
  opening_week_bay_hour: "Your hour is prepaid. I'll be in touch before opening week to book your bay time.",
  winter_league_s1: "Your spot in the league is held. I'll send the schedule, your team details and the format before the season starts.",
  coaching_bay_hour: "Your coaching hour is prepaid. Reply to this email with the times that suit you and I'll book the bay.",
};
export const productLabel = (p: string) => PRODUCT_LABEL[p] ?? "purchase";

export function purchaseConfirmation(product: string, amountCents: number): Msg {
  const label = productLabel(product);
  return {
    subject: `Your On The Green ${label} is confirmed`,
    text:
`Hi {{first_name}},

Thank you. Your ${label} (${money(amountCents)}) is confirmed, and Stripe has emailed your receipt separately.

${PRODUCT_NEXT[product] ?? "I'll be in touch with the next steps."}

We open ${openingText()} at ${ADDRESS}. If you have any questions, reply to this email.

${SIGNOFF}`,
  };
}

// ---- customers: event inquiries ----------------------------------------------

export function inquiryReply(): Msg {
  return {
    subject: "We got your event inquiry at On The Green",
    text:
`Hi {{first_name}},

Thanks for asking about an event at On The Green. I have your details and will reply personally within one business day.

So you can start planning, these are our three packages:

- Private Bay, $150: 1 bay, up to 6 guests, 2 hours
- Half-Club, $500: 2 bays plus the lounge, up to 12 guests, 3 hours
- Full-Club Buyout, $1,200: all 4 bays, the PuttView putting green and the lounge, up to 24 guests, 3 hours

Catering from our local restaurant and brewery partners is available as an add-on.

If you haven't already told us, reply with your preferred date, start time and headcount and I'll confirm availability.

${SIGNOFF}`,
  };
}

// ---- owner alerts ------------------------------------------------------------

const who = (p: { name?: string | null; email?: string | null; phone?: string | null }) =>
  [p.name || "Unknown name", p.email, p.phone].filter(Boolean).join(" | ");

// {{name}} and {{contact}} are filled in at send time: Stripe often delivers the subscription a
// moment before the customer record that carries the name and email.
export function ownerNewMember(tier: string, annual: boolean, seat?: string): Msg {
  const label = tierLabel(tier, annual);
  return {
    subject: `New ${label}: {{name}}`,
    text: `New ${label}.\n\n{{contact}}${seat ? `\n${seat}` : ""}\n\nA personal note or call today goes a long way.`,
    sms: `OTG: New ${label} - {{name}}${seat ? `. ${seat}` : ""}`,
  };
}

export function ownerNewPurchase(p: { name?: string | null; email?: string | null; phone?: string | null }, product: string, amountCents: number): Msg {
  const label = productLabel(product);
  return {
    subject: `New order: ${label} (${money(amountCents)})`,
    text: `New order: ${label}, ${money(amountCents)}.\n\n${who(p)}`,
    sms: `OTG: New order - ${label} ${money(amountCents)} - ${p.name || p.email || "customer"}`,
  };
}

export function ownerInquiry(i: { name?: string | null; email?: string | null; phone?: string | null; package?: string | null; event_date?: string | null; guests?: string | null; message?: string | null }, doneUrl: string): Msg {
  const lines = [
    `Name: ${i.name ?? "-"}`, `Email: ${i.email ?? "-"}`, `Phone: ${i.phone ?? "-"}`,
    `Package: ${i.package ?? "-"}`, `Date: ${i.event_date ?? "-"}`, `Guests: ${i.guests ?? "-"}`,
    "", i.message ?? "(no message)",
  ];
  return {
    subject: `Event inquiry: ${i.name || i.email || "new lead"}${i.event_date ? ` for ${i.event_date}` : ""}`,
    text: `New event inquiry.\n\n${lines.join("\n")}\n\nReply to this email to answer them directly.\nOnce you've replied, mark it handled so you aren't reminded: ${doneUrl}`,
    sms: `OTG: Event inquiry - ${i.name || i.email || "new lead"}${i.guests ? `, ${i.guests} guests` : ""}${i.event_date ? `, ${i.event_date}` : ""}${i.phone ? `. ${i.phone}` : ""}`,
  };
}

export function ownerInquiryNudge(i: { name?: string | null; email?: string | null; phone?: string | null }, doneUrl: string): Msg {
  return {
    subject: `Reminder: event inquiry from ${i.name || i.email || "a lead"} is 24 hours old`,
    text: `This event inquiry has had no reply marked for 24 hours.\n\n${who(i)}\n\nMark it handled: ${doneUrl}`,
    sms: `OTG: Event inquiry from ${i.name || i.email || "a lead"} is 24h old with no reply marked.`,
  };
}

export function ownerPaymentFailed(p: { name?: string | null; email?: string | null; phone?: string | null }): Msg {
  return {
    subject: `Membership payment failed: ${p.name || p.email || "member"}`,
    text: `A membership payment failed and the membership is now past due.\n\n${who(p)}\n\nStripe will retry automatically. A quick call usually fixes it faster.`,
    sms: `OTG: Membership payment failed - ${p.name || p.email || "member"}`,
  };
}

export function ownerWaitlist(p: { name?: string | null; email?: string | null; phone?: string | null }): Msg {
  return {
    subject: `Founding seats are full: ${p.name || p.email || "someone"} joined the waitlist`,
    text: `All founding seats are taken. This person saved a card and was tagged waitlist; no subscription was created.\n\n${who(p)}`,
    sms: `OTG: Founding seats full. Waitlist: ${p.name || p.email || "someone"}`,
  };
}
