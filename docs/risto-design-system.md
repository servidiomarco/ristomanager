---
version: "1.1"
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
    backdrop:            "rgba(11, 11, 13, 0.50)"   # heavier than dark's, deliberately — see below

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
  fontFamily: "'Hanken Grotesk', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
  fontWeights: [400, 500, 600, 700, 800]   # the only weights loaded; 300 is not available
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
  compact:     { row-padding-y: "8px",  icon: "16px", gap: "8px"  }  # ActivityLogs, long log-style tables

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

Slots: `tint`, `text`, `solid`, `solid-fg`.

`tint-border` is listed against each family below but **is not implemented** — there is no
`--ds-*-tint-border` in `index.css`. It was drawn as the hairline that would let a tinted
pill read as a shape on the canvas, and measured against that job it does not work: at
`arriving` it is 1.08:1 against `--ds-canvas`, where the fill it was meant to rescue is
1.03:1. Pills take a neutral `border-strong` hairline instead (§7.4). Either build the slot
for a purpose it can serve, or drop it from the families — do not reach for it expecting a
border to exist.

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

### 3.5 Categorical — six hues that mean nothing

The five families above all **mean** something. Some things need colour that means nothing at
all, only *different from that other one*: banquet events sharing a floor map, task categories
in a list. Reaching for a state family there makes the colour lie — an Inventario dot in amber
reads as *overdue* to anyone who has learned what amber means everywhere else.

`--ds-cat-1…6` exists for that, and only that. Six hues sitting in the gaps the families leave
(green 150°, amber 43°, indigo 245°, red 7°), 25°–328° apart from each other.

| | hue | light solid | dark solid |
|---|---|---|---|
| `cat-1` | teal 182° | `#0F6E70` | `#2E9A9C` |
| `cat-2` | azure 209° | `#2A6BA8` | `#4B8FD1` |
| `cat-3` | violet 274° | `#7145A8` | `#9A6FD1` |
| `cat-4` | magenta 328° | `#A83A70` | `#D06498` |
| `cat-5` | moss 80° | `#5A7A24` | `#85A845` |
| `cat-6` | clay 25° | `#A05A34` | `#C98457` |

Four slots each — `tint`, `line`, `text`, `solid`. `line` is the extra one the families don't
have; the banquet label needs a border tone between tint and solid.

Two rules that are easy to break:

- **`text` on `tint` is the readable pair** and clears AA everywhere (6.85–8.18 light,
  7.95–9.59 dark). **`solid` is for dots, bars and borders** — and for *large* text only
  (≥18.66px semibold, where the floor is 3:1), which is what the banquet label uses it for.
  Two of the six measure under 4.5:1 as small text on their own tint.
- **Six hues cannot be told apart in greyscale.** Desaturated they land inside 25 luminance
  points. No categorical palette solves this — every use site therefore carries a label as
  well, per §4.3's first mitigation. If you add a seventh use, give it text too.

They also sit close to the families in greyscale — teal and `seated` are both ~82, azure and
`arriving` ~95, magenta and `critical` ~96. By hue they are 32–41° apart, which is comfortable;
what separates them in practice is context. A status chip and a category dot never do the same
job in the same place.

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

Short all-caps strings are often spelled out letter by letter by a synthesiser, which cannot
distinguish a word from an initialism. This is one of the reasons nothing in this product is
set in capitals — see §5.2.

### 4.6 Forms

Every control has a programmatically associated `<label>`. Errors are announced via
`aria-describedby` and stated in text, never colour alone. Required fields are marked in the
label, not by asterisk convention alone.

---

## 5. Typography

Eight styles, all set in **Hanken Grotesk**, a webfont loaded from Google Fonts in
`index.html` and exposed as `--font-sans` and `--font-display` — the two tokens resolve to the
same family, so a style never changes face, only weight and size. The stack behind it is a
plain system fallback that renders during the swap and if the font fails to load.

Only weights **400, 500, 600, 700 and 800** are fetched. Asking for a weight outside that set
does not fail visibly — the browser synthesises it, and a faux-bold 300 or 900 looks subtly
wrong next to a real one. Every style in the table below sits inside the loaded range; keep it
that way, or add the weight to the `index.html` link first.

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

### 5.2 Case — never uppercase

**No element in this product is set in capitals.** Not eyebrows, not badges, not section
headers, not table column labels, not tab labels. `text-transform: uppercase` does not appear
in the codebase, and neither does a string typed in caps to fake it. Brand names keep whatever
case they own — `RistoCRM`, `WhatsApp`, `SMS`, `VIP`, `No-show` — because that is their
spelling, not a style.

This is a hard rule rather than a preference, for three reasons:

1. **Legibility.** Capitals strip the ascender and descender profile that lets a reader
   identify a word by shape. At the 10–13px these labels are usually set, that loss is worst
   exactly where it is least affordable.
