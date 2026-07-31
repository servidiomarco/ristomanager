---
version: "1.0"
name: "RistoManager Design System"
description: "Single source of truth for the RistoManager design language — a dense, real-time restaurant operations CRM. Staff read it mid-service, standing, often on a phone. Colour carries meaning: service (pranzo/cena), state (seated/arriving/pending/critical), and severity. Two themes, light and dark, with WCAG 2.2 AA as the floor."

# ---------------------------------------------------------------------------
# LAYER 1 — PRIMITIVES
# Raw ramps. Components must NEVER reference these directly; they exist only
# so the semantic layer below has something to resolve to.
# Provenance: [S] sampled from screenshots (approximate), [D] derived to hit
# contrast targets, [E] existing value carried over from index.css.
# ---------------------------------------------------------------------------
palette:
  neutral:
    0:   "#FFFFFF"   # [E]
    25:  "#FAFAFB"   # [D]
    50:  "#F7F7F8"   # [S] inner tiles
    100: "#F4F4F5"   # [S] row / list-item background
    200: "#E9E9EC"   # [S] hairline border, progress track
    300: "#D4D4D8"   # [D]
    400: "#A1A1AA"   # [D] decorative / disabled text only
    500: "#6F6F78"   # [D] muted text — 4.98:1 on surface, 4.53:1 on surface-row
    600: "#52525B"   # [D] secondary text — 7.73:1 on white
    700: "#3F3F46"   # [D]
    800: "#27272A"   # [D]
    900: "#18181B"   # [D]
    950: "#111113"   # [S] primary text

  ink:               # near-black primary action colour
    base:  "#111827" # [E] matches --color-brand
    hover: "#000000" # [E]
    fg:    "#FFFFFF" # [E]

  indigo:            # cena / imminent arrival / progress fill
    50:  "#F0F0FB"   # [D]
    100: "#E4E3F8"   # [D]
    200: "#C7C6F1"   # [D]
    300: "#A5A3E8"   # [D]
    400: "#8481DE"   # [D]
    500: "#6462CE"   # [D]
    600: "#5250C9"   # [S] solid fill — white text 6.27:1
    700: "#4340A8"   # [D] text on tint — 7.23:1
    800: "#383686"   # [D]
    900: "#2B2A63"   # [D]

  amber:             # pranzo / pending / attention / overdue
    50:  "#FBF4E6"   # [S]
    100: "#F6E8CC"   # [D]
    200: "#EDD5A3"   # [D]
    300: "#DFBB6E"   # [D]
    400: "#CFA13F"   # [D]
    500: "#B8860B"   # [S] decorative fill ONLY — see §3.3
    600: "#966D09"   # [D] solid fill — white text 4.68:1
    700: "#7A5807"   # [D] text on tint — 5.88:1
    800: "#5E4406"   # [D]
    900: "#453204"   # [D]

  green:             # seated / in service / live / ok
    50:  "#ECF5EF"   # [S]
    100: "#D5E9DD"   # [D]
    200: "#ADD3BC"   # [D]
    300: "#7FB795"   # [D]
    400: "#559A72"   # [D]
    500: "#3E7D5A"   # [S] sampled anchor
    600: "#316648"   # [D] solid fill — white text 6.72:1
    700: "#275238"   # [D] text on tint — 8.01:1
    800: "#1D3E2A"   # [D]
    900: "#152D1F"   # [D]

  red:               # critical / out of stock / destructive
    50:  "#FCEEEB"   # [S]
    100: "#F8D9D3"   # [D]
    200: "#EFB4A9"   # [D]
    300: "#E28878"   # [D]
    400: "#D25F4B"   # [D]
    500: "#C0392B"   # [S] solid fill — white text 5.44:1
    600: "#A02E22"   # [D] white text 7.22:1
    700: "#82251B"   # [D] text on tint — 8.23:1
    800: "#641C15"   # [D]
    900: "#4A1510"   # [D]

# ---------------------------------------------------------------------------
# LAYER 2 — SEMANTIC TOKENS
# This is what components reference. Defined twice: light and dark.
# ---------------------------------------------------------------------------
semantic:
  light:
    canvas:              "#EDEDF1"   # [D] page background — DARKER than cards
    surface:             "#FFFFFF"   # card
    surface-row:         "#F4F4F5"   # row / tile inside a card
    surface-chip:        "#FFFFFF"   # pill sitting on a row
    surface-inverted:    "#111827"   # emphasis tile
    surface-inverted-fg: "#FFFFFF"
    border:              "#E9E9EC"
    border-strong:       "#D4D4D8"
    border-focus:        "#5250C9"
    text-primary:        "#111113"
    text-secondary:      "#52525B"
    text-muted:          "#6F6F78"
    text-subtle:         "#A1A1AA"   # decorative / disabled ONLY — see §4.2
    action-bg:           "#111827"
    action-bg-hover:     "#000000"
    action-fg:           "#FFFFFF"
    backdrop:            "rgba(11, 11, 13, 0.40)"

  dark:
    canvas:              "#0B0B0D"   # [D] darkest — depth runs the other way
    surface:             "#141417"
    surface-row:         "#1C1C20"
    surface-chip:        "#26262B"
    surface-inverted:    "#F4F4F5"
    surface-inverted-fg: "#111113"
    border:              "#2A2A30"
    border-strong:       "#3A3A42"
    border-focus:        "#8481DE"
    text-primary:        "#F4F4F5"
    text-secondary:      "#C4C4CC"
    text-muted:          "#9A9AA4"   # 6.60:1 on surface
    text-subtle:         "#6E6E78"   # decorative / disabled ONLY
    action-bg:           "#F4F4F5"   # INVERTS in dark — see §2.1
    action-bg-hover:     "#FFFFFF"
    action-fg:           "#111113"
    backdrop:            "rgba(0, 0, 0, 0.60)"

