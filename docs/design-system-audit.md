# RistoManager — Design System Audit & Redesign Plan

> **Status:** Draft v1 · **Owner:** Design lead · **Last updated:** 2026-05-02
> **Goal:** Elevate the entire RistoManager product into a coherent, accessible, scalable design system. Built on the **FlowOps Surgical Precision** token foundation, structured so we can swap the brand later without rewriting components.

---

## 0. How to read this document

This is **inventory + audit + plan**, not a finished design system. It is the source of truth that drives:

- The token files we will create (`tokens.css`, `tailwind.config.js`)
- The component library we will build under `components/ui/`
- The redesign of every existing screen
- The accessibility commitments we are making to our users

**No code is being changed in this document.** Every section ends with explicit decisions or open questions, so the next steps are unambiguous.

Three audiences:
1. **Design** — `§3 Tokens`, `§4 Accessibility`, `§6 Components`, `§7 Screens`
2. **Engineering** — `§3`, `§5 Responsive`, `§6 Components`, `§8 Patterns`, `§9 Roadmap`
3. **PM / leadership** — `§1`, `§2`, `§9 Roadmap`, `§10 Decisions`

---

## 1. Executive summary

RistoManager is a real-time restaurant CRM (React + Vite + Tailwind v4 + lucide-react, Italian-first, socket-driven) that has grown organically across **11 screen-level components**, **~10 modals**, **~20 distinct forms**, and roughly **300 inline button instances** + **150 inline inputs**. Styling is mostly Tailwind with the slate/indigo/rose/emerald/amber palette, but conventions drift between files — LoginPage now uses hardcoded hex values, the rest of the app uses Tailwind tokens, modal radii vary between `rounded-xl` and `rounded-2xl`, and there is no documented elevation, z-index, or motion system.

We are committing to:

1. **One token layer** (CSS custom properties) with **two themes** (light, dark) and a **high-contrast mode**.
2. **A small, composable component library** under `components/ui/` (Button, Input, Field, Checkbox, Select, Modal, Card, Badge, Toast, Table, etc.) — composition over monoliths.
3. **WCAG 2.2 AA as the floor, AAA where cheap** — plus explicit support for color blindness (never color-alone), dyslexia (line-height, letter-spacing, optional dyslexia-friendly font), and low-vision (200% zoom, focus-visible, prefers-reduced-motion).
4. **Mobile-first responsive strategy** with five breakpoints and explicit touch-target minimums.
5. **A phased migration** so we can ship incrementally without freezing feature work.

The document below is long because it is exhaustive, not because the result will be complex. The component library itself should fit in **~25 primitives**.

---

## 2. North-star principles

Five rules that resolve every disagreement downstream:

1. **Composition over configuration.** A `Modal` does not know about reservation forms. A `<Field>` wraps a label + control + helper + error. Screens compose primitives, not the other way around.
2. **Accessibility is a feature, not a polish step.** Every component lands with keyboard, focus, ARIA, and contrast verified. No "we'll fix it later" — later does not come.
3. **Semantic tokens, not literal colors.** Components reference `--color-bg-surface`, never `#ffffff`. Theme swaps are a CSS variable change, nothing more.
4. **Mobile is the primary device.** Restaurant staff use this on phones during service. Desktop is the editing/admin surface.
5. **Restraint.** One primary color, three neutrals, four semantic states, one shadow scale, one radius scale. If we need a new color we audit first before adding.

---

## 3. Token system

### 3.1 Color

Two layers: **base palette** (raw scales) and **semantic tokens** (what components use).

#### Base palette (light mode)

Built on the FlowOps `#111827` accent and `#FFFFFF` neutral. The palette below is a proposal — tuned so every text/surface combination clears WCAG AA.

| Token | Hex | Notes |
|---|---|---|
| `--neutral-0` | `#FFFFFF` | Pure white; page bg in light |
| `--neutral-50` | `#F9FAFB` | Subtle surfaces, hover bg |
| `--neutral-100` | `#F3F4F6` | Card alt, disabled bg |
| `--neutral-200` | `#E5E7EB` | Borders default |
| `--neutral-300` | `#D1D5DB` | Borders strong, divider |
| `--neutral-400` | `#9CA3AF` | Placeholder, disabled fg (AA-only against white at ≥18px) |
| `--neutral-500` | `#6B7280` | Secondary text |
| `--neutral-600` | `#4B5563` | Body text fallback |
| `--neutral-700` | `#374151` | Strong body text |
| `--neutral-800` | `#1F2937` | Headings |
| `--neutral-900` | `#111827` | Primary accent / strongest text |
| `--neutral-1000` | `#0B0F17` | Black-ish for shadows, dark mode bg |

| Token | Hex | Notes |
|---|---|---|
| `--accent-primary` | `#111827` | FlowOps surgical precision |
| `--accent-warm-50` | `#FFEDD5` | FlowOps secondary |
| `--accent-warm-100` | `#FED7AA` | Soft peach surfaces |
| `--accent-cool-50` | `#E0E7FF` | FlowOps tertiary |
| `--accent-cool-100` | `#C7D2FE` | Soft lavender surfaces |

| Semantic state | Hex | Usage |
|---|---|---|
| `--success-50 / 600 / 700` | `#ECFDF5 / #059669 / #047857` | Confirm, present, occupied (positive) |
| `--warning-50 / 600 / 700` | `#FFFBEB / #D97706 / #B45309` | LUNCH shift, dirty table, pending |
| `--danger-50 / 600 / 700` | `#FEF2F2 / #DC2626 / #B91C1C` | Destructive, errors, offline |
| `--info-50 / 600 / 700` | `#EFF6FF / #2563EB / #1D4ED8` | Info banners, informational badges |

> **Decision pending (D-1):** The current app uses indigo as primary. FlowOps uses neutral `#111827` as primary. We are committing to `#111827` as the brand accent and reclassifying indigo as `--info`. Confirm in §10.

