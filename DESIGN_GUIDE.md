# MAG Metrics Dashboard — Design Guide

The standard for how every page in this dashboard should look and behave.
**`public/roas.html` is the reference implementation** — when in doubt, open it
and copy the pattern. This guide extracts those patterns so you don't have to
reverse-engineer them each time.

> **Why a guide:** the frontend is hand-edited plain HTML/CSS/JS (no build step).
> Consistency comes from *convention*, not a component library. Use the shared
> classes and tokens below instead of inventing new ones per page.

---

## 0. Golden rules

1. **Theme with tokens, never hardcode a raw color.** Every color is a CSS
   variable on `:root` (light) with a dark override under
   `html[data-theme='dark']`. A hardcoded `#fff` or `#333` breaks dark mode.
2. **Shared first.** Reach for the shared classes/helpers in `public/app.css` +
   `public/app.js` before writing page-local CSS. Page-local CSS goes in an inline
   `<style>` in that page's `<head>` and must be **scoped** (via an id/page class)
   so it can't leak to other pages — exactly how `roas.html` does it.
3. **The horizontal segmented toggle is the standard period/filter control.**
   The ROAS "by FY" toggle is the canonical pattern for *any* time/period or
   mode selector (see §4). Do **not** add dropdown `<select>`s or the old
   `3M/6M/12M/YTD` range buttons for new work.
4. **Numbers are tabular.** Any numeric value or money figure uses
   `font-variant-numeric: tabular-nums` so columns and deltas align.
5. **One accent gradient per page.** A page may define its own accent pair
   (`--roas-accent` → `--roas-accent-2`) for gradients/hover, but it derives from
   the global `--accent`. Keep it to one gradient identity per tab.

---

## 1. Color tokens

Defined once in `public/app.css` (`:root` + the `html[data-theme='dark']` block).
**Always use the variable**, e.g. `color: var(--text)`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f4f6fb` | `#0e1220` | Page background |
| `--surface` | `#ffffff` | `#171d2e` | Cards, panels, table bg |
| `--surface-2` | `#f9fafc` | `#1e2536` | Insets, table headers, hover rows, toggles |
| `--border` | `#e4e8f0` | `#2a3348` | All 1px borders / dividers |
| `--text` | `#1a2233` | `#eef2fb` | Primary text |
| `--text-muted` | `#6b7488` | `#98a2b8` | Labels, captions, secondary text |
| `--accent` | `#3b6ef0` | `#5b86ff` | Primary brand/interactive color |
| `--accent-soft` | `#e8effe` | `#1d2947` | Tinted accent backgrounds (active nav, callouts) |
| `--pos` | `#17a673` | `#35c48f` | Positive delta, "won", pass |
| `--neg` | `#e2483d` | `#ff6b60` | Negative delta, "lost"/error, fail |
| `--grid` | `#eef1f7` | `#232b3e` | Chart gridlines |
| `--shadow` | *(2-layer soft)* | *(2-layer soft)* | Default card elevation |

**Chart categorical palette** (`PALETTE` in `app.js`):
`#3b6ef0` · `#7c5cff` · `#17a673` · `#f0a63b` · `#e2483d`.

**Deriving a semantic tint** — don't eyeball a lighter shade; mix from a token:

```css
background: color-mix(in srgb, var(--pos) 16%, transparent);   /* pass pill  */
background: color-mix(in srgb, var(--neg) 16%, transparent);   /* fail pill  */
border-color: color-mix(in srgb, var(--accent) 32%, var(--border));
```

### Page-local accent + depth tokens (the ROAS pattern)

Each visually-rich tab defines a small token set at the top of its inline
`<style>`, theme-aware, so gradients and elevation are consistent within the page:

```css
:root {
  --roas-accent: var(--accent);          /* derive from the global accent */
  --roas-accent-2: #6a4bf5;              /* gradient end                  */
  --roas-accent-soft: #eef2fe;           /* tinted fill                   */
  --roas-shadow:      0 1px 2px rgba(20,30,60,.05), 0 12px 32px -14px rgba(20,30,60,.22);
  --roas-shadow-lift: 0 1px 2px rgba(20,30,60,.06), 0 20px 44px -18px rgba(20,30,60,.30);
  --roas-amber: #c99a17;                 /* "open"/in-progress state      */
}
html[data-theme='dark'] {
  --roas-accent-2: #9b7dff;
  --roas-accent-soft: #1b2440;
  --roas-shadow:      0 1px 2px rgba(0,0,0,.4), 0 16px 40px -18px rgba(0,0,0,.6);
  --roas-shadow-lift: 0 1px 2px rgba(0,0,0,.5), 0 24px 54px -20px rgba(0,0,0,.72);
  --roas-amber: #e3b84a;
}
```