# ---------------------------------------------------------------------------
# LAYER 3 — SEMANTIC STATE FAMILIES
# Every family carries the same five slots so any row, badge, or button can be
# recoloured by swapping family without changing structure.
# ---------------------------------------------------------------------------
states:
  seated:            # green — in sala, in uscita, live, connected, ok
    light: { tint: "#ECF5EF", tint-border: "#D5E9DD", text: "#275238", solid: "#316648", solid-fg: "#FFFFFF" }
    dark:  { tint: "#16271D", tint-border: "#243A2C", text: "#7FB795", solid: "#3E7D5A", solid-fg: "#FFFFFF" }

  arriving:          # indigo — cena, in arrivo, imminent, informational
    light: { tint: "#F0F0FB", tint-border: "#E4E3F8", text: "#4340A8", solid: "#5250C9", solid-fg: "#FFFFFF" }
    dark:  { tint: "#1A1A2E", tint-border: "#2A2A48", text: "#A5A3E8", solid: "#5250C9", solid-fg: "#FFFFFF" }

  pending:           # amber — pranzo, da confermare, overdue, low stock
    light: { tint: "#FBF4E6", tint-border: "#F6E8CC", text: "#7A5807", solid: "#B8860B", solid-fg: "#111113" }
    dark:  { tint: "#2A2109", tint-border: "#3F3212", text: "#DFBB6E", solid: "#B8860B", solid-fg: "#111113" }

  critical:          # red — esaurito, scadute, alerts, destructive
    light: { tint: "#FCEEEB", tint-border: "#F8D9D3", text: "#82251B", solid: "#C0392B", solid-fg: "#FFFFFF" }
    dark:  { tint: "#2B1310", tint-border: "#43201A", text: "#E28878", solid: "#C0392B", solid-fg: "#FFFFFF" }

  neutral:           # no state — default rows, free tables, informational
    light: { tint: "#F4F4F5", tint-border: "#E9E9EC", text: "#52525B", solid: "#D4D4D8", solid-fg: "#111113" }
    dark:  { tint: "#1C1C20", tint-border: "#2A2A30", text: "#C4C4CC", solid: "#3A3A42", solid-fg: "#F4F4F5" }

# ---------------------------------------------------------------------------
# LAYER 4 — SERVICE HUES (domain convention, product-wide)
# ---------------------------------------------------------------------------
service:
  pranzo: { family: "pending",  icon: "sun" }
  cena:   { family: "arriving", icon: "sunset" }

# ---------------------------------------------------------------------------
# LAYER 5 — SEQUENTIAL INTENSITY RAMPS (Affluenza heatmap)
# Light: intensity increases by getting darker/more saturated.
# Dark:  intensity increases by getting brighter/more saturated.
# ---------------------------------------------------------------------------
intensity:
  cena:
    light:
      - { bg: "#F1F1F3", fg: "#A1A1AA" }   # 0 — empty
      - { bg: "#E4E3F8", fg: "#383686" }
      - { bg: "#C7C6F1", fg: "#2B2A63" }
      - { bg: "#6462CE", fg: "#FFFFFF" }
      - { bg: "#4340A8", fg: "#FFFFFF" }   # 4 — peak
    dark:
      - { bg: "#1C1C20", fg: "#6E6E78" }
      - { bg: "#24234A", fg: "#C7C6F1" }
      - { bg: "#383686", fg: "#E4E3F8" }
      - { bg: "#5250C9", fg: "#FFFFFF" }
      - { bg: "#8481DE", fg: "#111113" }
  pranzo:
    light:
      - { bg: "#F1F1F3", fg: "#A1A1AA" }
      - { bg: "#F6E8CC", fg: "#7A5807" }
      - { bg: "#EDD5A3", fg: "#5E4406" }
      - { bg: "#966D09", fg: "#FFFFFF" }
      - { bg: "#7A5807", fg: "#FFFFFF" }
    dark:
      - { bg: "#1C1C20", fg: "#6E6E78" }
      - { bg: "#3F3212", fg: "#EDD5A3" }
      - { bg: "#5E4406", fg: "#F6E8CC" }
      - { bg: "#966D09", fg: "#FFFFFF" }
      - { bg: "#CFA13F", fg: "#111113" }