#### Dark mode

Mirror tokens, not raw hex. Components reference `--color-bg-surface` and the theme remaps it.

| Token | Light | Dark |
|---|---|---|
| `--color-bg-page` | `#FFFFFF` | `#0B0F17` |
| `--color-bg-surface` | `#FFFFFF` | `#161B26` |
| `--color-bg-surface-raised` | `#FFFFFF` | `#1F2632` |
| `--color-bg-surface-sunken` | `#F9FAFB` | `#0B0F17` |
| `--color-bg-surface-hover` | `#F3F4F6` | `#222A38` |
| `--color-bg-overlay` | `rgba(17,24,39,0.5)` | `rgba(0,0,0,0.7)` |
| `--color-border-default` | `#E5E7EB` | `#2A3243` |
| `--color-border-strong` | `#D1D5DB` | `#3A4458` |
| `--color-border-focus` | `#111827` | `#FFFFFF` |
| `--color-text-primary` | `#111827` | `#F9FAFB` |
| `--color-text-secondary` | `#4B5563` | `#9CA3AF` |
| `--color-text-tertiary` | `#6B7280` | `#6B7280` |
| `--color-text-disabled` | `#9CA3AF` | `#4B5563` |
| `--color-text-inverse` | `#FFFFFF` | `#111827` |
| `--color-text-link` | `#111827` | `#FFFFFF` |
| `--color-accent-fg` | `#FFFFFF` | `#111827` |
| `--color-accent-bg` | `#111827` | `#FFFFFF` |
| `--color-accent-bg-hover` | `#000000` | `#F3F4F6` |

#### High-contrast mode (a11y opt-in)

Triggered by `prefers-contrast: more` or a user toggle. Increases borders to 2px, removes subtle shadows, bumps text to neutral-900/0.

#### Color-blindness safety

- **Never color-alone.** Status pills always pair color + icon + label (✅ Confirmed, ⚠ Pending, ✕ Cancelled). Status of a table cell is icon + label, not color of the cell.
- **Status hue choices.** Success (green), warning (amber/orange), danger (red) are differentiated by hue *and* shape:
  - Success → solid round badge
  - Warning → triangle / alert glyph
  - Danger → octagon / X glyph
- **Tested for**: deuteranopia, protanopia, tritanopia (we will simulate before merging redesigns of any status-heavy screen — Reservations, FloorPlan, Dashboard).
- **Banned combinations**: red text on green bg, green text on red bg, blue/purple at low saturation against grey.

### 3.2 Typography

Single typeface — **Inter** (variable). Optional dyslexia toggle swaps to **Atkinson Hyperlegible** (free, open, designed for low vision).

#### Type scale

| Token | Size | Line-height | Tracking | Weight | Use |
|---|---|---|---|---|---|
| `text-display-lg` | 56px | 64px | -0.02em | 500 | Marketing/hero only |
| `text-display-md` | 40px | 48px | -0.02em | 500 | Empty-state heroes |
| `text-h1` | 32px | 40px | -0.01em | 600 | Page titles |
| `text-h2` | 24px | 32px | -0.01em | 600 | Section titles, modal headers |
| `text-h3` | 20px | 28px | -0.005em | 600 | Card titles |
| `text-h4` | 18px | 26px | 0 | 600 | Subsection titles |
| `text-body-lg` | 16px | 24px | 0 | 400 | Primary reading text |
| `text-body-md` | 14px | 22px | 0 | 400 | Default UI text |
| `text-body-sm` | 13px | 20px | 0 | 400 | Helper text, dense UI |
| `text-label-md` | 14px | 20px | 0.01em | 500 | Form labels, button labels |
| `text-label-sm` | 12px | 16px | 0.02em | 500 | Badges, eyebrows, microcopy |
| `text-caption` | 12px | 16px | 0 | 400 | Captions, timestamps |
| `text-mono-sm` | 13px | 20px | 0 | 400 | IDs, codes (JetBrains Mono) |

#### Reading-comfort defaults

- **Min line-height** for any paragraph text: **1.5** (WCAG 2.2 SC 1.4.12).
- **Max line length** for body copy: **75ch**.
- **Letter spacing** for all-caps eyebrows: **+0.05em** (legibility).
- **Numbers**: `font-variant-numeric: tabular-nums` on tables, time, money.

#### Dyslexia mode (toggle in settings)

When user opts in:
- Switch base font family to **Atkinson Hyperlegible**.
- Increase line-height by `+0.1`.
- Increase letter-spacing on body to `+0.02em`.
- Disable all italics.

> **Decision pending (D-2):** Where does the toggle live — Settings → Accessibility, or in the user dropdown for one-tap access? Recommendation: both (canonical in Settings, shortcut in dropdown).

### 3.3 Spacing scale

4px rhythm (FlowOps).

| Token | px | Use |
|---|---|---|
| `space-0` | 0 | reset |
| `space-1` | 2 | hairline |
| `space-2` | 4 | base unit |
| `space-3` | 6 | compact gap |
| `space-4` | 8 | tight gap, button gap |
| `space-5` | 10 | input padding-y |
| `space-6` | 12 | card gap, button padding-x |
| `space-8` | 16 | default gap, card padding |
| `space-10` | 20 | section gap |
| `space-12` | 24 | card padding-lg, section padding |
| `space-16` | 32 | major gap |
| `space-20` | 40 | hero gap |
| `space-24` | 48 | page padding-y |

Pattern: prefer the smaller end. Density is a feature in this product (staff scan reservation lists during service).

### 3.4 Radius scale

Tight family per FlowOps.