Rename the prefix per page (`--roi-*`, `--sales-*`, …) to keep scoping obvious.

---

## 2. Typography

- **Font family:** the system stack (set on `body` in `app.css`) — never load a
  web font:
  `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`.
- **Scale & weight** (as used on the ROAS reference):

| Element | Size | Weight | Notes |
|---|---|---|---|
| Page hero title | `30px` | `800` | `letter-spacing: -.025em`; gradient text (see §3) |
| Card heading `h3` | `15px` | `700` | `letter-spacing: -.01em` |
| KPI value | `29px` | `800` | `tabular-nums`, `letter-spacing: -.02em` |
| KPI / card label | `12–13px` | `600` | `color: var(--text-muted)` |
| Control label (`.ctl-label`) | `11px` | `700` | UPPERCASE, `letter-spacing: .08em` |
| Table header | `11px` | `700` | UPPERCASE, `letter-spacing: .045em`, muted |
| Table body | `13px` | `400/700` | numerics `tabular-nums` |
| Caption / note | `12px` | `400` | `color: var(--text-muted)` |

- **Numbers:** add `font-variant-numeric: tabular-nums` anywhere figures line up
  (KPI values, table number cells, invoice totals).

---

## 3. Layout & surfaces

- **Shell** (identical on every page, copy from any tab): `.topbar` (sticky) →
  `.tabbar` (Home / Sales / Marketing / Operations) → area layout.
- **Content width:** default `.content` is `max-width: 1200px` centered,
  `padding: 24px`. **Data-dense / dashboard pages (tables, multi-chart overviews)
  STRETCH to full width on wide screens** — follow ROAS / `sales_overview` /
  `roi.html` / the Marketing Overview: set `.content { max-width: none; }` (keep the
  24px padding as the gutter). On a page that also has a sub-tab bar or a head band
  capped at 1200px (e.g. `#marketingNav`, `.mkt-head`), **drop their `max-width` too**
  (`#marketingNav { max-width: none; } .mkt-head { max-width: none; }`) so the nav,
  head, KPI grid and charts all align edge-to-edge — don't leave the content full
  width while the nav stays centered.
- **Grid:** 12-column — `.grid` + `.card.col-{12,8,7,6,5,4,3}`; cards collapse to
  full width under 860px. Two charts side by side = two `.card.col-6`.
- **Radius:** cards/panels/modals `14–16px`; toggles/inputs `8–11px`; pills `999px`.
- **Elevation:** resting card = `var(--shadow)` (or `--roas-shadow`); on hover the
  card lifts to `--roas-shadow-lift` + `translateY(-3px)`.

### Card

```html
<div class="card col-6">
  <div class="card-head"><h3>Chart title</h3>
    <div class="spacer"></div>
    <span class="muted" style="font-size:12px">optional note / chips</span>
  </div>
  <div class="chart-box"><canvas id="…"></canvas></div>
</div>
```

The ROAS polish adds, page-locally: a 4px gradient **accent bar before the `h3`**,
a hidden **top gradient line** that fades in on hover, and the hover lift. Reuse
that block verbatim for a premium feel; plain `.card` is fine for simple pages.

### Page hero

```html
<header class="roas-hero">
  <div class="roas-hero-main">
    <span class="roas-hero-eyebrow">Marketing · Paid Search</span>
    <h1 class="roas-hero-title">Return on Ad Spend</h1>
    <p class="roas-hero-sub">One-line framing question or description.</p>
  </div>
  <!-- optional status chip, right-aligned -->
  <div class="roas-hero-badge"><span class="dot"></span> Live from Supabase</div>
</header>
```

Eyebrow = uppercase accent kicker; title = gradient-clipped text; sub = muted.

---

## 4. The standard period / filter toggle  ⭐

**Every time-range, financial-year, cost-basis, status or mode selector uses the
horizontal segmented toggle** — the ROAS "by FY" control is the standard. No
dropdowns, no `3M/6M/12M/YTD` pill rows for new pages.

**Markup** — a labeled control inside a controls bar:

```html
<div class="roas-controls">
  <span class="ctl-label">Financial year</span>
  <div class="segmented" id="fySeg"><!-- buttons injected by JS --></div>

  <span class="ctl-label">Cost basis</span>
  <div class="segmented" id="basisSeg">
    <button data-basis="allin">All-in</button>
    <button data-basis="google">Ads only</button>
  </div>

  <div class="spacer"></div>
  <span class="muted" id="asOf" style="font-size:13px"></span>
</div>
```

**Build the period buttons from the data** (so the axis always matches what's
loaded), then wire them:

```js
function buildFySeg() {
  var seg = document.getElementById('fySeg');
  seg.innerHTML = '<button data-fy="All">All years</button>' +
    rows.map(function (r) { return '<button data-fy="' + esc(r.fy) + '">' + esc(r.fy) + '</button>'; }).join('');
  seg.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { setFy(b.getAttribute('data-fy')); });
  });
}
// Active state is a class toggle, re-applied after any re-render:
function syncPressed() {
  document.querySelectorAll('#fySeg button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-fy') === SEL.fy);
  });
}
```

**Styling** — the base `.segmented` lives in `app.css`; the **gradient active
pill** is the ROAS standard (page-local):

```css
.segmented button.active {
  background: linear-gradient(135deg, var(--roas-accent), var(--roas-accent-2));
  color: #fff;
  box-shadow: 0 5px 14px -4px color-mix(in srgb, var(--roas-accent) 60%, transparent);
}
```

Rules:
- Selection state is driven by a **class** (`.active`) toggled in JS — never by
  inline style. One group = one active button (mutually exclusive).
- Label each group with a `.ctl-label` (uppercase, muted).
- Put an "as of …/data through…" note at the right of the bar via a `.spacer` +
  muted span.

### Sticky controls bar ⭐

**The controls bar (FY toggle + custom date range) freezes under the top bar when
the page scrolls** — a page's filters must stay reachable without scrolling back up.
This is the standard (`roi.html` is the reference; applied on `website_search.html`).

Make the controls container `position: sticky`, pinned just below the sticky
`.topbar`, below any tooltips/menus but above page content:

```css
#wsControls {          /* the .card (or .roas-controls/.toolbar) wrapping #fySeg + the date range */
  position: sticky;
  top: var(--topbar-h, 58px);   /* pin under the sticky top bar */
  z-index: 9;                    /* under .topbar (10), over content */
}
```

- The sticky bar must have an **opaque background** (`.card` / `--surface`) so
  scrolled content doesn't show through.
- `renderDateRange()` injects the custom date range right after `#fySeg` **inside
  this same bar**, so one sticky container freezes both controls together.
- **Gotcha (tooltip clip):** the sticky bar (`z-index:9`) will clip the upward ⓘ
  tooltip of any hover-lifted tile that scrolls up near it (same stacking-context
  issue as §6). Give such tiles a hover/focus z-index lift above the bar:
  `.ws-kpi:hover, .ws-kpi:focus-within { position: relative; z-index: 40; }`.

---

## 5. KPI tiles

Grid: `.kpi-grid` (auto-fit, `minmax(192px, 1fr)`, `gap:14px`). Tile anatomy:

```html
<div class="kpi">
  <div class="label">Metric name <span class="kpi-info" tabindex="0" title="What this means / its source">ⓘ</span></div>
  <div class="value">218%</div>
  <div class="delta pos">▲ 74 pts vs prior</div>
</div>
```

- **`.value`** — `29px/800`, `tabular-nums`.
- **`.delta`** — `12px/600`; `.pos` = `--pos`, `.neg` = `--neg`. Convention: ▲ up,
  ▼ down. Color by *meaning*, not direction (e.g. "▼ under budget" is positive →
  `.pos`).
- **Headline emphasis** — the first tile gets a tinted gradient background +
  accent value via `.kpi-grid .kpi:first-child` (used for the ROAS headline /
  Marketing-revenue card). Use it for the single most important number.
- **Clickable KPI** — when a tile acts as a filter, render it as
  `<button class="kpi" …>`; it inherits a stronger hover lift. Keep it keyboard-
  focusable.
- **Hover** — subtle `translateY(-3px)` + accent top bar fade-in (page-local).

---

## 6. Info tools / tooltips  ⭐ (MANDATORY)