# ---------------------------------------------------------------------------
# TYPOGRAPHY
# ---------------------------------------------------------------------------
typography:
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif"
  styles:
    metric-xl:  { fontSize: "56px", fontWeight: 700, lineHeight: "1.0",  letterSpacing: "-0.03em", numeric: "tabular-nums" }
    display:    { fontSize: "44px", fontWeight: 700, lineHeight: "1.05", letterSpacing: "-0.03em" }
    metric:     { fontSize: "40px", fontWeight: 700, lineHeight: "1.05", letterSpacing: "-0.02em", numeric: "tabular-nums" }
    title:      { fontSize: "20px", fontWeight: 600, lineHeight: "1.3",  letterSpacing: "-0.015em" }
    subtitle:   { fontSize: "19px", fontWeight: 600, lineHeight: "1.35", letterSpacing: "-0.01em" }
    label:      { fontSize: "15px", fontWeight: 500, lineHeight: "1.35", letterSpacing: "-0.01em" }
    body:       { fontSize: "15px", fontWeight: 400, lineHeight: "1.5",  letterSpacing: "-0.005em" }
    caption:    { fontSize: "13px", fontWeight: 400, lineHeight: "1.4",  letterSpacing: "0" }

# ---------------------------------------------------------------------------
# SPACING — 4px ladder
# ---------------------------------------------------------------------------
spacing:
  base: "4px"
  scale: ["4px", "8px", "12px", "16px", "20px", "24px", "32px", "40px", "48px", "64px"]
  card-padding:  "24px"
  row-padding-y: "12px"
  row-padding-x: "16px"
  card-gap:      "20px"
  section-gap:   "24px"
  chrome-inset:  "12px"

# ---------------------------------------------------------------------------
# RADIUS
# ---------------------------------------------------------------------------
rounded:
  sm:    "8px"    # checkbox
  md:    "12px"   # icon chip, heatmap cell, table badge, input
  lg:    "16px"   # rows, tiles, toast
  xl:    "20px"   # inner tinted panels, popover
  "2xl": "24px"   # cards
  "3xl": "28px"   # sidebar, top bar, modal
  full:  "999px"  # pills, badges, avatars, progress bars

# ---------------------------------------------------------------------------
# ELEVATION
# ---------------------------------------------------------------------------
elevation:
  light:
    card:   "0 1px 2px rgba(16,17,25,0.04), 0 8px 24px rgba(16,17,25,0.05)"
    raised: "0 4px 8px rgba(16,17,25,0.06), 0 20px 48px rgba(16,17,25,0.10)"
  dark:
    card:   "0 1px 2px rgba(0,0,0,0.40)"
    raised: "0 12px 32px rgba(0,0,0,0.55)"

# ---------------------------------------------------------------------------
# MOTION
# ---------------------------------------------------------------------------
motion:
  level: "minimal"
  tokens:
    instant: { duration: "50ms",   easing: "linear",                          use: "press feedback" }
    fast:    { duration: "120ms",  easing: "cubic-bezier(0.2, 0, 0.2, 1)",    use: "hover, focus, colour" }
    base:    { duration: "180ms",  easing: "cubic-bezier(0.2, 0, 0.2, 1)",    use: "default transitions" }
    slow:    { duration: "260ms",  easing: "cubic-bezier(0.16, 1, 0.3, 1)",   use: "modal / sheet enter" }
    pulse:   { duration: "1400ms", easing: "ease-in-out",                     use: "live / connection indicator" }
  reducedMotion: "prefers-reduced-motion: reduce disables all transitions over 180ms and all keyframe animations. The connection pulse becomes a steady colour, never a removed signal."

# ---------------------------------------------------------------------------
# BREAKPOINTS (mobile-first)
# ---------------------------------------------------------------------------
breakpoints:
  sm:    "480px"   # large phones — most service-floor devices
  md:    "768px"   # tablets, POS terminals
  lg:    "1024px"  # small laptops, back office
  xl:    "1280px"  # desktop, admin
  "2xl": "1536px"  # wide desktop

# ---------------------------------------------------------------------------
# Z-INDEX — documented layers, never raw values
# ---------------------------------------------------------------------------
zIndex:
  base:     0
  raised:   10   # sticky table headers, FABs
  dropdown: 20   # selects, autocomplete
  popover:  30   # popovers, tooltips
  banner:   40   # offline / maintenance banners
  overlay:  50   # modal backdrop
  modal:    60   # modal content
  toast:    70   # always on top
  debug:    9999 # dev only

# ---------------------------------------------------------------------------
# DENSITY — applied per route; modifies padding, icon size, gaps. NEVER font-size.
# ---------------------------------------------------------------------------
density:
  comfortable: { row-padding-y: "16px", icon: "20px", gap: "16px" }  # mobile, Settings, Login
  default:     { row-padding-y: "12px", icon: "18px", gap: "12px" }  # most screens
  compact:     { row-padding-y: "8px",  icon: "16px", gap: "8px"  }  # ReservationList in service, ActivityLogs

# ---------------------------------------------------------------------------
# TOUCH TARGETS
# ---------------------------------------------------------------------------
touchTarget:
  mobile:  "44px"   # WCAG 2.2 SC 2.5.8 recommended
  desktop: "32px"   # dense tables only; focus ring covers the larger hit area
  minimum: "24px"   # absolute floor, never below

# ---------------------------------------------------------------------------
# ICONS
# ---------------------------------------------------------------------------
icons:
  set: "lucide-react"
  treatment: "linear"
  strokeWidth: 1.75
  sizes: { sm: "16px", md: "18px", lg: "20px" }
---

> **Single source of truth** for the RistoManager design language.
> Supersedes and replaces `design-system-audit.md` (deleted). Migration status and
> per-screen progress deliberately live outside this document — see §14.

---

## 1. What this system is for

RistoManager is a real-time restaurant CRM. Staff read it mid-service, standing, often on a
phone, under time pressure. Every decision below serves one goal: **let someone find the
thing that needs action in under a second.**