| Token | px | Use |
|---|---|---|
| `radius-none` | 0 | dividers |
| `radius-sm` | 4 | inputs, small chips, checkboxes |
| `radius-md` | 8 | buttons (rectangular variant), small cards |
| `radius-lg` | 12 | cards default |
| `radius-xl` | 16 | modals, sheets |
| `radius-2xl` | 24 | hero cards, marketing surfaces |
| `radius-full` | 9999 | pill buttons, avatars, status dots |

> **Decision pending (D-3):** Primary buttons today are `rounded-full` (pill) per the recent login redesign. Keep pills as the *primary* button shape across the app, or fall back to `rounded-md` for density-heavy screens (tables, toolbars)? Recommendation: **two button shapes, `pill` and `rect`, with `pill` as default.** See §6.1.

### 3.5 Elevation / shadow

A scale we can defend, not seven random values.

| Token | Recipe | Use |
|---|---|---|
| `shadow-none` | none | flush surfaces |
| `shadow-xs` | `0 1px 2px rgba(0,0,0,0.05)` | inputs, low-priority cards |
| `shadow-sm` | `0 1px 2px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.06)` | cards default |
| `shadow-md` | `0 4px 8px -2px rgba(0,0,0,0.08), 0 2px 4px -2px rgba(0,0,0,0.04)` | dropdowns, popovers |
| `shadow-lg` | `0 12px 24px -8px rgba(0,0,0,0.12), 0 4px 8px -4px rgba(0,0,0,0.06)` | floating modals (when not full-screen) |
| `shadow-overlay` | `0 24px 48px -12px rgba(0,0,0,0.18)` | top-level modals |
| `shadow-focus` | `0 0 0 3px rgba(17,24,39,0.25)` | keyboard focus ring (a11y) |

Dark mode increases opacity by 1.5x on every shadow.

### 3.6 Z-index scale

Documented layers, never raw values:

| Token | Value | Use |
|---|---|---|
| `z-base` | 0 | normal flow |
| `z-raised` | 10 | sticky table headers, floating action buttons |
| `z-dropdown` | 20 | selects, autocomplete |
| `z-popover` | 30 | popovers, tooltips |
| `z-banner` | 40 | sticky banners (offline, system maintenance) |
| `z-overlay` | 50 | modal backdrops |
| `z-modal` | 60 | modal content |
| `z-toast` | 70 | toast container (always on top) |
| `z-debug` | 9999 | dev overlays only |

Today the codebase has `z-10`, `z-20`, `z-30`, `z-[50]`, `z-[70]` — replace all with these tokens.

### 3.7 Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `motion-instant` | 50ms | linear | press feedback |
| `motion-fast` | 150ms | `cubic-bezier(0.4, 0, 0.2, 1)` | hover, focus, color changes |
| `motion-base` | 200ms | `cubic-bezier(0.4, 0, 0.2, 1)` | default UI transitions |
| `motion-slow` | 300ms | `cubic-bezier(0.16, 1, 0.3, 1)` | modal/sheet enter, drawer |
| `motion-pulse` | 1400ms | ease-in-out | live/connection indicators |

**`prefers-reduced-motion: reduce`** disables all transitions over 200ms and all keyframe animations except connection-state pulses (which become a steady color, no pulse).

### 3.8 Breakpoints (mobile-first)

| Token | Min width | Targets |
|---|---|---|
| `sm` | 480px | Large phones (most service-floor devices) |
| `md` | 768px | Tablets (POS terminals) |
| `lg` | 1024px | Small laptops (back-office) |
| `xl` | 1280px | Desktop (admin) |
| `2xl` | 1536px | Wide desktop |

Default styles target **<sm** (single-column, full-width, touch-first). Anything ≥`sm` is enhancement.

### 3.9 Touch targets

Per WCAG 2.2 SC 2.5.8: **minimum 24×24 CSS px**, *recommended* **44×44** on touch surfaces. We commit to **44×44 on mobile**, **32×32 on dense desktop tables** (with `:focus-visible` ring covering the larger hit area).

---

## 4. Accessibility playbook

WCAG 2.2 AA is the floor, AAA wherever it is cheap.

### 4.1 Contrast targets

| Element | Min ratio | Source |
|---|---|---|
| Body text vs background | **4.5:1** | AA |
| Large text (≥18px or 14px bold) vs bg | **3:1** | AA |
| UI components (borders, focus) vs adjacent | **3:1** | AA SC 1.4.11 |
| Disabled controls | exempt, but visually distinct | — |
| Aim for body text | **7:1** where possible | AAA |

Every semantic token pair in §3.1 will be contrast-tested in CI (Storybook `addon-a11y` + axe in jest).

### 4.2 Keyboard

- **Every** interactive element keyboard-reachable in DOM order.
- **Focus visible** always — `:focus-visible` ring (`shadow-focus` token), never `outline: none`.
- **Skip link** to main content (currently absent).
- **Modals**:
  - trap focus while open
  - return focus to invoker on close
  - close on `Esc`
  - first focusable element auto-focused unless dangerous
- **Dropdowns / selects / popovers**: arrow-key navigation, Enter to select, Esc to close, Home/End jump.
- **Tabs**: arrow keys to move, Tab to enter content panel.
- **Tables**: `tabindex` on first row, arrow keys move row/cell.
- **Drag and drop** (FloorPlan): keyboard alternative — Space to pick up, arrow keys to move, Space to drop, Esc to cancel.

### 4.3 Screen reader

- **Live regions** for toasts (`aria-live="polite"`) and connection state changes (`aria-live="assertive"` when connection drops).
- **Form errors**: `aria-invalid="true"` on the field, error linked via `aria-describedby`, error has `role="alert"` if it appears after submit.
- **Loading states**: spinner has `aria-label="Caricamento"` and the surrounding region uses `aria-busy="true"`.
- **Custom controls** (custom checkbox, segmented control) must mirror native behavior with proper ARIA roles.
- **Icon-only buttons** require `aria-label`.
- **Decorative icons** require `aria-hidden="true"`.