**THE RULE:** every **card, table, and chart/graph** carries **exactly one info tool**
(a small ⓘ icon) that, on hover/focus, says **what the widget is** and **where its data
comes from**. This descriptive + provenance text lives **ONLY** in the info tool —
**never print "what it is" or "where it's from" in the widget body itself** (no source
captions under a chart, no "Medium = organic" sub-lines under a KPI, no "Live from Xero"
strap-lines). The widget shows the number / the visual; the ⓘ explains it. `roas.html`
and `roi.html` are the reference implementations.

**The one helper — `infoTip(desc, source)` (shared, in `app.js`):** renders the single
circular ℹ icon that reveals a styled `.src-tip` card with the description on top and a
"Source" line beneath (classes `.src-info` / `.src-tip` / `.src-tip-label` in `app.css`;
either arg may be empty). Use it for **every** widget:

- **Static card/chart/table heading** → put a placeholder next to the title and let
  `fillHeadInfo()` fill it once at init:
  `<div class="card-head"><h3>Revenue vs spend</h3><span class="head-info"
  data-info="What it is…" data-src="public.xero_expenses_monthly"></span></div>`
  (`.head-info` is the inline wrapper; `fillHeadInfo()` reads `data-info` + `data-src`).
- **JS-built KPI card / dynamic widget** → call `infoTip(desc, source)` inline and drop
  the returned span next to the card's `.label` (one icon per card).