2. **Screen readers.** A short all-caps string is frequently read letter by letter, because
   the synthesiser cannot tell a word from an initialism. "IN RITARDO" becomes "eye en, ar eye
   tee ay ar dee oh".
3. **Italian.** Accented capitals are inconsistently available and frequently dropped, so
   `PIÙ TARDI` degrades to `PIU TARDI`. Sentence case never has this problem.

**Hierarchy comes from weight, size and colour, which is what they are for.** A section eyebrow
is `caption` at weight 600 in the family's `text` colour. That reads as a heading at a glance
and stays a word while doing it. If a label still doesn't separate from its surroundings after
weight and colour, the fix is spacing — never capitals.

See §10 for the copy side of the same rule.

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

**Density is a route-level decision, not a user-facing control.** Prenotazioni shipped a
per-device density toggle — a button in the toolbar, persisted in `localStorage` — and it was
removed: it doubled the states every card had to be designed and checked in, for a preference
almost nobody set twice. Where a screen genuinely needs tighter rows, pick the tier for that
route and commit to it. Reserve a toggle for the case where two populations demonstrably need
different answers on the same screen, and expect to justify it.

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
| `critical` | `critical.solid` fill, `critical.fg` text | Confirm of a destructive dialog — **only** there |
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

**StepArrow** [obs] — the two icon-only controls that walk a stepped form one step at a time:
back at the far left of the footer, forward past the save button. A recessed `surface-row`
fill, not the white-on-canvas icon button — a modal footer sits on the panel's own white, so a
white button with a shadow has nothing to lift off. 44px, same geometry as the Modal close.

They are deliberately **unlabelled**. "Indietro" / "Avanti" read as the way through the form,
and no stepped form here gates its steps: the stepper in the subheader is the navigation, and
these only nudge it.

### 7.2 Form controls

**Input** [der] — height 44 (mobile) / 40 (desktop), `surface` fill, `border` hairline,
`rounded.md`, 14px horizontal padding, `body` type. Placeholder `text-subtle`. Focus: 2px
`border-focus` ring, 2px offset. Error: append **`dsInputError`** — a `critical.solid`
hairline ring — and put the message below via `Field`'s `error`. Disabled: `surface-row`
fill, `text-subtle`, `cursor: not-allowed`.

It is a modifier appended to `dsInput` / `dsSelect` / `dsTextarea`, not a variant of them:
those three are plain strings consumed in some two dozen places, and turning them into
functions would break every one. The focus ring deliberately wins over the error ring while
the control is focused — mid-correction the field should say "you are here", not "still
wrong".

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

**Field** [impl] — the composite wrapper: label (`label` type, `text-secondary`) → control →
helper (`caption`, `text-muted`) or error (`caption`, `critical.text`, with a leading
`AlertCircle` so the state is not carried by colour alone). Error **replaces** helper.

**The caller wires the ARIA, not the component.** `Field` renders the message with
`id={fieldErrorId(htmlFor)}` — i.e. `"<htmlFor>-error"` — and the control passes
`aria-invalid` and `aria-describedby` itself:

```tsx
<Field htmlFor="email" error={err}>
  <input id="email" aria-invalid={!!err} aria-describedby={err ? fieldErrorId('email') : undefined} … />
</Field>
```

An earlier draft of this document promised automatic wiring. Doing it would mean cloning
`children` to inject props, and `children` is not reliably a single control — the password
field passes a wrapper holding the input *and* its reveal button, and a clone would land
the attributes on the wrapper. The convention is explicit instead.

Pair the error with `dsInputError` on the control (§7.2, Input) so the field itself carries
the state, not just the text below it.

**DatePicker** [impl] — `MonthGrid` plus `DayPicker` in `ds/Calendar.tsx`, Monday-first with
`L M M G V S D` headers, 36px round day cells, today ringed and the selection filled. It
models a range (`from`/`to`); a single day is the same two values. `minIso` disables days
before a floor and hides the arrow into a month that is entirely behind it. Anchored under
its trigger from `sm` up; below that it becomes a centred panel with its own scrim, because
a popover hung off a control inside a scrolling modal loses half the month off-screen.

**TimePicker** [impl] — not a popover: a row of slot cells, one per opening-hours slot, each
a bar over the time and the covers already booked into it. The bar is the load — `seated`
under 15% of the room's seats, `pending` up to 30%, `critical` above — so choosing a time
and reading how full it already is are the same glance. Selecting is the whole control;
there is no separate dropdown repeating the same values. A saved time that has since left
the grid is appended rather than dropped, or opening an old booking would silently blank
its hour.