### 4.4 Motion safety

- All non-essential animation respects `prefers-reduced-motion`.
- Connection-state pulse becomes a static dot under reduced motion.
- Toasts slide-in becomes fade-in.
- No infinite spinning loaders longer than 4s without an explicit progress message.

### 4.5 Form accessibility (universal rules)

- **Every** input has a real `<label htmlFor>`. Placeholder is never the only label.
- Required fields marked both visually (`*`) and with `aria-required="true"`.
- Errors announced inline, not just toast.
- Help text associated via `aria-describedby`.
- Autocomplete attributes (`autocomplete="email"`, etc.) set correctly.
- Numeric pads (`inputmode="numeric"`) on guest count, prices, PIN entry, etc.

### 4.6 Color blindness specifics

See §3.1 — never color-alone, status pills include icon + label, adjacent semantic colors differ in luminance, not just hue.

### 4.7 Dyslexia & cognitive load

- Body line-height ≥ 1.5 (we set 1.57 default).
- Max line length 75ch.
- No justified text.
- Optional Atkinson Hyperlegible toggle.
- Plain-language Italian copy review (§8.4).
- Avoid all-caps for body. Eyebrows only, with letter-spacing.

### 4.8 Low vision

- App must remain functional at **200% browser zoom** (WCAG SC 1.4.4).
- App must reflow without horizontal scrolling at **400% zoom** (SC 1.4.10).
- All text resizable via the user font size — no `px` for font sizes in component CSS, use `rem`.
- Pinch-zoom never disabled (no `user-scalable=no` in viewport).

---

## 5. Responsive strategy

### 5.1 Mobile-first patterns

- Default layout = single column, full-width, scroll-Y.
- Navigation collapses to a bottom tab bar at `<md`.
- Tables collapse to **stacked cards** at `<md` (each row becomes a card with key/value pairs).
- Forms stretch full-width with `max-w-prose` cap.
- Modals become **bottom sheets** at `<md` (full-width, slide up from bottom, swipe-down to dismiss).
- Floor plan becomes **pinch-zoomable canvas** at `<md` with table list as fallback.

### 5.2 Touch ergonomics

- **44×44 minimum** hit targets on mobile.
- Primary actions reachable with one thumb (bottom of viewport on mobile).
- Long-press = context menu only when documented; never block long-press text selection.

### 5.3 Density tiers

Three density tokens, applied per-route:

| Tier | Use | Example |
|---|---|---|
| `density-comfortable` | mobile-default, low-frequency screens | Settings, Login |
| `density-default` | most screens | Dashboard, Menu |
| `density-compact` | tabular, high-frequency | ReservationList during service, ActivityLogs |

Density modifies row padding, icon sizes, and gap tokens — *never* font-size.

---

## 6. Component library inventory

We aim for **~25 primitives** that compose into everything. For each component below: **Anatomy → Variants → States → A11y → Mobile → Migration** (where it exists today).

### 6.1 Button

**Anatomy:** `[icon-leading?] [label] [icon-trailing?] [loader-overlay?]`

**Variants**
| Variant | Bg | Fg | Use |
|---|---|---|---|
| `primary` | `accent-bg` | `accent-fg` | main action |
| `secondary` | `bg-surface` | `text-primary` border | secondary action |
| `ghost` | transparent | `text-primary` | tertiary, dense toolbars |
| `destructive` | `danger-600` | `white` | confirmed delete only |
| `link` | none | `text-link`, underlined on hover | inline text actions |

**Shapes:** `pill` (default, `radius-full`), `rect` (`radius-md` for dense UIs).

**Sizes:** `sm` (32px), `md` (40px, default), `lg` (48px, hero CTAs).

**States:** default, hover, focus-visible, active, disabled, loading.

**A11y:** `aria-busy="true"` while loading; `aria-label` if icon-only; `disabled` removes from tab order, `aria-disabled` keeps it (use the latter when the disabled reason needs explaining).

**Mobile:** `lg` size when used as primary CTA in forms and bottom sheets.

**Migration:** ~300 inline button instances across all screens. Replace incrementally as each screen is redesigned.

### 6.2 IconButton

Round or square icon-only button. Same variants and sizes as Button. Always requires `aria-label`. Used for close, password toggle, edit/delete row actions.

### 6.3 Input (text, email, password, number, tel, url, search)

**Anatomy:** `[icon-leading?] [text] [icon-trailing? | clear-button | password-toggle?]`

**Sizes:** `sm` (32px), `md` (40px, default), `lg` (48px).

**States:** default, hover, focus, filled, disabled, readonly, error, success.

**Variants:** `outline` (default), `filled` (subtle bg, no border), `unstyled` (for inline composition).

**A11y:** label required (use `<Field>`), `aria-invalid` + `aria-describedby` linking error / helper, `autocomplete` set per use, `inputmode` for numeric/decimal.

**Mobile:** larger touch target, `inputmode` always set, `enterkeyhint` set per context (search → "search", form → "next" or "done").

### 6.4 Textarea

Same as Input but multi-line. `auto-resize` variant (grows with content up to a max-rows cap).

### 6.5 Select / Combobox

**Native `<select>` for short lists (≤7 options).** Use `Combobox` (popover with search) for long lists (rooms, dishes, staff). Combobox = button trigger + popover + virtualized list + search input + keyboard nav.