- **A metric that already carries a `meta`** → fold its `meta.source` into the SAME icon
  (don't add a second one); `metaChips()`/`srcInfo()` still emit the provenance icon, but
  a widget must end up with **one** combined ⓘ, not two. (The ROI tab's `tuckKpiSubs()`
  shows the merge: pull the description sub-line + the `metaChips` source into one
  `infoTip` next to the label and remove both originals.)

**Don't** use native-`title` ⓘ (`.kpi-info`) for new work — it was the cheap first pass;
migrate those to `infoTip` so the hover card is consistent and legible. **Don't** leave a
widget with no info tool, and **don't** duplicate the description as visible body text.

**Scope:** this is NOT just for new pages — **every card, every table and every chart/graph on
every tab must carry one, with no exceptions** (marketing / leads_bookings / spend_roi /
content_social / email_partners / website_search / nurture_events / monthly_log / roi / roas and
the rest). A pending/sample widget still gets one (its ⓘ says what it *will* show and that it's
not tracked yet). Auditing a page = one ⓘ per widget, provenance/description text pulled out of
the body and into it. **Row-level detail inside a scrolling table** (a per-row ⓘ in a
`overflow:auto` wrap) is the one place to keep a native `title` instead of `infoTip` — an
`infoTip` hover card would be clipped/scrolled by the wrap; that native-`title` row icon does
**not** count as, or replace, the table's one widget-level ⓘ in its heading.

**Cache-bust gotcha:** `infoTip` / `fillHeadInfo` live in `app.js`. When a page **starts**
using them, bump that page's `app.js?v=` query — otherwise a returning visitor can be served a
**cached older `app.js` without `infoTip`** (→ `infoTip is not defined`). Bump to a version at or
above the newest already in use.

**Gotcha (z-index):** a hover-`transform` on a card/KPI creates a stacking context that can
**clip** an escaping tooltip behind a sticky bar. If a tile with an info tooltip
lifts on hover, add a matching `z-index` lift (`.kpi:hover, .kpi:focus-within
{ z-index: 40 }`) — see the ROI tab note in `CLAUDE.md`.

**Gotcha (overflow:hidden):** the `.src-tip` tooltip is absolutely positioned and escapes
**above** its tile, so any ancestor with `overflow: hidden` **clips it**. Cards/KPIs often set
`overflow: hidden` only to give a 3px top accent bar (`::before`/`::after`) clean corners —
that **must not** stay once the widget carries an ⓘ. Drop `overflow: hidden` and instead round
the accent bar to the card radius (`border-radius: 16px 16px 0 0`) so it still sits flush in the
rounded corners. Reference: the fix applied to `marketing.html` + `spend_roi.html` (and the
non-`overflow:hidden` `.kpi`/`.ne-kpi` tiles elsewhere).

---

## 7. Tables

**⭐ MANDATORY — any row-level / detail table gets sorting + filters.** A table whose
rows are individual records (one lead, deal, contact, invoice, campaign, event, …) —
i.e. anything a user would want to scan, search, sort or narrow — **MUST** be built
with the shared `renderSortableTable()` (tier B below), never hand-rolled markup. It
gives sort, search and per-column Google-Sheets-style filters for free, and
`ac_contact_sources.html` is the reference implementation. Do **not** ship a
hand-built `<table>` of record rows without sort/filter. The **only** tables exempt
are small, fixed **summary / aggregate** tables (a handful of total rows — e.g. a
by-source totals table, a ROAS-by-FY table), which may use tier A. When in doubt
(could the list grow, or would someone want to filter it?), use tier B.

Two tiers:

### A. Static/presentation table — the `.roas-table` standard
Use for curated, shaped rows (ROAS-by-FY, deals). Markup is a plain `<table
class="roas-table">` inside a `.table-scroll` wrapper (rounded, horizontal scroll
on narrow screens). Standard rules (all in ROAS page-local CSS):

- **Header:** sticky, `--surface-2`, uppercase `11px/700` muted, right-aligned
  (first column left). `position: sticky; top: 0`.
- **Numbers:** `td.num` / `th.num` → right-aligned + `tabular-nums`.
- **Row hover:** `background: var(--surface-2)`.
- **Selectable rows:** add `.clickrow` (pointer + accent-tint hover); the selected
  row is `.rowsel` (accent tint + `inset 3px 0 0 var(--accent)` left bar). This is
  the standard "click a row to filter the page" affordance.
- **Total row:** `tr.total` / `tfoot td` → `border-top: 2px`, bold, `--surface-2`.
- **Status text:** `.st-won` (`--pos`, bold) · `.st-lost` (muted) · `.st-open`
  (`--roas-amber`). Reuse these names for any won/lost/open status.

### B. Interactive table — the shared `renderSortableTable()`
Use for long, user-explored data (lead trackers, ad platforms). It's in `app.js`
and provides **sort, search, per-column Google-Sheets-style filters, pagination,
row classes, and CSV-like text projections** out of the box. Prefer this over
hand-rolling sort/filter. Key options: `columns:[{key,label,unit,render,text}]`,
`opts:{search, pageSize, rowClass, stateStore, onFilter}`.

- `unit` drives alignment/format (`currency`/`count`/`percent`/`date`/`text`).
- When a cell renders an interactive control, supply `text(v,row)` so
  filter/sort/search use a stable projection (not the control's HTML).
- Pair with `.table-search` (the rounded search input) in a toolbar.

---

## 8. Pills, chips & callouts

- **Pill (status):** `.pill` base; semantic variants
  `.roas-pass` (pos tint) / `.roas-fail` (neg tint). Use tinted-bg + colored-text,
  transparent border.
- **Chips (meta/readiness):** `metaChips(meta)` from `app.js` — emits the source
  ℹ icon plus `needs setup` (`--neg` tint) / `partial` (amber tint) chips. Every
  metric/section should carry its `meta` so provenance + readiness show
  consistently. Don't invent new readiness chips.
- **Needs-setup body:** `renderPendingBody(elId, meta)` for a card whose data
  isn't wired yet (the `.needs-setup` block). Use it instead of blank panels.
- **Pending / not-tracked-yet KPI card:** when a tile's metric has **no live data
  source yet**, do NOT show a placeholder or sample number — replace the value with a
  **red "pending" chip**: `<span class="chip warn">pending</span>` (`.chip.warn` =
  `--neg` red tint). Keep the card's **label** so the reader still knows what it will
  track. This is the dashboard-wide standard for honest empty states on summary tiles
  (e.g. `marketing.html` "Cadence delivered"; `content_social.html` KPI row + "Article
  views" / "By format and pillar" cards). **Never fabricate a number to fill a tile** —
  a red `pending` is always preferred over sample data on a live page.
- **Takeaway callout:** the `.roas-take` block — a left-accent, gradient-tinted
  one-liner summarizing the view ("**2.4×** — above the 2.00× target"). Use for a
  single headline insight above/below the KPIs.

---

## 9. Charts (Chart.js)

- Library is **vendored** at `public/vendor/chart.umd.min.js` — no CDN.
- Read theme colors at draw time via **`themeColors()`** (returns `text`, `muted`,
  `grid`, `surface`, `border`, `accent`) and **re-draw on theme toggle** by
  assigning `window.onThemeChange = drawCharts`.
- Shared helpers in `app.js`: `lineChart`, `barChart`, `pieChart`. For a combo
  (bars + line, two axes) build the config inline — set a **base `type:'bar'`** and
  give each dataset its own `type` (see `marketing.html` / ROI month chart).
- **Conventions:**
  - Gridlines `var(--grid)`; tick labels `var(--text-muted)` at `11px`; hide the
    x gridline (`grid:{display:false}`).
  - **Multi-axis charts — colour each y-axis to match the series it measures.** When a
    chart has more than one value axis, set that axis's `ticks.color` AND `title.color`
    to the same colour as the series plotted against it, so the reader can tell which
    scale belongs to which line/bars (e.g. the Marketing Overview / ROI "Revenue vs
    spend by month": the left axis reads the **blue** marketing-revenue line → blue
    ticks + blue title `#3b6ef0`; the right axis reads the **gray** company-revenue
    line → gray `#9aa4b2`). Store the colour in one const shared by the dataset and the
    axis so they can't drift. A single-series axis stays `var(--text-muted)`.
  - Money axes: tick callback → compact `$Nk`.
  - Legend at the **bottom**, `usePointStyle:true, pointStyle:'rect'`.
  - Series colors: primary = accent/blue (`#3b6ef0`), comparison = warm
    (`#d9663a`/`#c0392b`), or use `PALETTE` in order. Keep a series' color stable
    across a page.

---

## 10. Overlays (detail drill-down modal)

For "see the detail behind this row" (e.g. ROAS → Xero invoice), use the
`.inv-backdrop` / `.inv-modal` pattern: fixed full-screen scrim (`rgba(0,0,0,.45)`),
centered `--surface` modal (`max-width:760px`, radius 16), `.inv-head` with a title
+ `×` close, scrollable `.inv-body`. Open/close by toggling an `.open` class;
closable via the `×`, backdrop click, and `Escape`.

---

## 11. Interaction & motion

- **Transitions:** `.14s–.25s ease` on `color`, `background`, `box-shadow`,
  `transform`. Nothing slower.
- **Hover lift:** `translateY(-2px/-3px)` + deeper shadow for cards, KPIs, buttons.
- **Active/selected:** a **class toggle** (`.active`, `.rowsel`) — never inline
  styles or disabled-looking states.
- **Popovers (dropdowns, filter panels, modals):** close on **outside click** and
  **Escape**; the Marketing "More" dropdown and `renderSortableTable` filters are
  the reference.
- **Focus:** interactive non-buttons (info icons, clickable rows) get
  `tabindex="0"` + `role`/`aria-label`; focus styles use a `2px` accent outline or
  ring (`box-shadow: 0 0 0 2px var(--accent)`), never `outline:none` with nothing
  in its place.

---

## 12. Accessibility baseline

- Keep text on `--text` / muted on `--text-muted` — both are tuned for contrast in
  both themes. Don't put body text on a gradient.
- Icon-only controls need `aria-label`; toggles that reflect state use
  `aria-expanded` / `aria-pressed`.
- Everything clickable must be reachable and operable by keyboard.
- Respect the theme: test every new component in **both** light and dark before
  shipping (toggle with the ☾/☀ button).

---

## 13. Applying this to a new page — checklist

1. Copy the shell (`.topbar` + `.tabbar`) and the area layout from `roas.html`.
2. Define page-local accent/depth tokens (`--x-accent`, `--x-shadow*`), theme-aware.
3. Scope all page-local CSS under an id/page class in an inline `<style>`.
4. Hero: eyebrow + gradient title + sub.
5. Period/mode selectors → **segmented toggles** in a `.roas-controls` bar with
   `.ctl-label`s; drive active state by class.
6. KPIs → `.kpi-grid`/`.kpi`; emphasize the headline tile; add ℹ where a metric
   needs a note; attach `meta`/`metaChips` for provenance.
7. Tables → `renderSortableTable` (interactive) or the `.roas-table` standard
   (presentation); use `.clickrow`/`.rowsel` for row-select-to-filter.
8. Charts → vendored Chart.js, `themeColors()`, bottom legend, re-draw on theme
   change.
9. Pending data → `renderPendingBody` / `needs setup` chip, not a blank box.
10. Verify in light **and** dark; confirm keyboard + Escape/outside-click on any
    popover.

---

### Quick reference — where things live

| Thing | Location |
|---|---|
| Color tokens, base components, segmented/kpi/card/table base | `public/app.css` |
| `metaChips` / `srcInfo` / `renderKpis` / `renderTable` / `renderSortableTable` / chart helpers / `themeColors` / `initPage` | `public/app.js` |
| The reference visual layer (hero, gradient toggles, KPI tiles, roas-table, callout, modal, assistant) | `public/roas.html` inline `<style>` |
| Per-tab conventions & gotchas (e.g. tooltip clipping) | `CLAUDE.md` |