**SearchField** [obs] — pill at `rounded.full`, 44px, leading search glyph, trailing clear
button once there is a value. **Always visible, never behind a toggle:** on a list you filter
before you scroll, and a hidden search costs a tap plus remembering it exists.

On the canvas it takes `surface` with `elevation.card`, not `surface-row` — see §8.8. Accepts
an optional passive hint parked inside the field (what Enter will do to the last remaining
match), which never covers the clear button.

**IconButton** [obs] — circle at 44px, one linear icon, always an `aria-label`. On the canvas
it is `surface` with `elevation.card`; inside a card it is `surface-row`. When it toggles
something on it takes `action-bg`; when it carries a count the badge overlaps the top-right
corner with a ring in the colour behind it.

**Stepper** [obs] — `[−] value [+]` at 44px. The value is an `<input type="number">`, not a
label: typing "14" beats fourteen taps on `+`, and the field it usually replaces was typeable.
Native spinners hidden — the buttons are the affordance. Increment carries the solid fill and
decrement stays quiet, because people add covers far more often than they remove them.

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

**TableNumberBadge** [obs] — rounded square at `rounded.md`, 56–64px. The number in the
family's `text` colour on its `tint`, with the room name beneath it where there is space.

**The family comes from the booking, not from the table.** A table holding a confirmed party
is `arriving`, one holding a seated party is `seated`, one holding a no-show is `critical`. The
badge answers "what is happening at this table", which is a property of who is sitting there.

Two variants carry meaning beyond identity:

- **Unassigned** — a dashed `pending` outline around a `+`. It is a *button*, opening the same
  assign-table flow the record already offers elsewhere. An empty slot that looks like a slot
  and does nothing is a dead end.
- **Undersized** — `pending` tint with the seat count printed under the number (`109` /
  `3 posti`) whenever `seats < guests`. This is the error worth catching while the host is
  still at the pass rather than walking a party of six to a table for three.

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

**StatusPill** [impl] — carries a `border-strong` hairline (`ring-1 ring-inset`, so the fixed
height is not eaten by a border). The tints are pale enough to sit at 1.03–1.07:1 of
*luminance* against the canvas — they separate by hue, not by lightness, so in dim light or
for a reader who discriminates colour poorly the row flattens into one grey band. The text
clears 5.9:1 in every tone, so the hairline is not a WCAG requirement: it is definition, not
compliance.

Pill at `rounded.full`, 24px tall, `states.X.tint` fill with the
family's `text` colour. Carries a state as words. Where the state can be changed it gains a
leading dot and a trailing chevron and becomes a button; where it is read-only it stays a
`<span>`. **The dot is what makes it survive a colour-blind reader**, per §4.3.

**StatStrip** [der] — the headline figures for a screen, in one card divided by hairlines
rather than in separate boxes. They are one reading of the same thing, and four cards claim
they are four unrelated things.

Two layouts: `inline` (value and label on one line, `rounded.full`) for a strip sitting among
other controls, and `stacked` (value over label, `rounded.2xl`) where the strip is the page's
headline. A segment takes a family only when it is **actionable** — the tinted background plus
a chevron mark the one figure that is a task rather than a fact, and that segment is a button.

Two rules that matter more than they look:

- **Zero reads neutral.** A green "0 arrivati" claims something went right before service has
  started. Tone the segment only once the number is above zero.
- **Totals come from the unfiltered set.** A headline that moves while the user types in the
  search box is not a total.

**SectionHeader** [obs] — the eyebrow above a group of rows. `caption` at weight 600 in the
family's `text` colour, with an optional leading dot; muted meta text beside it. Sentence case,
never caps — see §5.2.

Two variants. **Static** is a `<div>`. **Collapsible** is a `<button>` wrapping the whole row,
clearing 44px, with the chevron in a 32px circle and a `surface-row` press state. A bare 16px
chevron floating beside text reads as decoration; people aim at the circle even though the
whole row is the target.

Where the column is too narrow, label and meta **wrap as a pair** — the meta drops to a second
line rather than truncating mid-word — while the chevron stays on the first line. The 44px is a
floor, not a fixed height.

**Callout** [der] — tinted notice at `rounded.lg`, `states.X.tint` with the matching `text`
colour, optional leading icon and a single trailing action. For a condition the user should
know about but need not act on immediately: a closed room, a missing table, a load failure.
Distinct from Toast, which is transient, and from a form error, which belongs on the field.

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

**SegmentedControl / Tabs** [obs] — track at `rounded.full`, active segment a pill inside it.
Which pill depends on what the control does, and the two are not interchangeable:

- **Filter** — narrows a set that stays the same set. Track at `surface-row`, active segment
  `surface` with `elevation.card` and `text-primary`, inactive `text-muted`. This is the
  default and covers most cases: `Tutte / Non lette`, the shift filter, status chips.
