// Every automatic message's wording lives in this file. Edit the text here and redeploy.
// {{first_name}} is filled in at send time ("there" when we don't know the name).

const ADDRESS = "7144 Farm Station Rd, Vint Hill, VA 20187";
const PHONE = "(540) 340-9067";
const SIGNOFF = `Chase Cunningham\nOn The Green Indoor Golf\n${ADDRESS}\n${PHONE} | otg.golf`;

// Opening day comes only from the Render env var OPENING_DAY (e.g. 2026-12-05T14:00:00Z).
// Unset, blank or not a date means no date has been announced: every message says "opening soon"
// and founding members are not billed until it is set (see alignFoundingTrials).
export function openingDay(): Date | null {
  const raw = process.env.OPENING_DAY?.trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function openingText(withYear = false): string | null {
  const d = openingDay();
  return d ? d.toLocaleDateString("en-US", { month: "long", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "America/New_York" }) : null;
}

const openingLine = () => {
  const open = openingText();
  return open ? `We open ${open} at ${ADDRESS}.` : `We're opening soon at ${ADDRESS}, and I'll let you know the date as soon as it's set.`;
};

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

// Member numbers are stored as plain integers and always shown as OTG-0001.
export const formatMemberNumber = (n: number | null | undefined) => (n ? `OTG-${String(n).padStart(4, "0")}` : null);

// "Where things stand" in the welcome email. Edit this line as the build moves along; once
// OPENING_DAY is set the welcome names the date instead.
const CLUB_STATUS = "construction is in its final stretch and we're planning a soft open in December. I'll email you the date as soon as it's set.";

function clubUpdate(open: string | null): string {
  return [
    "Here's where things stand and what's coming:",
    "",
    `- Opening: ${open ? `we open ${open}.` : CLUB_STATUS}`,
    "- The bays: four bays on Foresight Sports simulators, plus a PuttView putting green you can reserve. Bay 1 is our Premier bay, set aside for members.",
    `- Booking from your phone: our member app at go.otg.golf/book. Sign in with a code sent to your phone, book a bay, and tap "I'm here" when you arrive.${open ? "" : " Booking opens once we have an opening date."}`,
    "- Early starts: members can ask to start up to an hour before we open.",
    "- Swing coaching: we're building swing analysis into the Premier bay, starting with a tempo check. More on this soon.",
    "- Events: private bays, team outings and full-club buyouts for up to 24 guests. Reply to this email if you'd like to plan one.",
  ].join("\n");
}

export function memberWelcome(tier: string, annual: boolean, memberNumber?: number | null): Msg {
  const label = tierLabel(tier, annual);
  const num = formatMemberNumber(memberNumber);
  const open = openingText();
  const billing = tier === "founding"
    ? (open
        ? `Your card is saved and nothing has been charged. Billing starts on opening day, ${open}.`
        : "Your card is saved and nothing has been charged. Billing starts on opening day, and I'll tell you the date before anything is charged.")
    : "Stripe has emailed your receipt separately.";
  const closing = open
    ? `We open ${open} at ${ADDRESS}. If you'd like a look around before then, reply and I'll set up a time.`
    : `We're opening soon at ${ADDRESS}. If you'd like a look around before then, reply and I'll set up a time.`;
  return {
    subject: tier === "founding" ? "Welcome to the club: you're a founding member of On The Green" : `Welcome to the club: your On The Green ${label}`,
    text:
`Hi {{first_name}},

Welcome to the club. Your ${label} is confirmed${tier === "founding" ? ", and you're one of just 40 founding members" : ""}.
${num ? `\nYour member number is ${num}. Keep it handy: it's how we'll find you at the front desk and when you book.\n` : ""}
${billing}

${TIER_PERKS[tier] ?? ""}

${clubUpdate(open)}

${closing}

${SIGNOFF}`.replace(/\n{3,}/g, "\n\n"),
    sms: `On The Green: Welcome to the club, {{first_name}}! Your ${label} is confirmed${num ? ` (member number ${num})` : ""}. ${open ? `We open ${open}.` : "We're opening soon."} We've emailed you what's coming. Questions? Call or text ${PHONE}. Reply STOP to opt out.`,
  };
}

// For members who joined before member numbers existed, so their welcome didn't carry one.
export function memberNumberNotice(tier: string | null, memberNumber: number): Msg {
  const label = tier ? tierLabel(tier) : "membership";
  const num = formatMemberNumber(memberNumber);
  return {
    subject: `Your On The Green member number: ${num}`,
    text:
`Hi {{first_name}},

Thank you again for joining On The Green. Your ${label} is confirmed, and your member number is ${num}.

Keep it handy: it's how we'll find you at the front desk and when you book. You don't need to do anything else.

${openingLine()} If you have any questions, reply to this email.

${SIGNOFF}`,
  };
}

export function waitlistConfirmation(): Msg {
  return {
    subject: "You're on the On The Green founding waitlist",
    text:
`Hi {{first_name}},

Thanks for signing up for a founding membership. All of our founding seats were taken before your signup came through, so you're on the waitlist and your card has not been charged.

If a founding seat opens up, I'll contact you before anything is charged. In the meantime, Full and Weekday memberships are open at otg.golf/memberships, and you're welcome to reply to this email with any questions.

${SIGNOFF}`,
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

${openingLine()} If you have any questions, reply to this email.

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
export function ownerNewMember(tier: string, annual: boolean, seat?: string, memberNumber?: number | null): Msg {
  const label = tierLabel(tier, annual);
  const num = formatMemberNumber(memberNumber);
  return {
    subject: `New ${label}: {{name}}${num ? ` (${num})` : ""}`,
    text: `New ${label}.\n\n{{contact}}${num ? `\nMember number: ${num}` : ""}${seat ? `\n${seat}` : ""}\n\nA personal note or call today goes a long way.`,
    sms: `OTG: New ${label} - {{name}}${num ? ` (${num})` : ""}${seat ? `. ${seat}` : ""}`,
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

// ---- customers: bay bookings -------------------------------------------------

const BOOK_URL = () => `${process.env.PUBLIC_BASE_URL ?? "https://otg-ops.onrender.com"}/book`;

export function bookingConfirmed(b: { bay: string; when: string; priceCents: number; guests: number; early?: boolean }): Msg {
  const paid = b.priceCents ? `Paid: ${money(b.priceCents)}. Stripe has emailed your receipt separately.` : "Included in your membership.";
  return {
    subject: `Booked: ${b.bay}, ${b.when}`,
    text:
`Hi {{first_name}},

${b.early ? "Your early start is approved. We'll have the doors open for you." : "You're booked at On The Green."}

${b.bay}
${b.when}
Players: ${b.guests + 1}
${paid}

To see or cancel your booking: ${BOOK_URL()}
Paid bookings cancelled at least 24 hours ahead are refunded in full.

See you at ${ADDRESS}.

${SIGNOFF}`,
    sms: `OTG: ${b.early ? "Early start approved" : "You're booked"}. ${b.bay}, ${b.when}. Tap "I'm here" in the app when you arrive. Manage it at ${BOOK_URL()}`,
  };
}

export function bookingReminder(b: { bay: string; when: string }): Msg {
  return { subject: `Reminder: ${b.bay}, ${b.when}`, text: `See you soon: ${b.bay}, ${b.when}.`, sms: `OTG: See you soon. ${b.bay}, ${b.when}. When you arrive, tap "I'm here" at ${BOOK_URL()}` };
}

export function bookingCancelled(b: { bay: string; when: string; refundCents: number; byStaff: boolean }): Msg {
  const refund = b.refundCents ? `We've refunded ${money(b.refundCents)}; it shows on your card in 5 to 10 days.` : "";
  return {
    subject: `Cancelled: ${b.bay}, ${b.when}`,
    text:
`Hi {{first_name}},

${b.byStaff ? "We've cancelled" : "You cancelled"} your booking: ${b.bay}, ${b.when}. ${refund}

Book again any time at ${BOOK_URL()}

${SIGNOFF}`,
    sms: `OTG: Booking cancelled. ${b.bay}, ${b.when}.${b.refundCents ? ` Refund: ${money(b.refundCents)}.` : ""}`,
  };
}

export function ownerBookingConflict(b: { bay: string; when: string; checkout: string }): Msg {
  return {
    subject: `Booking needs you: paid after the hold ran out (${b.bay}, ${b.when})`,
    text: `Someone paid for ${b.bay}, ${b.when}, but the slot was taken after their hold expired. Refund them in Stripe (checkout ${b.checkout}) or move them to another bay from the staff screen.`,
    sms: `OTG: Paid booking clash on ${b.bay}, ${b.when}. Check the staff screen.`,
  };
}

export function earlyRequested(b: { bay: string; when: string }): Msg {
  return {
    subject: `Early start requested: ${b.bay}, ${b.when}`,
    text: `Hi {{first_name}},\n\nWe have your request for an early start: ${b.bay}, ${b.when}. Someone needs to be here to open up, so we'll confirm by text as soon as we can.\n\n${SIGNOFF}`,
    sms: `OTG: Got your early start request for ${b.bay}, ${b.when}. We'll text you once it's confirmed.`,
  };
}

export function earlyDeclined(b: { bay: string; when: string }): Msg {
  return {
    subject: `Early start not available: ${b.bay}, ${b.when}`,
    text: `Hi {{first_name}},\n\nSorry, we can't open early for ${b.bay}, ${b.when}. Book a time after opening at ${BOOK_URL()}\n\n${SIGNOFF}`,
    sms: `OTG: Sorry, we can't open early for ${b.bay}, ${b.when}. Book another time at ${BOOK_URL()}`,
  };
}

export function ownerEarlyRequest(r: { name: string | null; number: string | null; bay: string; when: string; staffUrl: string }): Msg {
  const who = `${r.name || "A member"}${r.number ? ` (${r.number})` : ""}`;
  return {
    subject: `Early start request: ${who}, ${r.when}`,
    text: `${who} asked for an early start: ${r.bay}, ${r.when}.\n\nApprove or decline it on the staff screen: ${r.staffUrl}\nIf nobody answers, it lapses at the start time.`,
    sms: `OTG: Early start request - ${who}, ${r.bay}, ${r.when}. Approve on the staff screen.`,
  };
}

export function noShowNotice(b: { bay: string; when: string; feeCents: number; minutes: number }): Msg {
  const fee = b.feeCents ? ` A ${money(b.feeCents)} missed-booking fee will be added to your next membership bill.` : "";
  return {
    subject: `We missed you: ${b.bay}, ${b.when}`,
    text: `Hi {{first_name}},\n\nWe didn't see you check in within ${b.minutes} minutes for ${b.bay}, ${b.when}, so we released the bay to other players.${fee}\n\nIf you're here, open the app and tap "I'm here". If the bay is still free, we'll put your booking back and drop the fee.\n\n${SIGNOFF}`,
    sms: `OTG: We released ${b.bay} (${b.when}) after ${b.minutes} min with no check-in.${b.feeCents ? ` ${money(b.feeCents)} fee applies.` : ""} Here now? Tap I'm here in the app.`,
  };
}