**A11y:** combobox follows ARIA 1.2 combobox pattern (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`).

### 6.6 Checkbox

**Anatomy:** `[box] [label] [helper?]`

**States:** unchecked, checked, indeterminate, focus, disabled.

**Visual:** square `radius-sm`, fills `accent-bg` when checked, white check icon. Already implemented this way on LoginPage.

**A11y:** native `<input type="checkbox">` visually-hidden + styled span + check icon (current LoginPage pattern is good — promote it).

### 6.7 Radio / RadioGroup

Native radio + styled. Always inside a `RadioGroup` with `role="radiogroup"` and a group label.

### 6.8 Switch / Toggle

Distinct from checkbox: **immediate effect, no submit needed** (e.g., "Active", "Notifications on"). Pill-shape with sliding thumb. Currently the app uses checkboxes for these — we will introduce a real Switch.

### 6.9 Field (composite)

Wraps any input control with: label, optional eyebrow, helper text, error message, required indicator. **One canonical place to attach `aria-describedby`, `aria-invalid`, `htmlFor`.** Forms compose `<Field>` and never wire ARIA themselves.

```
<Field label="Email" required error={errors.email} helper="Useremo questa email per le notifiche">
  <Input type="email" name="email" />
</Field>
```

### 6.10 Tabs / SegmentedControl

**Tabs:** standard tablist with active underline. Use for navigation between subviews (DISHES ↔ BANQUETS, LIST ↔ MAP).

**SegmentedControl:** pill group with active fill. Use for filters (LUNCH / DINNER, today / week / month).

ARIA tabs pattern, arrow keys navigate, `aria-selected` and `aria-controls` set.

### 6.11 Card

**Variants:** `surface` (white bg, `shadow-sm`, `radius-lg`), `outline` (border only, no shadow), `interactive` (adds hover shadow + cursor pointer + focus ring).

**Anatomy:** optional `<CardHeader>`, `<CardBody>`, `<CardFooter>`. Composition over a single mega-component.

### 6.12 Badge / Status

**Variants:** `neutral`, `info`, `success`, `warning`, `danger`, `accent`.

**Sizes:** `sm` (16px tall), `md` (20px tall, default).

**Always pair color with icon and/or label.** Not color-alone.

### 6.13 Chip (closeable Badge)

Used for active filters. Has an X button. Follows the Tag ARIA pattern.

### 6.14 Avatar

Circle with initials or image. Sizes `xs/sm/md/lg/xl`. Falls back to colored bg with initials. `aria-label` with the user's full name.

### 6.15 Modal / Dialog

**Anatomy:** `[overlay] [container [header [title close-button]] [body] [footer [cancel primary]]]`

**Variants:**
- `default` — centered, `radius-xl`, `shadow-overlay`, max-w-md to 2xl.
- `sheet-bottom` — slides from bottom, full width, used on mobile by default for any modal.
- `sheet-side` — slides from right, used for filters/forms on tablet+.
- `confirm` — small (max-w-sm), icon + message + 2 buttons.

**A11y:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on title, focus trap, Esc closes, focus returned to invoker.

**Migration:** Every existing modal (`UserManagement`, `RolePermissions`, `ActivityLogs`, `ConfirmDeleteModal`, `PrintReservationsModal`, plus all the inline reservation/dish/banquet/staff form modals) gets wrapped in this primitive.

### 6.16 ConfirmDialog (specialization of Modal)

`confirm` variant of Modal with strict prop API: `title, message, confirmLabel, confirmVariant ('primary'|'destructive'), onConfirm, onCancel, isLoading`. Replaces every ad-hoc confirmation in the app.

### 6.17 Drawer / Sheet

Full-height side or bottom drawer. Used for: filters panels, settings, mobile navigation.

### 6.18 Toast / NotificationStack

**Anatomy:** `[icon] [title?] [message] [action?] [close]`

**Variants:** `success`, `error`, `info`, `warning`, `neutral`.

**Behavior:** auto-dismiss after 5s default (8s for errors, 0s — sticky — for actions). Stack max 4. Stack lives in `aria-live="polite"` region (`assertive` for errors).

### 6.19 Tooltip

Hover/focus tooltip. **Never** put critical info in tooltip-only — always reachable by keyboard. ARIA `role="tooltip"`, linked via `aria-describedby`.

### 6.20 Popover

Floating panel anchored to a trigger. Used by Combobox, date picker, filter dropdowns. Built on a single `Popper`/`floating-ui` primitive.

### 6.21 DropdownMenu (vs Popover)

Menu of actions (vs free-form Popover). Follows ARIA menu pattern. Use for row context menus, user menu in header.

### 6.22 Table / DataGrid

**Composable:** `<Table>`, `<TableHead>`, `<TableRow>`, `<TableCell>`. With `density` and `responsive` props. Below `md`, automatically collapses to a stack of cards (each row → card with label/value pairs) — controlled by `responsive="stack"` prop.

**Features:** sortable columns, sticky header, row selection, empty state slot, loading skeleton slot.

**A11y:** real `<table>` semantics, `<caption>` or `aria-label`, sortable columns expose `aria-sort`.

### 6.23 List / ListItem

Vertical list with consistent padding, dividers, and selection. Used for menu items, settings entries, filter options.

### 6.24 EmptyState

`[icon-or-illustration] [title] [description] [primary-action?]`. Replaces ~15 ad-hoc empty states.

### 6.25 Skeleton / LoadingSpinner

`<Skeleton variant="text|rect|circle" />` for placeholders. `<Spinner size="sm|md|lg" label?>` for inline loading. Loader2 is fine as the icon, but always wrapped in this primitive so a11y is consistent.

### 6.26 Pagination

Prev/Next + page indicator + optional jump. Real `<nav aria-label="Pagination">`. Already inlined in ActivityLogs and ReservationList.

### 6.27 Search input

Input variant with icon and clear button. `inputmode="search"`, `enterkeyhint="search"`, `role="searchbox"`.

### 6.28 DatePicker / TimePicker

We currently use native `<input type="date">` and ad-hoc time selects.

**Recommendation:** keep native on mobile (best UX, free a11y), wrap in our `Field` and `Input` primitives for visual consistency. Build a custom popover-based picker only if we need range selection or restricted dates (banquet event dates, staff time-off). Decision pending.

### 6.29 Connection state indicator

Small badge (top-right, fixed): green dot "Live" / red pulsing dot "Offline". Already exists in `useConnectionState`. Wrap in a primitive with `aria-live="assertive"` so screen readers announce drops.

### 6.30 VoiceInputButton

Microphone button with state: `idle | listening | processing | error`. Ring pulses while listening. Already exists in ReservationList — extract.

---

## 7. Screen inventory

For each screen: **purpose, current issues, target redesign notes, components used.**

### 7.1 LoginPage

- **Purpose:** Authenticate user.
- **Current state:** Recently redesigned — two-column with hero image, pill button, custom checkbox, hardcoded hex colors.
- **Issues:** Hardcoded hex (breaks theme system once tokens land); no skip link; form errors not linked via `aria-describedby`.
- **Target:** Refactor to use tokens once §3 lands. Otherwise keep visual.
- **Components:** Button (primary, pill), Input, Field, Checkbox, ConnectionState (none here).

### 7.2 Dashboard

- **Purpose:** Daily overview during service.
- **Current issues:** Dense card grid with 5+ different card styles; AI report button stands out inconsistently; staff calendar struggles on mobile; date picker is `<input type="date">` (good) but visually inconsistent with other inputs.
- **Target:** Mobile-first stack (date picker sticky top, then KPIs, then todos, shopping, staff). Tablet+ uses 2- or 3-column grid. Single Card primitive everywhere.
- **Components:** Card, Tabs (LUNCH/DINNER), DatePicker, Badge, Button, EmptyState, Skeleton, Modal (todo create/edit), List.

### 7.3 ReservationList

- **Purpose:** Manage reservations during service. Highest-traffic screen.
- **Current issues:** LIST/MAP toggle visually inconsistent with other tab patterns; filter panel always visible on desktop, hidden on mobile (good), but filter-chip layout drifts between filters; voice input UI is ad-hoc; status pills use color variations of indigo/emerald that fail color-blind tests.
- **Target:** Compact density on desktop (table), stack-card layout on mobile. Status pills get icon+label. Filter panel becomes a Drawer on mobile, sticky panel on desktop. MAP view stays as canvas; add keyboard alternative for table assignment.
- **Components:** Table (with `responsive="stack"`), Drawer (filters mobile), SegmentedControl (LIST/MAP), Card (in stacked rows), Badge (status), Chip (active filters), Search, Pagination, Modal (create/edit), VoiceInputButton, ConfirmDialog (delete/merge), Toast (sync feedback).

### 7.4 FloorPlan

- **Purpose:** Visual room/table layout, drag-drop, merge.
- **Current issues:** Drag-drop is mouse-only — fails keyboard a11y. Sidebar/canvas split eats mobile real estate. Status colors vary across tables (color-blindness risk).
- **Target:** Canvas as primary, sidebar collapses to bottom sheet on mobile. Add keyboard drag/drop (Space to pick up + arrow keys). Status pills integrated on each table glyph (icon + label, not color-only).
- **Components:** Drawer (settings), SegmentedControl (Drag/Select mode), Combobox (Room selector), Modal (table edit), Badge, ConfirmDialog (merge/split).

### 7.5 MenuManager

- **Purpose:** Manage dishes and banquet menus.
- **Current issues:** Tabs DISHES/BANQUETS visually styled differently from other tabs in app. Banquet course builder is dense and not keyboard-friendly. Allergen checkboxes are good but icons absent (would help dyslexic users).
- **Target:** Standard Tabs primitive. Banquet course builder rebuilt around accessible List with keyboard reorder. Allergen chips with icons.
- **Components:** Tabs, Search, Card (dish), Badge (allergens — with icons), Modal (dish/banquet create/edit), Button, EmptyState, List (banquet courses), Combobox (dish picker per course), Field, Input, Textarea.

### 7.6 StaffManagement

- **Purpose:** Staff roster, shifts, time-off.
- **Current issues:** Calendar-style shift view is dense; mobile view scrolls horizontally (bad). Time-off type colors overlap with reservation status colors (cyan, violet) — semantic confusion.
- **Target:** Calendar collapses to week-list on mobile. Time-off type uses neutral palette + icons. Filters as SegmentedControl.
- **Components:** Tabs, SegmentedControl (filters), Table (responsive stack), Card (staff member), Modal (create/edit shift, time-off), DatePicker, Badge, Switch (active status), List (calendar entries on mobile).

### 7.7 UserManagement

- **Purpose:** Create/edit/delete app users.
- **Current issues:** Lives inside a modal — should be a full settings page (admins manage users in batches; modal is too constrained). Password field UX inconsistent with LoginPage.
- **Target:** Promote to a Settings sub-route. Keep CRUD via inline drawer/modal. Password field uses Input password variant.
- **Components:** Table (responsive stack), Modal/Drawer (create/edit), Field, Input, Switch, Combobox (role), Badge (role), ConfirmDialog (delete).

### 7.8 RolePermissions

- **Purpose:** Per-role permission matrix.
- **Current issues:** Lives inside a modal too — would be better as a full page given the matrix size. No grouping of permissions.
- **Target:** Promote to a Settings sub-route. Group permissions by domain (Reservations, Menu, Staff, etc.), expand/collapse groups, "select all in group" checkbox.
- **Components:** Tabs (per role), Card (per group), Checkbox (with indeterminate for "select all"), Button, Toast.

### 7.9 ActivityLogs

- **Purpose:** Audit trail.
- **Current issues:** Modal-only; large dataset doesn't render well in a small dialog. Filters cluttered.
- **Target:** Promote to Settings sub-route. Filters in left rail (Drawer on mobile). Infinite scroll or pagination.
- **Components:** Table (responsive stack), Drawer (filters), Combobox (user/resource/action), DatePicker (range), Badge (action type), Pagination, EmptyState.

### 7.10 PrintReservationsModal

- **Purpose:** Generate printable guest list.
- **Current issues:** Print CSS is solid (`#print-area` system). Filter UI inside modal duplicates ReservationList filters.
- **Target:** Reuse the same FilterPanel component. Print CSS unchanged.
- **Components:** Modal, FilterPanel (shared), Button, RadioGroup (page size if needed), Checkbox.

### 7.11 ConfirmDeleteModal

- **Purpose:** Generic delete confirmation.
- **Target:** Replace with `ConfirmDialog` primitive (§6.16). One implementation, one place to fix bugs.

### 7.12 Settings (currently inline in App.tsx)

- **Purpose:** Admin shortcuts, account, integrations.
- **Target:** Real route with sub-pages: Account, Users (was modal), Roles & Permissions (was modal), Activity Logs (was modal), Integrations, **Accessibility** (new: theme, density, dyslexia mode toggle, motion).

### 7.13 Global / chrome

- **Header / topbar:** logo, view title, search (global?), connection state, notifications bell, user menu.
- **Sidebar (desktop) / bottom tabbar (mobile):** Dashboard, Reservations, Floor Plan, Menu, Staff, Settings.
- **Toast region:** fixed top-right desktop, top-center mobile.
- **Skip link:** "Salta al contenuto principale" → `#main`.

---

## 8. Patterns & rules

### 8.1 File structure (proposed)

```
components/
  ui/              # the design system primitives (§6)
    Button/
      Button.tsx
      Button.types.ts
      Button.test.tsx
      Button.stories.tsx
    Input/
    Field/
    Modal/
    ...
    index.ts       # barrel export
  layout/          # Page, Sidebar, TopBar, BottomNav
  domain/          # current screen components, refactored to compose ui/
    Dashboard/
    Reservations/
    FloorPlan/
    Menu/
    Staff/
    Settings/
tokens/
  tokens.css       # CSS custom properties (§3)
  tokens.ts        # mirrored for JS access where needed
hooks/
  useTheme.ts
  useDensity.ts
  useReducedMotion.ts
  useFocusTrap.ts
  useEscapeKey.ts
  useId.ts
```

### 8.2 Composition rules

1. **Domain components compose `ui/` primitives.** They never re-implement primitives.
2. **Primitives never know about domain.** A `<Modal>` knows nothing about reservations.
3. **Props for variants, slots for content.** `<Card variant="interactive">{children}</Card>`, not `<Card title="..." body="..." />`.
4. **No prop drilling beyond 2 levels.** Use Context for theme, density, toast, modal stack.
5. **Forward refs everywhere a real DOM node exists.** `forwardRef` on every primitive.

### 8.3 Naming

- Primitive components: PascalCase, single noun (`Button`, `Field`).
- Variant prop values: kebab-case strings (`variant="ghost"`, `density="compact"`).
- Token names: kebab-case CSS custom properties (`--color-bg-surface`).
- Tailwind classes: standard Tailwind names only — no arbitrary values in components (arbitrary OK in one-off domain code during transition).

### 8.4 Content / voice (Italian)

- **Tone:** professional but warm, never patronizing.
- **Verbs in command form for buttons:** "Salva", "Elimina", "Conferma" — never "Vuoi salvare?".
- **Errors:** describe problem and fix. "Email non valida. Controlla il formato (esempio: nome@dominio.it)."
- **Empty states:** description + clear next action. "Nessuna prenotazione per questa data. Aggiungi la prima."
- **Sentence case** in all UI copy except brand. No ALL CAPS body. Eyebrows/badges OK in caps with letter-spacing.
- **No emoji in core UI** — they fail screen readers in unpredictable ways. Lucide icons only.
- **Numbers and time:** `Intl.NumberFormat('it-IT')` for currency, `Intl.DateTimeFormat('it-IT')` for dates. No hand-rolled formatters.

### 8.5 Theming API

```css
:root[data-theme="light"] { /* light tokens */ }
:root[data-theme="dark"]  { /* dark tokens */ }
:root[data-contrast="more"] { /* high-contrast overrides */ }
:root[data-density="compact"] { /* row paddings, gap overrides */ }
:root[data-font="dyslexia"] { /* Atkinson Hyperlegible, +line-height */ }
```

Toggles persist to localStorage and respect `prefers-color-scheme`, `prefers-contrast`, `prefers-reduced-motion` on first load.

### 8.6 Testing strategy

- **Unit:** behavior of each primitive (jest + RTL).
- **Visual regression:** Storybook + Chromatic (or Playwright snapshots) for primitives + screen-level smoke shots.
- **A11y:** `jest-axe` on every primitive's stories. CI gate.
- **Keyboard:** Storybook play functions cover keyboard interaction for Modal, Combobox, Tabs, Table.
- **Contrast:** axe + manual color-blind simulation for status-heavy screens.

---

## 9. Phased migration roadmap

We are not freezing feature work. Migration runs **in parallel** with normal development.

### Phase 0 — Foundation (1 sprint)

- Land `tokens.css` + Tailwind v4 `@theme` config consuming the tokens.
- Land `useTheme`, `useDensity`, `useReducedMotion`, `useFocusTrap`, `useId`, `useEscapeKey`.
- Storybook scaffold + a11y/axe addon.
- Skip link + `<main id="main">`.
- Settings → Accessibility sub-page (theme, density, motion, font).
- **Outcome:** themes work end-to-end with zero components migrated yet.

### Phase 1 — Core primitives (2 sprints)

Deliver in this order so each unblocks the next:

1. `Button`, `IconButton`
2. `Input`, `Textarea`, `Field`, `Checkbox`, `RadioGroup`, `Switch`
3. `Card`, `Badge`, `Chip`, `Avatar`, `Skeleton`, `Spinner`
4. `Modal`, `ConfirmDialog`, `Drawer`
5. `Toast` + global ToastProvider
6. `Tabs`, `SegmentedControl`
7. `Tooltip`, `Popover`, `DropdownMenu`
8. `Combobox`, `Select`
9. `Table` (with responsive stack)
10. `EmptyState`, `Pagination`, `Search`
11. `ConnectionState`, `VoiceInputButton`

Each ships with: types, stories, tests, a11y test, docs.

### Phase 2 — High-traffic screens (2 sprints)

1. **LoginPage** — refactor to tokens (smallest, lowest risk, validates the system).
2. **ReservationList** — biggest impact (highest-traffic during service); replace inline buttons/inputs/modals/tables with primitives.
3. **Dashboard** — second-most-used.
4. **FloorPlan** — keyboard a11y added here.

### Phase 3 — Admin screens (1 sprint)

1. **MenuManager** — banquet course builder accessible.
2. **StaffManagement**.
3. **Settings** sub-routes (UserManagement, RolePermissions, ActivityLogs lifted out of modals).

### Phase 4 — Polish (1 sprint)

- Dark mode tuning per screen.
- Mobile bottom sheets everywhere.
- Print views audited.
- Performance pass: virtualize ActivityLogs and large reservation lists.
- A11y audit by external reviewer.

### Phase 5 — Ongoing

- Visual regression baseline, contrast CI gate, motion-safe sweep.
- New features land using primitives only — inline styles forbidden in PR review.

---

## 10. Open questions / decisions to lock

| ID | Decision | Recommendation | Status |
|---|---|---|---|
| **D-1** | Brand primary color: keep indigo, or commit to `#111827` (FlowOps)? | Commit to `#111827`; reclassify indigo as `--info`. | Pending |
| **D-2** | Where lives the dyslexia / theme toggle — Settings only, or also user dropdown? | Both. Canonical in Settings, shortcut in dropdown. | Pending |
| **D-3** | Default button shape: pill (current login) or rect (denser tables)? | Two shapes: `pill` (default) + `rect` (for toolbars/tables). | Pending |
| **D-4** | Native vs custom date/time pickers? | Native on mobile; custom popover only when we need ranges or restricted dates. | Pending |
| **D-5** | Tailwind v4 `@theme` vs CSS variables only? | Both: define in CSS vars, mirror as Tailwind theme so utilities work. | Pending |
| **D-6** | Hosting Storybook — local-only, GitHub Pages, Chromatic? | Chromatic if budget allows (visual regression included), GH Pages otherwise. | Pending |
| **D-7** | Italian-only confirmed for v1, but should we set up i18n scaffolding now to avoid retrofitting? | Yes — wrap all strings in a tiny `t()` helper that reads from one Italian file today; swap to react-intl later. | Pending |
| **D-8** | Where do print styles live? Currently in `index.css`. | Keep as-is; document in §8 patterns. | Resolved |
| **D-9** | Lifted UserManagement/RolePermissions/ActivityLogs out of modals — confirm? | Yes. They are admin pages, not transient dialogs. | Pending |
| **D-10** | Voice input: keep as ReservationList feature, or extract globally? | Extract `VoiceInputButton` primitive but keep parsing logic per-domain. | Pending |
| **D-11** | Tablet POS specific layout (between mobile and desktop)? | Yes — tablet (`md`) gets a dedicated layout with sidebar collapsed to icons + bottom-sheet modals. Service uses tablets heavily. | Pending |
| **D-12** | Connection-state badge position on mobile — top, or in topbar? | In topbar inline, with `aria-live` announcement on state change. | Pending |

---

## 11. Appendix — current pain points list (for traceability)

Pulled directly from the codebase scan. Each one is addressed by the plan above; cross-referenced.

1. LoginPage uses hardcoded hex colors. → §3.1, Phase 2.
2. Border radius drift (`rounded-xl` vs `rounded-2xl` for similar surfaces). → §3.4.
3. No documented elevation system; 4 shadow values used randomly. → §3.5.
4. Z-index values scattered (`z-10`, `z-20`, `z-30`, `z-[50]`, `z-[70]`). → §3.6.
5. Status colors collide across domains (cyan/violet appear in both reservations and time-off). → §3.1, §6.12.
6. ~300 inline buttons, ~150 inline inputs — no shared primitive. → §6.1, §6.3, Phase 1.
7. Forms wire ARIA inconsistently or not at all. → §4.5, §6.9 (Field).
8. Modals do not trap focus, do not return focus, do not close on Esc. → §4.2, §6.15.
9. Toasts lack `aria-live`. → §4.3, §6.18.
10. No skip link, no `<main>` landmark. → Phase 0.
11. Drag-drop on FloorPlan is mouse-only. → §4.2, §7.4.
12. Tables don't collapse on mobile, scroll horizontally instead. → §5.1, §6.22.
13. No dark mode. → §3.1, Phase 4.
14. No motion-safe handling. → §3.7, §4.4.
15. Native date inputs unstyled relative to other inputs. → §6.28.
16. UserManagement / RolePermissions / ActivityLogs trapped in modals. → §7.7–7.9, D-9.
17. Tailwind `text-slate-400` used for body text in places — fails AA contrast. → §3.1, §4.1.
18. Custom font sizes in LoginPage break the type scale. → §3.2.
19. Custom checkboxes are inconsistent across screens. → §6.6.
20. Connection-state pulse plays unconditionally regardless of `prefers-reduced-motion`. → §3.7, §4.4.

---

## 12. Next actions

1. Review this doc end-to-end. Lock the **D-1 to D-12** decisions in §10.
2. Approve the **Phase 0** scope so we can land tokens + a11y scaffolding without blocking other work.
3. Identify the **first screen to redesign** (recommendation: LoginPage as the dry run, then ReservationList for impact).
4. Decide on Storybook hosting (D-6) so visual regression and a11y CI gates can be wired up from day one.

When those four are answered, the next document is the **Phase 0 implementation plan** with tasks broken down to PRs.