- **Scope switch** — changes *which* set you are looking at. Track at `surface` with
  `elevation.card` sitting on the canvas, active segment `action-bg` with `action-fg`,
  inactive `text-secondary`. Used for room tabs on the floor plan and in the table picker.

The distinction is worth the second treatment because the two answer different questions. A
filter says "of these, show me the confirmed ones" and the raised pill reads as a subset. A
scope switch says "I am now in Veranda, not Fiume" — nearer to a location than a filter — and
the solid fill is the strongest "you are here" the palette has.

This is the one place `action-bg` is not an action. Everywhere else a solid near-black fill
means a button; here it means the current scope. Do not extend it further without a reason
this specific.

Counts ride **inside** the segment rather than as a corner dot: at this size a dot cannot say
"3" versus "99+", and the number is usually the reason to switch.

Arrow-key navigation, `role="tablist"` when switching panels.

**Overflowing tracks.** Where the options outrun the width the track scrolls horizontally, with
no visible scrollbar on touch. Two rules make that usable:

- Selecting a partly-visible segment scrolls it fully into view (`inline: 'nearest'`).
- The edge fade that signals "more exists" is **bound to scroll position** — applied only to
  the side that still has content behind it, and removed entirely when the track fits. A fade
  that never lifts veils the option the user just scrolled to and makes it read as disabled.

**Pagination** [der] — pill buttons at `rounded.full`, 40px. Current page uses `action-bg`.
Prefer "load more" or virtualised scroll on mobile.

**Chrome** [obs] — sidebar and top bar are **floating cards**: `surface` fill, `rounded.3xl`,
inset from the viewport by `chrome-inset`, sitting on the canvas. Not edge-to-edge rails. At
`<md` the sidebar becomes a bottom tab bar.

Because it floats, the bar overlaps the page rather than pushing it — every screen has to
reserve the height itself, and the screen must own the box that reservation applies to. See
§8.14; it is the rule most often missing.

**A full-screen task hides the bar.** Where a screen opens something that takes over the whole
phone — the order pad on a table — the bar goes for as long as that lasts, and the clearance
goes with it: a hidden bar that still reserves its height leaves a dead strip under the primary
action, which on the pad is the one that sends food to the kitchen. Only for a task with its own
way back. A screen you can leave *only* through the tab bar never hides it.

### 7.5 Overlays

**Modal** [der] — `surface` fill, `rounded.3xl`, `elevation.raised`, max-width 560px,
`card-padding`. Backdrop uses the `backdrop` token at `z.overlay`; content at `z.modal`.
Focus trapped, Escape closes, focus returns to the trigger. At `<md` becomes a bottom sheet:
full-width, top corners only, slide up at `motion.slow`.

**The light backdrop is heavier than the dark one** — 0.50 against 0.60, which is a smaller
gap than the raw numbers suggest and is deliberate in direction. In dark the page underneath
is already spent and the dialog separates itself by being the only lit thing in the frame, so
the scrim carries almost nothing. In light the page is bright and competes, and the scrim is
the whole of the separation. Reading the two numbers as "light should be lower" is the trap:
0.50 takes a white surface down to `#858586`, which reads as behind glass. Past that, around
0.60 in light, the app stops looking backgrounded and starts looking switched off.

**The footer stacks by default and stays in a row on request.** Below `sm` its two groups drop
onto their own full-width rows, which is right for a footer of labelled buttons a thumb wants
to be wide. A footer built around a single primary action flanked by icon-only controls — a
stepped form's `StepArrow`s — asks for the row instead: stacked, three related controls become
three separate rows and the one that matters ends up buried between the two that don't.

**ConfirmDialog** [der] — a Modal with title, body, and an action row. **The safe action is
the primary.** A destructive confirmation uses `state-solid` with the `critical` family for
the confirm button and a `secondary` cancel — this is the one place `critical` may carry
full visual weight, because the user has already committed to the intent.

**Drawer / Sheet** [der] — side panel at `≥md` (max-width 420px, full height, `rounded.3xl` on
the inner edge), bottom sheet at `<md`. Same focus rules as Modal.

Its header carries three slots and they are not interchangeable. `subtitle` sits under the
title; `meta` takes a few status chips; `subheader` takes full-width pinned chrome — a tab bar,
a filter row. `meta` renders *inside the title column*, alongside the close button, so a
segmented control put there truncates its own labels (`Tutto il ta…`) at the width where it
matters most. That is what `subheader` is for. Unlike the Modal's, the sheet's subheader keeps
the sheet's own white rather than the canvas tone: a recessed filter track needs a level-1
surface beneath it, and on the canvas it measures 1.03:1 and disappears (§8.8).

**SplitPane** [obs] — the list-plus-detail layout behind every two-column screen
(Comunicazioni, Prenotazioni, Reception). List column at a fixed ladder — 340 / 400 / 440px by
breakpoint, never a percentage, which collapses to a phone shape on a laptop and sprawls on a
27" screen.