That is why colour is not decoration here — it is an encoding system, defined precisely in
§3. It is also why surfaces are flat and opaque rather than glassy: anything that softens
the boundary between a row and its background costs legibility on a dense list, and blur
costs frame budget on a mid-range phone during live socket updates.

**Five rules that settle downstream arguments:**

1. **Semantic tokens, never literals.** A component references `states.pending.text`, not
   `#7A5807`. Theme switching is then a variable swap and nothing else.
2. **State is encoded at least twice.** Never colour alone — see §4.3.
3. **Density is the point.** Restraint in ornament buys room for information.
4. **Depth is structural, not decorative.** Four nested surface levels, each meaning
   "contained by the one above". Shadow reinforces; it never substitutes.
5. **Mobile is a first-class target**, not a reflow of desktop.

---

## 2. Surfaces & depth

Four levels, always in the same order. This is the backbone of every screen.

| Level | Token | Light | Dark | Used for |
|---|---|---|---|---|
| 0 | `canvas` | `#F0F0F3` | `#0B0B0D` | Page background |
| 1 | `surface` | `#FFFFFF` | `#141417` | Cards, sidebar, top bar |
| 2 | `surface-row` | `#F4F4F5` | `#1C1C20` | Rows, tiles, list items |
| 3 | `surface-chip` | `#FFFFFF` | `#26262B` | Pills sitting on a row |

Plus one special level: **`surface-inverted`** — near-black in light, near-white in dark.
Reserved for a single high-emphasis element per view. Using it twice destroys its meaning.

### 2.1 Depth runs opposite in the two themes

In **light**, cards are *lighter* than the canvas and soft shadows lift them.

In **dark**, shadows are nearly invisible against a near-black canvas, so **elevation is
expressed as lightness**: canvas darkest, every nested level steps *lighter*. Level 3
(`#26262B`) is lighter than level 2 (`#1C1C20`), which is lighter than level 1 (`#141417`).
Hairline borders reinforce boundaries where the step alone is too subtle.

The consequence: **never port a light-mode shadow into dark mode.** It reads as smudge.

The primary action colour inverts for the same reason. Near-black is high-emphasis on a
light canvas and invisible on a dark one, so `action-bg` becomes near-white in dark with
dark text. This keeps indigo meaning "cena / arriving" rather than overloading it with
"primary action".

### 2.2 No glass

This system is opaque. No `backdrop-filter`, no translucent surfaces, no gradient border
shells. If something needs to feel raised, raise it with a surface step and the `card` shadow.

---

## 3. Colour as an encoding system

Three independent axes. A single element may participate in all three.

### 3.1 Service hue — a product-wide convention

**Pranzo is always amber and carries a sun icon. Cena is always indigo and carries a sunset
icon.** This holds in stat cards, occupancy bars, Affluenza panels, summary tiles, and
anywhere the app splits by service. It is not a per-screen choice.

Never use amber for a dinner metric or indigo for a lunch metric, even when it looks better
locally. The convention is only useful if it is absolute.

### 3.2 State families

Five families, five slots each. Any row, badge, or button is recoloured by swapping family —
the structure never changes.

| Family | Meaning | Examples |
|---|---|---|
| `seated` | In service, live, ok | In sala, In uscita, Live indicator |
| `arriving` | Imminent, informational, cena | In arrivo, Arrivato, progress fill |
| `pending` | Needs action, overdue, pranzo | Da confermare, scadenze, sotto scorta |
| `critical` | Failed, empty, destructive | Esaurito, attività scadute, cancel |
| `neutral` | No state | Default rows, free tables |

Slots: `tint`, `tint-border`, `text`, `solid`, `solid-fg`.

### 3.3 Amber takes dark text

Amber is a light hue, so it behaves differently from the other families: **white text does
not work on it.** White on the reference gold `#B8860B` measures only 3.25:1, well under AA.

The resolution is to keep the gold and flip the text:

- **`states.pending.solid` = `#B8860B` with `solid-fg` = `#111113`** — 5.80:1, clears AA
  comfortably, and matches the gold in the reference designs. This holds in **both** themes;
  amber is the only family whose foreground does not invert between light and dark.
- Darkening the fill instead was tried and rejected: the darkest amber that supports white
  text is `#9A6F09`, which reads as brown rather than gold and loses the warmth the palette
  depends on.

So: **at body size, never put white text on amber.** Every other solid family takes white;
amber takes near-black.

**The one exception is large text.** WCAG drops the floor to 3:1 at ≥18.66px **bold** or
≥24px at any weight, and white on `#B8860B` measures 3.25:1 — compliant at those sizes only.
The threshold moves with weight, which is easy to trip over:

| Weight | Minimum size for white on amber |
|---|---|
| 700 (bold) | 18.66px |
| under 700 | 24px |

Below the relevant threshold the foreground must be near-black. **Changing either the size or
the weight of such a badge means re-checking the other** — dropping a 24px regular numeral to
19px, or a 19px bold one to regular, silently breaks compliance.

#### Known deviation

The **"Attività di oggi" count** on the Dashboard renders white at 16px regular — below the
threshold, at 3.25:1. This is a deliberate product decision, taken with the trade-off
understood, and is recorded here so it is not mistaken for an oversight or copied as
precedent. Setting its foreground to `pending.solid-fg` restores 5.80:1 at any size.

