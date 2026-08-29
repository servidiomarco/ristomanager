# Risto — product context for the marketing site

Written 10 August 2026, from the RistoManager application repository. Copy this file into the marketing website repo (suggested path: `docs/product-context.md`) so whoever writes the site — human or agent — is working from what the product actually does rather than from memory.

Everything below is derived from the shipped code: the route table, the database schema, the permission map, the component tree. Where something is planned rather than built, it is marked. **Nothing here should be softened when it moves onto the website, and nothing should be added that isn't here.** This market talks to itself and the first demo call kills any claim the product can't hold.

---

## 1. What Risto is, in one paragraph

Risto is a restaurant operating system: one live system covering the whole service, from the moment a guest calls to book through to the bill being paid, plus the back-of-house work that surrounds it. It runs bookings, a floor plan, reception and arrivals, table orders, kitchen and pass displays, payments (including pay-at-table by QR), stock, purchasing, HACCP, staff scheduling, and every inbound channel — phone, WhatsApp, SMS, email — in one place. An AI voice agent answers the restaurant's phone line and books tables against the same live availability the floor plan uses. It runs in a browser on hardware the restaurant already owns, and it sits alongside the restaurant's existing cash register instead of replacing it.

**The proof:** it runs full service every day at a working restaurant (Il Vecchio Frantoio). It is not a prototype and it is not a pitch-deck product. Features exist because a shift needed them.

---

## 2. Status — read this before writing any claim

| Fact | Implication for the site |
|---|---|
| **In production at one restaurant.** Single tenant. There is no venue separation in the data model. | Do not sell "multi-venue" as shipping. Either build it first or label the column "in preparation". |
| **The app interface is Italian only.** There is no i18n framework, no translation files, no language switcher. Every string is hardcoded Italian. | "Italian and English today" is true of the *voice agent*, not of the app. Say so precisely, or say "Italian today, English in progress". |
| **The AI voice agent speaks Italian and English.** English is enabled on the ElevenLabs agent with automatic language detection and a dedicated English greeting. Spanish and Greek are not built. | Safe to claim Italian + English on the phone. Spanish and Greek are "in progress" at best. |
| **Till integration is Passepartout Menù only**, over the restaurant's own LAN via SOAP. Tilby, Cassa in Cloud, Toast: not built. | "Works with your existing till" needs the honest qualifier that Passepartout is the integration that exists today, with others to follow. |
| **Automated tests are an API smoke suite only** (Vitest + supertest, run against the compiled server on a throwaway Postgres, gated in CI alongside typecheck and both builds). There are no frontend or unit tests. | Never a public claim either way. Reliability comes from a year of real service, not from a suite — but "no tests at all" is no longer accurate if anyone asks in a technical review. |
| **No pricing exists yet.** | The plans table on the site is a proposal, not a published price list. |
| **GDPR consents are captured with timestamps; a privacy notice and a compliance checklist exist as documents.** No DPA, no certification. | "GDPR-shaped from day one" is fair. "Compliant" and "certified" are not. |

---

## 3. How it's built — only the parts that matter to marketing

- **Frontend:** React 19 single-page app, TypeScript, Tailwind v4, Vite. Deployed on Vercel at `crm.vecchiofrantoio.com`.
- **Backend:** Node/Express + Socket.IO + PostgreSQL. Deployed on Railway. Roughly 260 API routes, 56 database tables.
- **Real-time is the spine, not a feature.** Domain state (reservations, tables, rooms, dishes, banquets) is loaded once and thereafter kept in sync by Socket.IO events. A change made on one device appears on every other device in the building in the same second, without a refresh. This is what makes the "live on every screen" claim structurally true rather than marketing language.
- **Progressive web app.** Installs to a phone or tablet home screen without an app store. Web push notifications, app badge counts.
- **Works when the network doesn't.** Write operations queue in local storage while offline and flush on reconnect.
- **No hardware requirement.** Any phone, tablet, laptop, or TV with a browser. The only optional hardware is a thermal printer (ESC/POS over TCP) and a small local print agent that bridges it.
- **Server-enforced permissions.** Role-based access is enforced in middleware on every route, not just hidden in the interface. A waiter cannot reach revenue data by being curious.
- **Time is always Europe/Rome**, handled explicitly, because date-boundary bugs in a booking system are expensive.

---

## 4. Feature inventory, module by module

There are 22 top-level screens. Grouped below by what a restaurateur would recognise.

### 4.1 Reservations

The booking book. One list, one source of truth, live on every device.