**The detail changes container by size, not just by CSS.** At `≥md` it is a pane beside the
list; below that a full-screen sheet portaled to `<body>`, because reading one record is a
focused task and the surrounding chrome only crowds it. It renders in exactly one place at a
time — mounting both and hiding one means two audio elements and two fetches.

**PaneHeader** [obs] — the top of an open record: a card floating on the canvas, not a flush
bar, so the detail side is built from the same blocks as the list side. Its **bottom padding is
load-bearing** — see §8.10.

**SwipeRow** [obs] — a list row with one revealed action per side. Touch only; on a pointer
device the same actions are reachable by opening the record, so binding drag to the mouse only
fights text selection. Gate on the **event's pointer type**, never on `(pointer: coarse)`,
which is false in a desktop browser's device emulation and on some hybrid machines — that gate
shipped once and the gesture was silently dead.

Vertical wins axis ties: a list is scrolled far more often than swiped, and stealing the scroll
is the one failure everybody notices. Capture the pointer, or a finger leaving the row's box
freezes the swipe half-open. Pair with a one-time hint that plays on first visit per surface,
skipped for fine pointers and under `prefers-reduced-motion`.

**Toast** [der] — `surface` fill, `rounded.lg`, `border` hairline, `elevation.raised`, at
`z.toast`. Variants take state families via a leading icon and `tint-border`. Auto-dismiss
after 5s — **except errors, which persist until dismissed.** Announced via `aria-live="polite"`.

**It stays at the bottom on a phone**, centred and inset, anchored to
`--ds-bottom-nav-clear` — the same clearance the scroll regions use, so it clears the tab bar
and the raised "+" instead of covering them. Bottom-right at `≥md`. A toast reports on the
action just taken, with the thumb still where it took it; the top of a phone is the far corner
from there, and an undo with five seconds on it cannot ask for a trip across the screen.

The variable is a constant, not a measurement of the bar, so it does not follow a bar that has
gone away: a toast raised inside a full-screen task (§7.4) floats above empty space. Screens
that hide the bar pass their own offset.

**A toast carrying a single action is a solid pill, not a card.** The Annulla on Lista della
spesa: `action-bg` fill at `rounded.full`, `action-fg` text, `elevation.raised`, a leading icon
naming what happened — a tick, a bin — and the action as a text button at the trailing end. It
looks like a primary button because it is one with a sentence attached, and the inversion is
what buys five seconds of attention on a screen whose content did not visibly change. Its
wrapper takes `pointer-events: none` so the empty strip either side of the pill does not eat
taps meant for the list underneath.

**Undo runs forwards.** The action commits immediately and Annulla issues the compensating
call. Holding the write until the countdown expires means closing the page mid-timer loses the
*action*; this way it loses only the chance to undo it, which is the one of the two the user
can live without.

**The action label has to clear 4.5:1 against the pill in both themes**, and this is where the
shipped one falls down: amber on the near-black pill is 5.45:1 in light, but the pill inverts to
near-white in dark and the same amber measures **2.96:1**. Recorded so it is not copied as
precedent. The fix is a label colour that inverts with the fill, not a darker amber — §3.3 has
already been down that road.

**Tooltip** [der] — `surface-inverted` fill, `surface-inverted-fg` text, `rounded.md`,
`caption` type, max-width 240px. Never the sole carrier of information; touch devices get no
hover, so anything essential belongs in visible text.

**Popover** [der] — `surface` fill, `rounded.xl`, `elevation.raised`, 16px padding, at
`z.popover`. Dismisses on outside click and Escape.

**DropdownMenu** [der] — `surface` fill, `rounded.lg`, `elevation.raised`, at `z.dropdown`.
Items are 40px rows with `surface-row` hover. Arrow-key navigation, type-ahead. Distinct from
Popover: menus hold *actions*, popovers hold *content*.

**A menu anchored to its trigger is the default at every width**, including touch — a short
menu hanging off a header is easy to hit and easy to dismiss, and a sheet for two items is
ceremony. It **becomes a bottom sheet below the screen's own breakpoint** in two cases:

- the trigger is small and sits in something that scrolls — a calendar cell, a row in a long
  list — where an anchored menu drifts off its own origin and there is nothing dimmed to say
  where "outside" is;
- the menu is long enough that an anchored panel would cover the thing it acts on.

The sheet carries a grab handle, 56px rows and a backdrop that dismisses; it does **not**
repeat the record's name, which is already on the card it was opened from, and it needs no
"Annulla" — the handle, the backdrop and Escape all say the same thing three times over.

This is a **container** choice, not a styling one: pick the tree with `useMediaQuery`, never
render both and hide one — rule 13 in §8.

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