### 3.4 Severity ramps in lists

Where a list is ordered by urgency (Sotto scorta, Attività), the row background, its
secondary text, and its metric shift family **together**: zero/failed → `critical`,
low/overdue → `pending`, normal → `neutral`. Three coordinated signals, not one.

---

## 4. Accessibility

### 4.1 Contrast floor

WCAG 2.2 AA: **4.5:1** body text, **3:1** large text (≥18.66px bold or ≥24px) and non-text UI
boundaries. Every `text` slot was derived against its own `tint` and verified.

| Pair | Ratio |
|---|---|
| `seated.text` on `seated.tint` | 8.01:1 |
| `arriving.text` on `arriving.tint` | 7.23:1 |
| `pending.text` on `pending.tint` | 5.88:1 |
| `critical.text` on `critical.tint` | 8.23:1 |
| White on `seated.solid` | 6.72:1 |
| White on `arriving.solid` | 6.27:1 |
| Near-black on `pending.solid` | 5.80:1 |
| White on `critical.solid` | 5.44:1 |
| `text-muted` on `surface` (light) | 4.98:1 |
| `text-muted` on `surface-row` (light) | 4.53:1 |
| `text-muted` on `surface` (dark) | 6.60:1 |

### 4.2 The one token that does not pass

`text-subtle` (`#A1A1AA` / `#6E6E78`) measures ~2.6:1. Permitted **only** for disabled
controls and decorative text, both WCAG-exempt. It must never carry information that exists
nowhere else on screen.

### 4.3 Colour blindness

Seated-green and pending-amber sit adjacent in Timeline arrivi — precisely the pair
deuteranopia and protanopia collapse. Two mandatory mitigations:

1. **Redundant encoding.** Every state-tinted row also carries a distinct badge fill, button
   treatment, and text label. Remove the colour and the row is still readable.
2. **Lightness separation.** `seated.solid` was darkened from `#3E7D5A` to `#316648` partly
   for contrast, partly to separate it from `pending.solid` in greyscale. The remaining
   separation is modest — which is why rule 1 is not optional.

### 4.4 Keyboard & focus

Every interactive element needs a visible `:focus-visible` ring: 2px `border-focus`, 2px
offset. Never remove outlines without replacing them. Tab order follows visual order. Modals
trap focus and restore it to the trigger on close. Escape closes any dismissible overlay.

### 4.5 Screen readers

Every icon-only control needs an accessible name. Live regions (`aria-live="polite"`) for
socket-driven updates — reservation arrivals, connection state — never `assertive` except
for errors that block work. Decorative icons take `aria-hidden="true"`.

### 4.6 Forms

Every control has a programmatically associated `<label>`. Errors are announced via
`aria-describedby` and stated in text, never colour alone. Required fields are marked in the
label, not by asterisk convention alone.

---

## 5. Typography

Eight styles. The stack leads with the system font so it renders natively on Apple hardware
and degrades cleanly elsewhere — **never specify bare `SF Pro Display`**, which is not
licensed for web distribution.

| Style | Size / weight | Used for |
|---|---|---|
| `metric-xl` | 56 / 700 | Hero percentage ("30%") |
| `display` | 44 / 700 | Page greeting |
| `metric` | 40 / 700 | Card metrics |
| `title` | 20 / 600 | Card titles |
| `subtitle` | 19 / 600 | Row names |
| `label` | 15 / 500 | Nav items, buttons |
| `body` | 15 / 400 | Body text |
| `caption` | 13 / 400 | Meta lines |

**All numerals that update live must use `font-variant-numeric: tabular-nums.`** Counts,
times, and occupancy figures change on socket events; without tabular figures the layout
jitters on every update.

### 5.1 Two-tone numerics

Fractions render as bold value plus muted denominator: **`73`**`/86`, **`8`**`/484`. Value
takes `text-primary`, separator and denominator take `text-muted`. Applies to every
`n/total` in the product.

---

## 6. Responsive & density

### 6.1 Mobile-first patterns

Default styles target **<sm**: single column, full-width, scroll-Y. Everything ≥`sm` is
enhancement.

- Navigation collapses to a bottom tab bar at `<md`.
- Tables collapse to **stacked cards** at `<md` — each row becomes a card of key/value pairs.
- Modals become **bottom sheets** at `<md`: full-width, slide up, swipe-down to dismiss.
- Forms stretch full-width with a `max-w-prose` cap.
- The floor plan becomes a pinch-zoomable canvas at `<md`, with a table list as fallback.

### 6.2 Touch ergonomics

44×44 minimum on mobile. Primary actions reachable with one thumb — bottom of the viewport.
Long-press is a context menu only where documented, and never blocks text selection.

### 6.3 Density

Three tiers applied per route (see frontmatter). Density modifies row padding, icon sizes,
and gaps — **never font-size.** Shrinking type to fit more rows is not a density change, it
is an accessibility regression.

---

## 7. Components

**Provenance.** Components marked **[obs]** were observed directly in reference screenshots
and are specified with confidence. Components marked **[der]** were derived from the token
system without a visual reference — they are internally consistent and meet the contrast
floor, but expect to refine them against real screens during the revamp.

### 7.1 Actions

**Button** [obs] — seven variants:

| Variant | Appearance | Use |
|---|---|---|
| `primary` | `action-bg` fill, `action-fg` text, `rounded.full` | Main action (Conferma, Arrivato, +) |
| `secondary` | `surface` fill, `border` hairline, `text-primary` | Alternative (In uscita) |
| `state-solid` | `states.X.solid` fill, `solid-fg` text | Coloured action (Ordina, Assegna) |
| `state-tint` | `states.X.tint` fill, `states.X.text` | Lower-emphasis coloured action |
| `quiet` | `surface-row` fill, `text-secondary` | Low emphasis (Libera) |
| `destructive-icon` | `critical.tint` fill, `critical.text` glyph | Cancel / dismiss (×) |
| `text` | No fill, `text-primary`, medium weight | Navigation (Apri →) |

Minimum height 40px, horizontal padding 16px, 44px hit area. **`padding: 0` is never valid.**
Loading state swaps the label for a spinner and keeps the button's width — never let a
button resize mid-action.

**Destructive actions stay quiet.** Cancelling a reservation is a pale-tinted icon button
beside a solid primary — never a loud red block. Visual weight belongs to the action someone
wants, not the one they might regret.

**IconButton** [obs] — `rounded.md` or `rounded.full`, icon at `icons.md`, 44px hit area
regardless of visual size. Requires `aria-label`. Two fills: **bare** (transparent, tinting
on hover) for controls inside a row or card, and **filled** (`surface-row`) for standalone
controls in chrome, where a visible target matters more than restraint. Filled icon buttons
sitting in a row with a `primary` action share its diameter so the cluster reads as one set.

### 7.2 Form controls

**Input** [der] — height 44 (mobile) / 40 (desktop), `surface` fill, `border` hairline,
`rounded.md`, 14px horizontal padding, `body` type. Placeholder `text-subtle`. Focus: 2px
`border-focus` ring, 2px offset. Error: `critical` tint border plus message below. Disabled:
`surface-row` fill, `text-subtle`, `cursor: not-allowed`.

**Textarea** [der] — as Input, `rounded.lg`, min-height 96px, vertical resize only.

**Select** [der/obs] — as Input plus trailing chevron. An observed **pill variant** exists
for inline filters (`Cucina ⌄` in Spesa): `surface-row` fill, `rounded.full`, `label` type.

**SearchInput** [der] — as Input, `rounded.full`, leading search icon at `text-muted`,
optional trailing clear button. Debounce ≥200ms before firing.

**Checkbox** [obs] — 20px, `rounded.sm`, `border-strong` outline, 44px hit area. Checked
fills `action-bg` with a white glyph. A circular variant is used in task lists.

**Radio** [der] — 20px circle, `border-strong` outline. Checked shows an `action-bg` dot at
8px. Always inside a `RadioGroup` with `role="radiogroup"` and arrow-key navigation.

**Switch** [der] — 44×26 track at `rounded.full`, 22px knob. Off: `neutral.solid` track. On:
`action-bg` track. Transition at `motion.fast`. For immediate-effect settings only — never as
a form field requiring a save.

**Field** [der] — the composite wrapper: label (`label` type, `text-secondary`) → control →
helper (`caption`, `text-muted`) or error (`caption`, `critical.text`). Error **replaces**
helper. Wires `htmlFor`, `aria-describedby`, and `aria-invalid` automatically.

**DatePicker / TimePicker** [der] — Popover containing a grid of day cells at `rounded.md`,
44px minimum. Today: `border-focus` ring. Selected: `action-bg` fill. Availability may be
shaded using the `intensity` ramp of the relevant service. Always pair with a typable text
input — never calendar-only.

### 7.3 Display

**Card** [obs] — `surface` fill, `rounded.2xl`, `card-padding`, `elevation.card`. Header is a
`title` optionally preceded by an icon chip, meta on the line below at `caption`/`text-muted`,
optional `text` button top-right.

**StateRow** [obs] — `states.X.tint` fill, `rounded.lg`, `row-padding`. Its badge, metric, and
action button all take the same family. The most repeated pattern in the product.

**IconChip** [obs] — rounded square at `rounded.md`, 32 or 36px, `surface-row` fill (or
`states.X.tint` when marking a service), containing one linear icon.

**EntityChip** [obs] — pill at `rounded.full`, `surface-row` fill, circular initials avatar
plus name at `label`. Wraps freely in a flow row. Used for staff on shift.

**Avatar** [obs] — circle at 24/32/40px. Initials at `label`, `surface-row` fill,
`text-secondary`. The user avatar in chrome inverts to `action-bg` with `action-fg`.

**TableNumberBadge** [obs] — rounded square at `rounded.md`, ~40px. `seated.solid` with white
numerals when occupied, `neutral.solid` when free, `pending.tint` when unassigned.

**CountBadge** [obs] — pill at `rounded.full`, minimum 20px wide so two digits and `99+` fit,
`states.X.solid` fill with `solid-fg` numeral at `tabular-nums`. Where it overlaps another
surface (an icon button, a collapsed nav icon) it takes a 2px ring in the colour of the
surface behind it.

Choosing a fill:

- **`critical` (red)** — unread or unseen items awaiting someone: messages, emails, calls,
  notifications, unseen payments. This is the common case in navigation.
- **`pending` (amber)** — items needing a decision rather than merely attention, e.g. the
  "Da confermare" count on a dashboard card.