- Bookings by date and shift (lunch / dinner), with guest count, children, table assignment, room, notes, allergens, and source.
- **Booking sources are tracked and tagged:** manual (staff), WhatsApp, voice agent, and the public web form (linked from the restaurant's Google Business profile). So the restaurant can see which channel actually fills the room.
- **Reservation state is two-layered and advances on its own.** The persisted state (pending, confirmed, declined, no-show, cancelled) is enriched by the clock: a confirmed booking reads as "arriving" from 20 minutes before its time, and a seated party past its expected duration reads as "leaving". Nobody has to update anything for the list to be current.
- The colour of a state is defined once and is identical everywhere it appears — list chips, reception badges, table glyphs, dashboard counters.
- **Confirmations** sent by WhatsApp, SMS, or email, with delivery status recorded. Free-form emails to a guest from a composer, wrapped in the restaurant's branded template.
- **Deposits.** Take a deposit on a booking via a payment link; an auto-deposit policy can require one automatically above a guest threshold on public web bookings.
- Guest allergens and dietary notes pre-fill from the customer record onto every new booking.
- Table swap between two reservations as one atomic operation.
- Printable service sheets for the day.
- Full message history per reservation across every channel.

### 4.2 Floor plan

A drawn plan of the actual rooms, not a list of table numbers.

- Rooms and tables with real positions, shapes, seat counts, and min/max party sizes.
- Table state is colour, and it is the same colour language used everywhere else in the system.
- **Per-shift overrides, valid for one service only and self-reverting:**
  - **Merge** tables for a large party (with overlap and conflict checks).
  - **Hide** a table for tonight — refused if it already has a booking or is inside an active merge.
  - **Close a whole room** for a shift — refused if there are live bookings in it, so the operator has to reassign first rather than discover the problem at eight o'clock.
- Double-booking the same table in the same shift is refused at the API, not detected later.
- **Per-room occupancy caps.** The operator can reserve a percentage of each room for human channels (phone, walk-in, staff-entered). Once a room hits the cap, the voice agent and the public booking form stop offering it. Staff booking from the system are never limited by it.

### 4.3 Reception and arrivals

The host stand screen.

- An arrivals timeline for the service.
- Four arrival states: waiting, arrived, departing, table freed.
- Swipe-to-check-in on a phone.
- The guest's history, VIP flag, preferred table, and allergies are on screen as they walk in.

### 4.4 Orders (the handheld)

Waiters take orders at the table, one-handed, on the phone in their pocket.

- Table grid → order sheet → dish browser, built for standing use with 44px minimum touch targets.
- **Courses.** Every line belongs to a course, so the kitchen fires the table together rather than plate by plate.
- Per-seat assignment, modifiers with price deltas, free-text notes per line.
- Cover charges and service lines are separate line kinds — they never go to the kitchen but they weigh on the bill.
- Discounts by percentage or amount, with a reason.
- Voids require a reason once the line has been sent to the kitchen.
- Transfer an order between tables.
- Multiple price lists (e.g. a different list for events).
- Takeaway as well as dine-in.

### 4.5 Kitchen display and the pass

- **Stations.** Menu categories route to kitchen stations, so each station sees only its own queue, in type readable from a metre away.
- **Line states run the full path:** draft → queued → sent → preparing → ready → served, with timestamps at each transition. A plate sitting too long flags itself.
- **Expediter (pass) screen.** The whole table's course in one view — the view that stops three stations working blind to each other.
- **Three fire modes:** everything fires automatically, only the first course fires automatically, or fully manual (used for banquets).
- Call, fire, recall, and re-fire a course.
- **Thermal printing.** Print routes per station, printer management, a test print, and a job queue with retries. A local print agent polls the queue and drives ESC/POS printers over the restaurant's LAN, so cloud hosting doesn't prevent a ticket printing in the kitchen.
- **Sala profiles** — saved configurations of stations, routes, and printers, activated as a set.

### 4.6 Payments

- **Pay at table by QR.** The guest scans, sees their bill on their own phone, pays. No app, no login, no account.
- **Splitting three ways:** equal share, a fixed amount the guest chooses, or by item.
- Claims are held with a short TTL and reconciled automatically, so two guests can't pay the same share and an abandoned claim releases itself.
- **Card payments through Revolut or SumUp**, selectable per venue.
- **Payment links** sent by WhatsApp or SMS for deposits and events.
- Refunds — full refunds of a payment request, and partial refunds of an individual split — with the gateway called before anything is written locally.
- Webhook receivers for both gateways with signature verification, plus a manual reconcile that polls the gateway when a webhook was missed, and a background reconciler every two minutes.
- **On payment, the order is closed in the restaurant's existing Passepartout till.** Fiscal closure stays where the accountant expects it.
- A payments screen with open bills, a period picker, search, status filters, and an unseen-takings badge.

### 4.7 The AI voice host

This is the differentiator, and the exact shape of the claim matters.

- An ElevenLabs voice agent answers the restaurant's phone line and holds a natural conversation.
- **It calls back into Risto mid-conversation to do real work.** The tools it has: check availability, create a reservation, modify a reservation, cancel a reservation, look up a customer.
- **Availability is the live floor plan** — the restaurant's opening hours, the special closures, the rooms closed tonight, the tables genuinely free, the occupancy caps. The agent cannot give away a table that doesn't exist. **This is the structural claim: a standalone phone-answering service can't do it, because it doesn't own the floor plan.**
- Every call is recorded, transcribed, and summarised.
- A call that didn't end in a booking becomes a follow-up task, with a "to call back" / "called back" queue, notes, and one-click booking from the call.
- Calls are matched to customer records by phone number.
- The agent can be switched off entirely, or suspended on a schedule, so humans answer.
- Italian and English, with automatic language detection.

**Never write "the first" or "the only".** Roughly ten funded vendors sell restaurant phone agents in the US, and an informed buyer or investor will know. The defensible sentence is the availability one.

### 4.8 Inbound communications

Everything a guest sends arrives in the same building.

- **WhatsApp** — two providers wired (Vonage and Twilio), inbound webhooks, delivery and read receipts, and Meta's 24-hour customer-service window enforced server-side so the interface can show a "window closed" banner rather than silently failing.
- **SMS** — inbound and outbound.
- **Email** — inbound via Resend webhooks with signature verification, and via IMAP for a normal mailbox; outbound over the restaurant's own SMTP. Threaded by address.
- Conversations grouped by phone number, unread counts, per-thread read state.
- Outbound message history attached to the reservation and to the payment it relates to.

### 4.9 Customers (CRM)

- Contact record: name, phone, email, address.
- VIP flag, preferred table, preference notes, and allergy/dietary notes that pre-fill onto every future booking.
- Visit history — every booking and every banquet the customer has had.
- No-show counter, updated when a booking is closed as a no-show.
- **Duplicate detection and merge.** Customers sharing the last ten digits of a phone number are surfaced as a group and can be consolidated; saving a customer with an existing number offers merge or open instead of creating a second record.
- Marketing audience export, gated on recorded consent.
- **GDPR consents captured at booking time with a timestamp** — marketing consent and health-data consent (allergies are health data) recorded separately.

### 4.10 Banquets and events

- An event menu per booking: courses, dishes, price per person, children's price, guest and children counts.
- Separate notes for the courses, the service, and the mise en place.
- Deposits and balance payments, with method and type recorded, and a payment status per event.
- Price visibility and payment management are separate permissions from the rest.
- Automatic kitchen reminder tasks generated ahead of an event.
- Printable event sheets.

### 4.11 Menu

- Dishes with categories, allergens, dietary tags, descriptions, images.
- Modifier groups and modifiers with price deltas.
- Multiple price lists.
- Category-to-station routing that drives the kitchen displays.

### 4.12 Inventory

- Products, categories, and locations across kitchen, floor, and bar areas.
- Stock levels per product per location.
- Movements with reasons — the audit trail of what moved and why.
- Low-stock view.
- Suppliers.
- Printable stock sheets.

### 4.13 Purchasing / shopping list

- A shared list the whole team adds to during service, from any device.
- Categories, quantities, supplier assignment.
- **Grouped by supplier**, so it splits into the calls that actually have to be made.
- Check off, clear checked, undo.
- Printable.
- A recurring daily bread reminder at 20:00.

### 4.14 HACCP

The five records an inspector asks for, filled in on a phone instead of on paper the day before an inspection.

1. **Temperature readings** (fridges, freezers, hot holding).
2. **Frying oil checks.**
3. **Cleaning checks.**
4. **Goods-in receipts.**
5. **Production logs.**

Each with a date, an operator, and values; the whole set printable as a report.

### 4.15 Staff

- Staff records: name, category, staff type, role, contact, hire date, contract end date (seasonal staff).
- **Shifts per service** — lunch and dinner separately, with bulk assignment.
- Attendance (present / not present per shift).
- **Time off in four kinds:** rest day, holiday, sick leave, and permitted absence — full day or a single shift, with an approval flag.
- A presence view for who is in today.

### 4.16 Tasks and reminders

- Team tasks with category, priority, assignee, and due date.
- **Assignment respects the hierarchy** — you can assign to peers or below, never up the ladder.
- A personal "my tasks" view.
- Scheduled reminders.

### 4.17 Notifications

- In-app notification centre with unread counts and per-category badges.
- **Web push** to phones, so a booking taken at eleven at night reaches whoever is on call.
- App icon badge counts on installed devices.

### 4.18 Dashboard

- Today's service at a glance: covers, bookings by shift, arrival progress, room-by-room occupancy.
- An hourly and weekly footfall view.
- Tasks and shopping list inline.
- An AI-written summary report of the day's data (Google Gemini).

### 4.19 Settings and administration

- **Opening hours** per day with bookable slots, plus the ability to disable individual slots.
- **Special closures** — one-off dates the restaurant is shut, respected by the voice agent and the public booking form.
- Booking channel toggles (voice agent on/off, public bookings on/off).
- Room occupancy caps.
- Integration configuration: SMTP, IMAP, Revolut, SumUp, payment provider choice, pay-at-table settings.
- Reservation note and allergen presets.
- Legal settings (privacy notice text and consent copy).
- **Activity log** — a record of who changed what, across the whole system.
- User management, role management, and a per-role permission matrix.
- An internal development board (Kanban), gated by account rather than by role.

### 4.20 Public-facing surfaces

- **A public booking page** (`/prenota`, and `/prenota/<slug>` per restaurant), designed to be linked from the restaurant's Google Business profile. A two-step flow: party size and children, a date picked from a week strip that opens into a month calendar, room preference, and a time slot — then name, contact, allergies and consent. It respects opening hours, closures, occupancy caps, and can be switched off from Settings without a redeploy.
  - **The calendar shows each day's state before the guest picks it** — open, nearly full, or closed — so a full Saturday is visible without clicking into it. Booking horizon is 60 days.
  - **The guest is told before submitting whether the table is confirmed or requested.** Rooms under their occupancy cap self-confirm; a room that is nearly full becomes a request the staff approve, and the page says so on the room the guest has chosen. The label is computed from the same data that decides the real outcome, so the two cannot disagree.
  - **The restaurant brands it**: its own logo, its own header colour, its address and phone shown as links. Text colour on the header is derived from the chosen colour, so a pale brand colour cannot produce unreadable text. Unset fields fall back to a neutral default.
- **The pay-at-table page** (`/pay/:token`), reachable without login, rate-limited, with a publicly fetchable QR image so the bill link can be sent into a chat.
- A public availability API behind both, serving both a single day's slots and a date range for the calendar.

---

## 5. Roles

Six roles, each with a server-enforced permission set.

| Role | What they get |
|---|---|
| **Owner** | Everything, including revenue, logs, users, settings, and event pricing. |
| **General manager** | Everything operational plus reports and event payments; not user or system settings. |
| **Manager** | The service, staffing, stock, customers, and reports; not event pricing or full payments. |
| **Reception** | Bookings, customers, arrivals, the floor plan, calls, payment visibility. Cannot take orders. |
| **Waiter** | Bookings, arrivals, the floor plan, customer lookup, and taking orders. No revenue, no kitchen queue. |
| **Kitchen** | The kitchen queue, the pass, the menu, stock, and the day's bookings. Nothing guest-facing or financial. |

Taking orders, working a station queue, and firing a course are three separate permissions on purpose: firing is a coordination decision that touches every station, while working a queue only authorises a cook to work their own.

---

## 6. Integrations that exist today

| Category | Integration |
|---|---|
| Till / POS | **Passepartout Menù** (SOAP over the restaurant's LAN — reads the open order on a table, closes it when the guest pays) |
| Voice | **ElevenLabs** conversational agent with five server-side tools |
| WhatsApp | **Vonage** and **Twilio** |
| SMS | via the same providers |
| Email in | **Resend** inbound webhooks, and **IMAP** for a standard mailbox |
| Email out | the restaurant's own **SMTP** |
| Card payments | **Revolut** and **SumUp** |
| Push | **Web Push (VAPID)** |
| AI summaries | **Google Gemini** |
| Printing | **ESC/POS thermal printers** over TCP, via a local print agent |

---

## 7. What is not built

State these as roadmap or leave them off the site entirely. Do not imply them.

- **Multi-venue / multi-tenant.** One restaurant per installation today.
- **Any till other than Passepartout.** Tilby, Cassa in Cloud, and Toast are not integrated.
- **A translated interface.** The app is Italian only.
- **Spanish and Greek**, anywhere.
- **Delivery and takeaway aggregators** (Deliveroo, Glovo, JustEat).
- **Accounting or payroll export.**
- **Loyalty programmes, gift cards, marketing campaign sending.**
- **Forecasting, labour cost, or food cost analytics** — the back-office layer Nory and Restaurant365 sell.
- **A native mobile app.** It is a PWA, which is a strength, but it isn't in the App Store.
- **A self-service signup.** Every restaurant is onboarded by hand today.

---

## 8. Language and tone rules the site inherits

These come from the product's design system and should carry over, because the site and the product should sound like the same company.

- **Never set anything in capitals.** Not headings, not buttons, not labels. Word shapes disappear at small sizes, screen readers spell short capitalised strings out letter by letter, and Italian accented capitals degrade (`PIÙ` renders as `PIU`). This holds even when a mockup shows caps.
- **Cut copy to the shortest thing that still works.** Say each thing once. Drop reassurance sentences — "you can always change it later" carries no information and costs a line.
- **No superlatives that can be checked and lost:** first, only, revolutionary, percentages, customer counts. Not one of them survives a demo call in this market.
- **Name the mechanism, not the adjective.** "It books against the same live availability the floor plan uses" beats "powerful AI".

---

## 9. Brand and visual language

The product's design system lives at `docs/risto-design-system.md` in the application repo — 1,200 lines, and the source of truth for the app. The marketing site does not have to look like the app, but the colours below are the product's, and using them keeps a screenshot from looking like a foreign object on the page.

- **Ink** `#111827` — the primary action colour, near-black.
- **Indigo** `#5250C9` — dinner service, imminent arrival, progress.
- **Amber** `#B8860B` / `#966D09` — lunch service, pending, attention.
- **Green** `#316648` — seated, in service, live, ok.
- **Red** `#C0392B` — critical, out of stock, destructive.
- **Neutrals** from `#FFFFFF` through `#111113`, with `#EDEDF1` as the page canvas — deliberately darker than the cards that sit on it.

Colour carries meaning in this product: service (lunch vs dinner), state (seated, arriving, pending, critical), and severity. Both light and dark themes exist, with WCAG 2.2 AA as the floor throughout.

---

## 10. Vocabulary

Italian terms appear in every screenshot. Map them consistently on an English site.

| Italian | English |
|---|---|
| Prenotazioni | Reservations / bookings |
| Sala | Dining room / floor |
| Comande | Orders (the handheld) |
| Cucina | Kitchen display |
| Passe | Pass / expediter |
| Reception | Reception, arrivals |
| Pranzo / Cena | Lunch / dinner (the two shifts) |
| Turno | Service, shift |
| Coperti | Covers |
| Uscita | Course (as fired from the pass) |
| Conto | Bill |
| Preconto | Pre-bill / check |
| Acconto / caparra | Deposit |
| Banchetto | Banquet, event |
| Lista della spesa | Shopping / purchasing list |
| Inventario | Stock |
| Attività | Tasks |
| Conversazioni | Calls and conversations |
| Clienti | Customers, guests |

---

## 11. Existing documents worth reading

All in the application repo, under `docs/`:

- **`landing-page-draft-en-v2.md`** — a full English landing page draft with positioning, hero, feature blocks, a competitor comparison table, a plans table, a demo form, and an FAQ. Start here for the site's copy; it is more current than any older draft.
- **`competitor-landscape.md`** — the competitive map, by category and by region, with the pricing anchors (US phone agents charge $300–600 per month for phone answering alone) and the read on the one company genuinely worth watching (allO, Munich, €12M in May 2026, expanding across Europe).
- **`risto-design-system.md`** — the full design language.
- **`Manuale_Utente_CRM.md`** — the Italian user manual for the CRM modules. Useful for the exact language a restaurateur uses about these features.
- **`elevenlabs-agent-prompt.live.md`** — the live voice agent's system prompt, if the site ever wants to describe or demo how the agent actually behaves.
- **`Informativa_Privacy_Prenotazioni.docx`** and **`Checklist_Conformita_Privacy_GDPR.docx`** — the privacy notice and the GDPR checklist, for the site's own legal pages.

---

## 12. The three things to get right on the site

Condensed from the competitive work, because they decide whether the page sells.

1. **"You keep your till."** Every competitor in Italy asks a restaurateur to replace their cash register, and that objection ends conversations before features matter. Answer it above the fold, not in an FAQ.
2. **The AI claim, stated structurally.** Not "we have AI on the phone" — ten companies do. "Our AI books against the same live availability the floor plan uses, because we own the floor plan." That one no competitor's funding can copy quickly.
3. **A sixty-second recording of a real service** — an order going in on a phone and landing on the kitchen screen. It will sell better than any sentence on the page. Build the hero around it.