The four rules below are about layout rather than taste. Each of them shipped as a visible
defect at least once, and each is invisible in review until it renders.

10. **A fixed element owns the gap beneath it.** Where an opaque scrolling region sits below
    something pinned — a toolbar, a pane header, a switcher — the space between them must be
    *inside the fixed element's box*. Put it on the scrolling side and the region paints over
    the fixed element's shadow, cutting it with a hard line and slicing whatever card is
    passing behind. This was diagnosed and fixed four separate times before it was written
    down.

11. **A scroll container clips the other axis too.** `overflow-y: auto` also establishes
    horizontal clipping — and `overflow-x: auto` vertical — so card shadows and focus rings
    inside come out sliced flat at whichever edges do not scroll. Give the container a small
    bleed on that axis (negative margin plus equal padding) so elevation has room to render.
    A horizontal chip track is the case that hides longest: every chip keeps its shadow at the
    sides and loses it top and bottom, which reads as a deliberately flat control rather than
    as a bug.

12. **A scroll container's own padding is eaten by its scrollbar.** Padding on the scrolling
    element sits *behind* the scrollbar, so content stops short of where the same padding puts
    it on a pinned sibling and the two columns visibly misalign. Move the padding to an inner
    wrapper, or push the scrollbar out into the gutter with `-mr-4 pr-4`.

13. **A media query picks the container, not the style.** Where a layout differs by *tree* and
    not by appearance — a sheet versus a pane, a dropdown versus a page — resolve it in
    JavaScript with a matchMedia hook and render one of them. CSS cannot express it, and
    rendering both while hiding one duplicates every mount, fetch and media element inside.

14. **A screen owns its scroll region.** The clearance under the floating bottom bar
    (`.pb-mobile-nav`) is padding at the bottom of a *box*, so it only does anything if that box
    ends where the viewport does. A screen written as a plain growing `div` lets the app
    container scroll instead: the padding rides down with the content, and the last rows run the
    full viewport height — behind the bar and out below it, where they can be neither read nor
    tapped. Wrap the screen in `h-full min-h-0 flex flex-col` and give the scrolling part
    `min-h-0 flex-1 overflow-y-auto`. The header then stays put as a bonus, which is the tell
    that a screen has it: if the title scrolls away on a phone, the bar is overlapping something
    further down. Six screens shipped without it.

---

## 9. Naming

- Primitive components: PascalCase, single noun — `Button`, `Field`.
- Variant prop values: kebab-case strings — `variant="state-solid"`, `density="compact"`.
- Token names: kebab-case CSS custom properties — `--color-surface-row`.
- Tailwind: standard class names only inside primitives (arbitrary values are tolerated in
  one-off domain code during the transition).
- **Class names must be statically written out.** Tailwind extracts them by scanning source
  text, so a name assembled at runtime — `` bg-[var(--ds-${family}-tint)] `` — is never
  generated and the element ships unstyled. Map a variant to a full literal class string
  instead. This compiles, passes review, and fails silently only in the browser.

---

## 10. Voice & content (Italian)

- **Cut it to the shortest thing that still works.** This screen is read mid-service, one
  hand on a tray. Every word is one the reader has to get past to reach the number or the
  button they came for, so a label earns its place or it goes. Prefer the noun to the
  sentence, the verb to the phrase: "Assenza", not "Registra un'assenza"; "Nessun prodotto",
  not "Non è stato trovato alcun prodotto".
- **Say it once.** If the heading, the placeholder and the hint below a field all describe the
  same thing, two of them are noise. A sheet does not repeat the name of the record it was
  opened from; a confirm dialog does not restate its own title in the body.
- **Delete the reassurance.** "Puoi sempre modificarlo dopo", "Non preoccuparti" and
  "Attenzione:" carry no information. Where a thing really is irreversible, say what it does
  — "L'azione non è reversibile" — and stop there.
- **Tone:** professional but warm, never patronizing.
- **Buttons take the imperative:** "Salva", "Elimina", "Conferma" — never "Vuoi salvare?".
- **Errors describe the problem and the fix:** "Email non valida. Controlla il formato
  (esempio: nome@dominio.it)."
- **Empty states describe the absence and the next action:** "Nessuna prenotazione per questa
  data. Aggiungi la prima."