- **no badge** — a count that describes the size of a collection rather than a backlog.
  Render it as a plain `text-muted` number.

**ProgressBar** [obs] — track at `border` colour, `rounded.full`, 8–10px tall. Fill may be
segmented by service, amber then indigo, left to right. A labeled variant places a
service-coloured caption left of each bar. Empty shows the bare track with the fraction
dropped to `text-muted`.

**HeatmapCell** [obs] — rounded rect at `rounded.md`, minimum 44px wide. Background and
foreground from the `intensity` ramp, indexed 0–4. **The numeral is always printed**, so the
ramp reinforces rather than carries.

**Skeleton** [der] — `surface-row` fill at the radius of the element it replaces. Shimmer
sweeps at `motion.slow`. Under `prefers-reduced-motion` it is static, never removed.

**EmptyState** [obs] — never blank space. Full-width panel at `surface-row`, `rounded.lg`,
centred `text-muted` copy naming what is absent ("Nessuna prenotazione a pranzo"). Inside a
grid it spans the columns it replaces. Where an action is possible, follow the copy with a
`text` button — see §10.

### 7.4 Navigation

**NavItem** [obs] — three tiers, all required: **active** (`action-bg` pill, `action-fg`
text), **enabled** (transparent, `text-primary`), **disabled** (transparent, `text-subtle` for
*both* label and icon).

Counts sit right-aligned and follow the CountBadge rule below: an **unread or unseen count
is a red badge** (Conversazioni, Messaggi, Email, Pagamenti), because it represents work
waiting on someone. A count that merely describes the size of a collection is a plain
`text-muted` number with no badge. The distinction is *does this number decay when someone
does their job* — if yes, it is a badge.

**SegmentedControl / Tabs** [obs] — track at `surface-row`, `rounded.full`. Active segment is
`surface` with `elevation.card` and `text-primary`; inactive are `text-muted`. Arrow-key
navigation, `role="tablist"` when switching panels.

**Pagination** [der] — pill buttons at `rounded.full`, 40px. Current page uses `action-bg`.
Prefer "load more" or virtualised scroll on mobile.

**Chrome** [obs] — sidebar and top bar are **floating cards**: `surface` fill, `rounded.3xl`,
inset from the viewport by `chrome-inset`, sitting on the canvas. Not edge-to-edge rails. At
`<md` the sidebar becomes a bottom tab bar.

### 7.5 Overlays

**Modal** [der] — `surface` fill, `rounded.3xl`, `elevation.raised`, max-width 560px,
`card-padding`. Backdrop uses the `backdrop` token at `z.overlay`; content at `z.modal`.
Focus trapped, Escape closes, focus returns to the trigger. At `<md` becomes a bottom sheet:
full-width, top corners only, slide up at `motion.slow`.

**ConfirmDialog** [der] — a Modal with title, body, and an action row. **The safe action is
the primary.** A destructive confirmation uses `state-solid` with the `critical` family for
the confirm button and a `secondary` cancel — this is the one place `critical` may carry
full visual weight, because the user has already committed to the intent.

**Drawer / Sheet** [der] — side panel at `≥md` (max-width 420px, full height, `rounded.3xl` on
the inner edge), bottom sheet at `<md`. Same focus rules as Modal.

**Toast** [der] — `surface` fill, `rounded.lg`, `border` hairline, `elevation.raised`, at
`z.toast`. Variants take state families via a leading icon and `tint-border`. Stacks
bottom-right at `≥md`, top at `<md`. Auto-dismiss after 5s — **except errors, which persist
until dismissed.** Announced via `aria-live="polite"`.

**Tooltip** [der] — `surface-inverted` fill, `surface-inverted-fg` text, `rounded.md`,
`caption` type, max-width 240px. Never the sole carrier of information; touch devices get no
hover, so anything essential belongs in visible text.

**Popover** [der] — `surface` fill, `rounded.xl`, `elevation.raised`, 16px padding, at
`z.popover`. Dismisses on outside click and Escape.

**DropdownMenu** [der] — `surface` fill, `rounded.lg`, `elevation.raised`, at `z.dropdown`.
Items are 40px rows with `surface-row` hover. Arrow-key navigation, type-ahead. Distinct from
Popover: menus hold *actions*, popovers hold *content*.

### 7.6 Data

**Table / DataGrid** [der] — header sticky at `z.raised`, `surface-row` fill, `label` type at
`text-muted`. Rows separated by `border` hairlines, no zebra striping — state tints are the
signal and stripes would fight them. Hover fills `surface-row`. Numeric columns are
right-aligned with `tabular-nums`. Row density follows the density tier. At `<md` collapses
to stacked cards per §6.1.

### 7.7 Domain

**ConnectionIndicator** [obs] — pill at `rounded.full` using the `seated` family when live: a
6px dot plus label. The dot pulses at `motion.pulse`. Degraded uses `pending`, offline uses
`critical`. Under reduced motion the pulse becomes a steady colour — **the signal is never
removed, only the animation.**

**VoiceInputButton** [der] — circular `primary` button at 56px. Recording state switches to
the `critical` family with a `motion.pulse` ring. Requires a visible text label or
`aria-label` describing the current state, since the colour change alone is not sufficient.

---

## 8. Composition rules

