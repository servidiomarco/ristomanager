# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

RistoManager is a real-time restaurant CRM in production at a single restaurant (Vecchio Frantoio). It covers reservations, floor plan, reception/arrivals, orders & kitchen display, payments, inventory, HACCP, and inbound communications (WhatsApp, SMS, email, and an ElevenLabs voice agent that books over the phone). All UI copy and commit messages are in Italian.

## Commands

```bash
npm run dev            # Vite SPA on :5173 — see the production-data warning below
npx tsc --noEmit       # typecheck the frontend (tsconfig.json is noEmit; this is the gate)
npm run build          # SPA production build
npm run build:server   # compile server.ts + deps to dist/ via tsconfig.server.json
npm run start:server   # run server.ts directly (ts-node ESM loader) — local backend on :3000
npm start              # run the compiled dist/server.js
npm test               # build the server, then API tests (Vitest+supertest) on a local throwaway Postgres
```

Run `npx tsc --noEmit` after any change and `npx vite build` before committing (then `rm -rf dist` — it is gitignored but the server build also writes there).

**Tests: API smoke suite only.** `npm test` compiles the server and runs Vitest + supertest (`tests/api/`) against the real compiled artifact (`dist/server.js`) on a local Postgres. `tests/api/globalSetup.ts` **drops and recreates** the database named in `DATABASE_URL` (default `postgresql://localhost/ristotest_api`) and refuses non-localhost hosts. Readiness is probed by logging in the seeded owner — `/health` returns 200 before the schema exists, never use it as a readiness gate; `GET /ready` is the real one (200 only after migrations complete, and it is Railway's deploy healthcheck). Test files run sequentially (shared server + DB); a test that toggles a feature flag changes state for the files after it. There are still no frontend/unit tests — section 13 of the design-system doc remains aspirational. CI (`.github/workflows/ci.yml`) runs typecheck, both builds, and the API tests on every PR.

Two shell scripts stand up a full local stack, each seeding its own Postgres database and refusing to run against a non-localhost host:

```bash
./scripts/dev-comande.sh    # orders module: db + seed data + API :4599 + web :5199
./scripts/test-locale.sh    # sala/orderpad: db + API :3005 + web :5173 + print agent
```

### `npm run dev` talks to the production API

There is no `.env` in the repo (gitignored). Both `services/apiService.ts` and `services/socketClient.ts` fall back to `https://ristomanager-production.up.railway.app` when `VITE_API_URL` is unset, and Vite ignores `.env.production` in dev mode. So a bare `npm run dev` reads **and writes the live restaurant database** — every Conferma, Assegna, or delete click is real. Create a `.env` with `VITE_API_URL=http://localhost:3000` before doing anything interactive.

**`.env.local` overrides `.env`** in Vite's precedence order — and for months a gitignored `.env.local` on the dev machine pointed `VITE_API_URL` at production, silently defeating any correct `.env` (this was the actual root cause of the warning above; found and fixed 2026-08-21). If dev traffic inexplicably hits production, check `.env.local` first.

## Architecture

### Two applications, one repository

| | Frontend | Backend |
|---|---|---|
| Entry | `index.tsx` → `App.tsx` | `server.ts` (18k lines, ~260 routes) |
| Config | `tsconfig.json` (noEmit, bundler resolution) | `tsconfig.server.json` (emits ES2020 to `dist/`) |
| Deploy | Vercel → `crm.vecchiofrantoio.com` | Railway (Dockerfile) |

They are deployed separately and communicate cross-origin over HTTP + Socket.IO. The Dockerfile copies only `server.ts`, `db.ts`, `types.ts`, `auth/`, `services/`, `activityLogs/`, `utils/` and `public/` — a new backend directory must be added there or it will not ship.

**Server-side relative imports need a `.js` extension** (`import pool from './db.js'` for `db.ts`), because `tsconfig.server.json` emits real ES modules that Node resolves at runtime. Frontend imports must not have it. Files in `services/` and `utils/` that both sides import (`socketService.ts`, `text.ts`, `types.ts`) follow the server rule.

### The socket layer is the spine, not an add-on

`App.tsx` owns the shared domain state — `reservations`, `tables`, `rooms`, `dishes`, `banquetMenus` — loaded once and thereafter mutated almost entirely by Socket.IO events (`reservation:created|updated|deleted|synced`, `table:*`, `room:*`, `dish:*`, `banquet:*`). Screens receive this state as props.

Consequences when adding a mutating endpoint:

- Broadcast from the route, or the change appears on the acting client and nowhere else until a reload.
- The client sends an `X-Socket-ID` header on writes; the server passes it to `SocketService` to exclude the originating socket via `io.except(...)`. This is deliberately applied to tables and merges but **not** to reservations — those broadcast to everyone including the sender, because the server-side row is authoritative there.
- Socket.IO handshakes authenticate with the same JWT as the REST API and are rejected without one.

`services/offlineQueue.ts` buffers write operations in localStorage while disconnected and flushes on reconnect.

### Navigation is an enum, not a router

There is no router. `App.tsx` holds `const [view, setView] = useState<ViewState>(...)` and switches on the `ViewState` enum in `types.ts`. The only true URL route is `/pay/:token`, mounted in `index.tsx` **outside** `AuthProvider` so guests scanning the pay-at-table QR are not bounced to login.

### Auth and permissions live on both sides

`auth/permissions.ts` maps `UserRole` → `Permission[]` and is the shared definition. The server enforces it with `requirePermission` middleware; the frontend mirrors it through `useAuth().hasPermission(...)` and `canAccessView(...)` from `contexts/AuthContext.tsx`. Adding a permission means touching the role map, the route guard, and the view gate — a client-only change hides the button but leaves the endpoint open, and a server-only change produces buttons that 403.

Access + refresh tokens sit in localStorage; `apiService.fetchWithAuth` transparently refreshes once on a 401 and retries.

### Database: frozen baseline + node-pg-migrate

`db.ts` exports the `pg` pool, `createSchema()` and `runMigrations()`. `createSchema()` is the historical baseline — written entirely as `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, run at every boot — and is **frozen**: do not add new schema changes to it. Every schema change goes in a versioned migration instead: `npm run migrate:create -- nome-migrazione` creates a plain-JS ESM file in `migrations/` (`export const up = (pgm) => { pgm.sql(...) }`). At boot the server runs `createSchema()` first, then `runMigrations()` applies pending migrations (recorded in the `pgmigrations` table). In production migrations run only at boot; `npm run migrate` exists for local use and needs `DATABASE_URL`. `migrations/` is COPY'd into the Dockerfile production stage — a migration file outside that directory will not ship.

The pool is tuned around Railway's proxy (IPv4-pinned DNS, 30s idle eviction, statement timeouts); the comments there explain which production failure each setting fixes. Migrations deliberately run on a dedicated client without those statement timeouts.

The pg `DATE` type parser is overridden to return plain `YYYY-MM-DD` strings, because the default parser shifts dates through the server's local timezone and produces off-by-one-day bugs.

### Time is always Europe/Rome

`utils/reservationTime.ts` provides `getRomeDatePart` / `getRomeTimePart`. Reservations are stored as UTC instants; any date or time shown or grouped on must go through these helpers, never through raw `Date` methods.

### Reservation state has one source of truth

`components/reservationState.tsx` defines both layers and every surface derives from it:

- **Enum state** (`getReservationState`) — what is persisted.
- **Timed state** (`getTimedReservationState`) — the enum state enriched by the clock. A confirmed booking within `ARRIVING_WINDOW_MIN` (20) before its time reads as "In arrivo" and stays so until `ARRIVING_STALE_MIN` (120) after; a seated party past its expected duration reads as "In uscita". These advance on their own during service.

The module also owns the mapping from state to colour family, so a state looks identical in list chips, reception badges, table glyphs, and dashboard counters. Never re-derive state colour locally.

### The public booking page is a third application

`public/prenota.html` is one self-contained static file — markup, CSS and vanilla JS — served by the backend and copied into the Docker image with the rest of `public/`. It is **not** part of the SPA: no React, no bundler, no `index.css`, and `npx tsc --noEmit` does not see it. After editing it, syntax-check the inline script directly; a typo there fails silently in a guest's browser and in no build.

It talks to four unauthenticated routes, each registered twice — `/public/*` and `/public/:slug/*` — through `withPublicTenant`, which resolves the tenant from the slug, then the domain, then falls back to tenant 1. Handlers receive the tenant already resolved.

- `GET /public/contact` — the page's bootstrap. `bookingsEnabled` gates everything, and **the safe default is off**: if the fetch fails the maintenance card stays and no form is wired. Also carries `branding` (name, tagline, logo, header colour, address, maps URL) and the deposit policy.
- `GET /public/availability` — **two shapes on one route.** With `?date=` it returns one day's slots per shift; with `?from=&to=` it returns per-day `open` / `busy` / `closed` for the calendar. The range form deliberately runs a *fixed* five queries regardless of window length — the obvious loop over `getAvailableSlots` per day and shift would be 124 round trips for two months on a public endpoint. Capped at 62 days.
- `GET /public/rooms` — needs a shift, so before one is chosen the page queries both and merges by id.
- `POST /public/reservations` — honeypot field, then the same validation the CRM applies.

`getAvailableSlots` returns the **opening-hours grid** minus closures and disabled slots. It does not know about bookings, and it is not guest-aware. So the calendar's "quasi pieno" dot is booked covers against total seats at 70% — an indicative traffic light, explicitly *not* the rule that decides confirmed-vs-request. That rule is per-room (`getCappedRoomIds`) and reaches the page through `/public/rooms`, so what the guest is told and what the submit does cannot drift.

Public identity fields (`business_name`, `public_phone`, `public_address`, `maps_url`, …) live in the `legal_config` blob in `app_settings` and reach the page via `BusinessIdentity`. Adding one means four edits: `LEGAL_STRING_FIELDS`, the `BusinessIdentity` type and its refresh, the `LegalSettings` interface in `services/apiService.ts`, and a `Field` in `LegalSettingsCard.tsx`. Miss the last and the setting exists but nobody can fill it in.

## Design system

`docs/risto-design-system.md` is the specification; `index.css` is the implementation. The doc deliberately does not track migration progress — do not add status tables to it.

**The migration is finished.** No file in the app reads `var(--color-*)` or a remapped Tailwind palette class (`bg-indigo-600`, `text-slate-400`). The legacy `@theme` block still stands in `index.css` because Tailwind's own utilities resolve through it, but nothing of ours consumes it directly. Adding a `--color-*` or a bare palette class to a component is a regression — reach for a `--ds-*` token.

The layers, and where each one lives:

| Layer | Where | For |
|---|---|---|
| `--ds-*` | `index.css` `:root` + `.dark` | everything in the app |
| `--ds-cat-1…6` | same | categories, not states (§3.5) |
| `--ds-banquet-*` | same, scoped by `.banquet-color-N` | per-event tint; resolves to `--ds-cat-1…5` |
| `--ds-print-*` | same, **`:root` only** | the printed sheet (§17) |
| `--tg-*` | same | floor-map table glyphs — its own values, semantics that agree with the families |
| `--ds-public-*` | `public/prenota.html` `<style>` | the booking page (§16) |

Two of those bite if you forget them:

- **`public/prenota.html` restates the `--ds-*` values by hand.** It is served by the backend, is not built by Vite, and does **not** load `index.css` — a token changed here does not reach it. Edit both, or the booking page silently keeps the old value.
- **`--ds-print-*` is never declared under `.dark`,** and that is the point. The print sheet renders inside the app document, so a themed token would print a black page for anyone working in dark mode.

Working rules that are easy to violate:

- **Never uppercase, anywhere** (§5.2) — including when a mockup shows caps. Word shapes vanish at 10–13px, screen readers spell short caps out, and Italian accented capitals degrade (`PIÙ` → `PIU`).
- **Cut the copy to the shortest thing that still works** (§10). These screens are read mid-service; every word sits between the reader and the number they came for. Say it once — a sheet does not repeat the name of the record it opened from — and drop reassurance like "puoi sempre modificarlo dopo", which carries no information.
- Import primitives from the `./ds` barrel (`components/ds/index.ts`), never from the individual files.
- `PascalCase` exports from `ds/` are components; the `ds`-prefixed camelCase exports (`dsButton`, `dsInput`, `dsIconButton`) are **class-name strings** for cases where the element must stay native.
- **Tailwind extracts class names statically.** A template-built class such as `` `bg-[var(--ds-${family}-tint)]` `` never ships. Write the full literal for every branch.
- Touch targets are 44px minimum; `useMediaQuery` picks the component *tree* (sheet vs pane) where CSS cannot.
- **A state family means something; a category does not.** `pending` is "needs action", `critical` is "failed". For things that are merely *different from each other* — banquet events, task categories — use `--ds-cat-*` (§3.5). A category dot in `pending` amber tells the reader it is overdue.
- **`--ds-cat-*` solids never sit behind small text.** They are dots, bars and borders; two of the six fall under AA as body text on their own tint. Text goes on `tint`.
- **`tailwindcss-animate` is deliberately not installed.** `animate-in`, `fade-in`, `slide-in-from-*` compile to nothing — 23 of them were removed once. The app's animations are hand-written `@keyframes` in `index.css` (`slideUpSheet`, `view-in`, `tileIn`, `ds-live-sweep`); use those.
- **Close buttons are a filled circle**, not a square: `h-9 w-9 rounded-full bg-[var(--ds-surface-row)]` with a 16px glyph, as `ModalShell` defines it.
- **AI is marked with `Wand2` and the `arriving` family** — never `Sparkles`, which means literal sparkle (HACCP cleaning). In Messaggi the agent's proposal uses `.ds-ai-frame`, a sweeping hairline, so the card itself can stay neutral.

## Roadmap queue (pagina Roadmap, solo account admin)

La pagina Roadmap (`components/RoadmapPage.tsx`, gate email come il dev board) contiene il piano di lancio del brand Sympotia. I task con `claude_prompt` sono destinati a Claude: l'admin li approva dalla pagina (status `queued`) e le sessioni Claude Code li eseguono. Quando l'utente chiede di "eseguire la roadmap" (o all'inizio di una sessione di lavoro su Sympotia):

1. `node scripts/roadmap.mjs list` — mostra i task approvati con il loro prompt (serve `DATABASE_URL`).
2. `node scripts/roadmap.mjs start <id>` — prendi in carico prima di lavorarlo.
3. Esegui quello che chiede il prompt del task.
4. `node scripts/roadmap.mjs done <id> "esito in una frase"` — chiudi: la nota compare in pagina.

Non eseguire task che non sono in coda (`queued`): l'approvazione dalla pagina È il consenso dell'utente.

## Conventions

- **`docs/funzionalita-app.md` is the product feature catalogue** (source for the marketing site and the user manual). Any PR that adds, changes, or removes a user-visible feature must update the relevant section there *and* add a row to its "Registro aggiornamenti" table, in the same PR.
- Commit messages in Italian, matching the existing log (`Riveste Prenotazioni e Reception sul nuovo design system`).
- Comments explain *why*, and frequently name the production incident a line defends against. Preserve them when refactoring; they are the only record of several fixes.
- The largest files (`server.ts` 18k, `ReservationList.tsx` 6.9k, `App.tsx` 2.9k) are edited in place rather than split. Locate a region by its section-banner comment before editing, and verify anchors — a mis-scoped scripted replace on files this size is difficult to recover from.