- **Sentence case everywhere**, with no exceptions but the brand — see §5.2. This includes
  eyebrows, badges and column labels, which an earlier version of this document allowed to be
  set in caps with letter-spacing. They may not.
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
  ds/                    # design system primitives (§7)
    ModalShell.tsx       # the modal frame
    FormPrimitives.tsx   # FormCard, Field, fieldErrorId, Stepper, SegmentedControl,
                         # dsInput/Select/Textarea, dsInputError, dsButton
    ListPrimitives.tsx   # SplitPane, PaneHeader, SectionHeader, StatStrip, StatusPill, CountBadge,
                         # SearchField, Avatar, Callout, EmptyState, dsIconButton, useMediaQuery
    Calendar.tsx         # MonthGrid, DayPicker — one month grid for the whole app
    AttachmentRow.tsx    # a queued file inside a composer
    SwipeRow.tsx         # swipe actions + first-run hint
    index.ts             # barrel export — import from './ds', never from a file
  <screen>.tsx           # domain screens, composing ds/
```

Primitives are grouped by role in a handful of modules rather than split one folder per
component. At this size that keeps related pieces — a control and the class string it shares
with its siblings — in one file, and the barrel means callers never depend on the arrangement.
Split a module out when it grows its own state or tests, not on principle.

**Two conventions worth knowing.** Components exported as `PascalCase` are React components;
the `ds`-prefixed camelCase exports (`dsButton`, `dsInput`, `dsIconButton`) are **class-name
constants**, not components — used where the element must stay native, such as an `<a>` that
should look like a button. `reservationState.tsx` is the single source of truth for reservation
state and its colour; it is domain, not `ds/`, and every surface derives from it.

Tokens live in `index.css`, in plain `:root` and `.dark` blocks — not under Tailwind v4
`@theme`, which holds only the legacy `--color-*` remap that Tailwind's own utilities resolve
through. This document is the specification, `index.css` is the implementation.

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

**Some `[der]` components in §7 are still proposals.** They are consistent with the token
system and meet the contrast floor, but they have no visual reference: Toast, Tooltip,
Popover, DropdownMenu, Pagination, Drawer, and the data table.

The rest have since been built and observed in shipped screens, and their entries here were
rewritten from what actually works rather than from what was projected: the form family,
Modal, SplitPane, SwipeRow, SectionHeader, StatStrip, StatusPill, SearchField, Stepper and
TableNumberBadge. Where an entry now contradicts the original proposal — the segmented
control's second variant, the table badge taking the booking's family rather than the
table's — the shipped behaviour is the specification.

---

## 16. The public surface — pagina di prenotazione

Everything above describes the CRM: a dense, real-time console read by staff mid-service,
standing, on a phone they are also using to carry plates. `public/prenota.html` is the other
audience — a guest, on a sofa, who will see this page once and never again, and who is
choosing a restaurant rather than operating one.

It is served by the backend from `public/`, not built by Vite, and it does **not** load
`index.css`. Everything in this section exists because of that separation.

### 16.1 The `--ds-public-*` layer

The page defines two groups of tokens in its own `<style>` block:

1. **Copies of `--ds-*` values.** `surface`, `border`, `text-*`, `action-*`, the state
   families, shadows and radii are restated verbatim. They are not imported — different
   bundle, different origin, no shared stylesheet.
2. **`--ds-public-*`**, the consumer extension: `canvas`, `canvas-sunk`, `header-bg`,
   `header-fg`, `header-fg-muted`, `header-line`, `header-pill`, `font`, `wordmark`.

The extension is **additive and overrides nothing**, the same discipline `--ds-*` follows over
the legacy `--color-*` layer. A `--ds-public-*` token may consume a `--ds-*` token; the
reverse never happens.

> **The copies are a hand-maintained duplicate.** Change a `--ds-*` value in `index.css` and
> the booking page will not follow. This is a real cost, accepted because the alternative —
> shipping the CRM's stylesheet to every guest, or a build step for one static file — costs
> more. The block carries a comment saying so; keep it there.

### 16.2 Light only

The page has no dark theme and no `prefers-color-scheme` branch, which is a deliberate
departure from §11.

The header colour is chosen by the restaurant. A theme that inverted the page underneath that
choice would either fight it or silently discard it, and the restaurant would have no way to
see which. §6.3 makes the same argument about density: where two populations do not
demonstrably need different answers, pick one and commit.

### 16.3 The branding contract

`GET /public/contact` returns a `branding` object; the page degrades cleanly when any field is
absent, which is the normal state for a restaurant that has filled nothing in.

| Field | Effect | Absent |
|---|---|---|
| `name`, `tagline` | Wordmark and footer | Generic title, no tagline |
| `logo_url` | Replaces the wordmark | Wordmark shown |
| `header_color` | Header band fill | Near-black `#17171a` |
| `address`, `maps_url` | "Dove siamo" pill | Pill omitted; label falls back when only the URL exists |
| `website_url` | Makes the wordmark a link | Wordmark is not a link |

The header carries **two pills at most** — phone and directions. Both answer a question a
guest asks while deciding: *can I just call?* and *where is this?* A link back to the
restaurant's own site answers neither, and it is the one control on the page that leads away
from the booking; the wordmark still carries it for anyone looking.