1. **Domain components compose `ui/` primitives.** They never re-implement them.
2. **Primitives never know about domain.** A `<Modal>` knows nothing about reservations.
3. **Props for variants, slots for content.** `<Card variant="interactive">{children}</Card>`,
   not `<Card title="..." body="..." />`.
4. **No prop drilling beyond two levels.** Use context for theme, density, toast, modal stack.
5. **Forward refs** wherever a real DOM node exists.
6. **The tinted-row rule.** When a row takes a state tint, its badge, metric, and action take
   the same family. Partial application looks like a bug.
7. **The one-inversion rule.** At most one `surface-inverted` element per view.
8. **The nesting rule.** Surfaces step in order — a level-3 chip belongs on a level-2 row
   inside a level-1 card. Skipping a level flattens the hierarchy.

   This one has teeth: a level-2 `surface-row` chip placed directly on the canvas measures
   **1.03:1** against it and is effectively invisible. A control that sits on the canvas must
   be level-1 — `surface` with `elevation.card` — or live inside something that is. The fix
   for a washed-out control is almost never a darker fill; it is putting it at the right
   depth.
9. **The redundancy rule.** State is never colour alone. See §4.3.

---

## 9. Naming

- Primitive components: PascalCase, single noun — `Button`, `Field`.
- Variant prop values: kebab-case strings — `variant="state-solid"`, `density="compact"`.
- Token names: kebab-case CSS custom properties — `--color-surface-row`.
- Tailwind: standard class names only. No arbitrary values inside `ui/` primitives
  (arbitrary values are tolerated in one-off domain code during the transition).

---

## 10. Voice & content (Italian)

- **Tone:** professional but warm, never patronizing.
- **Buttons take the imperative:** "Salva", "Elimina", "Conferma" — never "Vuoi salvare?".
- **Errors describe the problem and the fix:** "Email non valida. Controlla il formato
  (esempio: nome@dominio.it)."
- **Empty states describe the absence and the next action:** "Nessuna prenotazione per questa
  data. Aggiungi la prima."
- **Sentence case everywhere** except the brand. No ALL CAPS body text. Eyebrows and badges
  may use caps with letter-spacing.
- **No emoji in core UI** — they fail screen readers unpredictably. Lucide icons only.
- **Numbers and dates** go through `Intl.NumberFormat('it-IT')` and
  `Intl.DateTimeFormat('it-IT')`. No hand-rolled formatters.

---

## 11. Theming API

Dark mode is **class-based**, matching what `index.css` already implements:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

Theme is toggled by putting `.dark` on the root element. Density and contrast are additive
data attributes:

```css
:root[data-density="compact"] { /* row padding, gap overrides */ }
:root[data-contrast="more"]   { /* high-contrast overrides */ }
```

Preferences persist to localStorage and respect `prefers-color-scheme`, `prefers-contrast`,
and `prefers-reduced-motion` on first load.

> **Note:** the superseded audit proposed `:root[data-theme="light|dark"]`. The codebase uses
> the class-based variant above. This document follows the code. Do not introduce a second
> theming mechanism.

---

## 12. File structure

```
components/
  ui/              # design system primitives (§7)
    Button/
      Button.tsx
      Button.types.ts
      Button.test.tsx
    Input/
    Field/
    Modal/
    index.ts       # barrel export
  layout/          # Page, Sidebar, TopBar, BottomNav
  domain/          # screen components, composing ui/
hooks/
  useTheme.ts
  useDensity.ts
  useReducedMotion.ts
  useFocusTrap.ts
```

Tokens live in `index.css` under Tailwind v4 `@theme`, which is already the case — this
document is the specification, `index.css` is the implementation.

---

## 13. Testing

- **Unit:** behaviour of each primitive (Jest + RTL).
- **A11y:** `jest-axe` on every primitive. CI gate.
- **Keyboard:** explicit coverage for Modal, Select, Tabs, Table, DropdownMenu.
- **Contrast:** automated check plus manual colour-blind simulation on status-heavy screens
  — Timeline arrivi and Sotto scorta in particular, per §4.3.
- **Visual regression:** snapshots for primitives and screen-level smoke shots.

---

## 14. Scope of this document

This document defines the **design language**: tokens, rules, and component specifications.

It deliberately does **not** track migration state, per-screen progress, or phased rollout
plans. That information goes stale fast — the document this one replaced listed 13 screens
while the codebase had grown to 64 components — and stale content in a source of truth is
worse than no content. Track adoption in your issue tracker instead.

---

## 15. Provenance

Colours are tagged `[S]` sampled, `[D]` derived, or `[E]` existing in the frontmatter.
Components are tagged `[obs]` observed or `[der]` derived in §7.

`[S]` values were sampled from compressed, anti-aliased screenshots and are approximate —
intent rather than specification. Where a sampled value failed a contrast target, the shipped
token was derived and the original kept in the ramp for reference: this affected
`pending.solid` (`#B8860B` → `#966D09`) and `seated.solid` (`#3E7D5A` → `#316648`).

**The dark theme has no screenshot source.** It was derived entirely from the light theme
using §2.1 and verified against §4.1. Review it on a real screen before shipping — derived
dark palettes tend to look flatter in practice than they measure.

**The `[der]` components in §7 — the entire form family, all overlays, and the data
table — have no visual reference.** They are consistent with the token system and meet the
contrast floor, but they are proposals. Expect to adapt them during the revamp.