**The header foreground is derived, never configured.** The page computes the relative
luminance of `header_color` and picks light or dark text from it. Left to a settings field,
a restaurant would eventually save white-on-cream and only find out from a guest.

### 16.4 Deliberate departures

Each of these contradicts something above. They are listed so a reader can tell a decision
from a drift.

**Gold marks progress, near-black marks actions.** In the CRM `pending` gold encodes a
reservation state (§3.2). Here it carries the StepNav rail and the current step marker, and
nothing else — the CTA, selected slots, selected chips and the stepper's `+` all stay
`action-bg`. Two accents, one meaning each.

**The StepNav is a minimal rail: no circles, no glyphs.** A 2px rail per step over a small
numeral and a label — the same footprint as a line of text. The marker takes its rail's
colour, so the three states read as one system:

| State | Rail | Marker | Label |
|---|---|---|---|
| ahead | `border` | `text-subtle` numeral | `text-muted` |
| current | `pending.solid` | `pending.text` numeral | `text-primary`, 600 |
| done | `action-bg` | `action-bg` check | `text-primary`, 600 |

**Done turns ink rather than staying gold**, and that is the point of the arrangement: if
both the current and the completed step were gold, a filled rail would mean two things at
once, and step 1 would look finished while you were still standing in it. Gold means *you are
here*; ink means *behind you*; the check removes any remaining ambiguity.

This replaced a circular marker carried over from the CRM component. `pending.tint`
(`#FBF4E6`) is built to sit on `surface` white, and the StepNav sits directly on
`--ds-public-canvas` (`#F7F4EC`) — the tinted circle was invisible against it and left the
completed step's check floating in space. Dropping the circle removed the problem rather than
patching it.

**Chips take the action fill, not `critical`.** An allergy chip tinted red is an alarm aimed
at the guest, who has nothing to be alarmed about — the kitchen is the audience for that
severity, and it reaches them through the reservation note. Selected chips are `action-bg`
like every other choice on the page.

**Allergie and intolleranze are one list.** The CRM distinguishes them; this page does not, and
writes every selection as `Allergie: …` into the reservation note. Without the distinction in
the interface, treating an intolerance as an allergy is the harmless error and the reverse is
not. Anything parsing that note must keep reading the existing format.

### 16.5 What is reused unchanged

`Stepper` is ported to plain CSS from `components/ds/FormPrimitives.tsx` with its geometry and
behaviour intact, including the typeable `<input type="number">` and the quiet minus against
the solid plus. `StepNav` keeps its *behaviour* — steps never gate each other going backwards,
and each is a button — while its appearance is the minimal rail in §16.4. `StepArrow` (§7.1)
places the back control at the far left of the footer.

The floors hold without exception: 44px touch targets, `tabular-nums` on every live numeral,
`rounded.full` on primary actions, visible focus, and §5.2 — **never uppercase, anywhere.**
The typeface is Hanken Grotesk as in §5; a serif appears only in the fallback wordmark, where
it is standing in for a restaurant's logo rather than setting an interface.

---

## 17. The print surface — `--ds-print-*`

Two modals print: `PrintReservationsModal` and `PrintInventoryModal`. Unlike the booking page
(§16) the printed sheet is **not** a separate document — it renders inside the app, portaled
into `.print-portal`, and `@media print` hides every other body child. It therefore *does* load
`index.css` and can see every token the app can.

Which is exactly the trap. `--ds-surface` resolves to `#141417` under `.dark`, so a member of
staff working in dark mode would print a black page.

### 17.1 Light only, by construction

`--ds-print-*` is declared **on `:root` and never inside `.dark`.** Nothing redefines it, so it
cannot invert, and the sheet comes out identical in either theme. That is the whole mechanism —
there is no media query and no theme branch to maintain.

Additive over `--ds-*`, overriding nothing, the same discipline `--ds-public-*` follows (§16.1).

| Token | Value | Used for |
|---|---|---|
| `ink` | `#0F172A` | headings, strong rules |
| `ink-secondary` | `#475569` | supporting text |
| `ink-muted` | `#64748B` | notes, units, empty states |
| `ink-subtle` | `#94A3B8` | page footer |
| `rule-strong` | `#CBD5E1` | section separator |
| `rule` | `#E2E8F0` | row hairline |
| `fill` | `#F1F5F9` | table header ground |
| `positive` | `#059669` | the "✓ arrivato" tick |

The values are the ones both modals already had hard-coded, identically, in two places. They
were named rather than changed: paper coming out of the printer is unchanged.

### 17.2 What this does not cover

`utils/printDocument.ts` is a third path. Banchetti, HACCP and Lista della spesa print from a
hidden iframe as standalone documents that never load `index.css`, so they cannot consume these
tokens — the same separation §16 describes for `prenota.html`.
