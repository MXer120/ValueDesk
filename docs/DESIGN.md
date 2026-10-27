# ValueDesk design guide

The reference surfaces are the **trade page**, the **wallet pop-up** (`components/account/account.css`,
`.navaddr__menu.acct-menu`), the **deposit / transfer / withdraw sheets** (`components/funds/funds.css`) and the
**cohort pages** (`components/explore/cohorts/`). A new surface copies them; it does not invent. All tokens live in
`apps/web/src/styles.css` (`:root`). **Never hard-code a colour, size, radius or duration that has a token.**

## 1. Colour

| Role | Token | Notes |
|---|---|---|
| Page | `--bg` | darkest |
| Panel / card | `--bg-panel` | panels, navbar, tab bars |
| Raised (pop-ups, inputs) | `--bg-elevated`, hover `--bg-hover` | |
| Text | `--text` values, active · `--muted` labels · `--dim` faint · `--disabled` | |
| Hairlines | `--panel-line` (panel borders) · `--line` (controls, pop-up borders) · `--line-soft` / `--line-strong` | |
| Accent | `--accent` (near-white) with `--accent-text` on it | the one primary action per page |
| Warning | `--warn` | "needs attention" only |

### Bullish / bearish — one pair, everywhere
**Long, profit, bullish, buy, up = `--pos`. Short, loss, bearish, sell, down = `--neg`.** Nothing else means
direction: no other greens or reds, no hex values, no library defaults.
- Tints are always `color-mix(in srgb, var(--pos|--neg) N%, transparent | var(--bg-panel))`: pills ~14%, tiles 14–60%
  by strength, glows ≤ 22% fading to 0.
- Deep ends for gradients: `--pos-deep`, `--neg-deep` (buy / sell buttons: `--button-buy`, `--button-sell`).
- Books: `--bid-bg`, `--ask-bg`. Faded: `--pos-dim`, `--neg-dim`.
- A value's sign decides its colour (`signClass`, `.pos` / `.neg`); zero stays `--text`.
- Identity colours (venue brands in `components/venueBrand.ts`, the size cohorts' lines in `cohorts/cohortStyle.ts`)
  are never used to mean up/down. Where a series itself means profit/loss (the PnL cohorts' lines) it is built from
  the pair: `var(--pos)` / `var(--neg)` fading toward `--text` with `color-mix`, never its own green or red.
- Canvas code that cannot read CSS variables (chart themes) copies the token values exactly and says so.

## 2. Type
Two faces: `--font-text` (IBM Plex Sans) for words, `--font-num` (Asap) + `font-variant-numeric: tabular-nums` for
every figure. **The scale is four sizes** — `--fs-micro` 10 · `--fs-xs` 12 · `--fs-base` 14 · `--fs-xl` 20 (line
heights `--lh-*`). There is no `--fs-sm/md/lg`: an undefined token silently inherits and misaligns headings.
- Sanctioned exception: text inputs on phones are 16px (below that iOS zooms the page on focus).
- Weights: only 400 and 500 are loaded (no synthetic bold), so 500 is the heaviest; never write 600/700.
- Panel titles: `--fs-xs`, 500. Page / cohort titles: `--fs-base`, 500. Big readouts: `--fs-xl`, 500.
- Small caps labels (meter titles, table groups): `--fs-micro`, uppercase, `letter-spacing: .06em`, `--muted`.
- Weight never signals selection; colour and the accent stub do.

## 3. Space, radius, elevation
- Spacing `--sp-1..6` = 4 / 8 / 12 / 16 / 24 / 32. Panel gutter **12px**; every panel header is one strip
  (`min-height: 42px`, `padding: 8px 12px`, bottom hairline) and bodies share the 12px gutter.
- Radius: controls `--radius-md` (8), cards 12, pop-ups 10–14, pills 4–6, avatars/logos round.
- Shadows: `--shadow-pop` (menus), `--shadow-modal` (dialogs, sheets).

## 4. Glass — every floating surface
Anything that floats over content (menus, pop-overs, the View panel, tooltips with more than a line, the command
palette, sheets) is glass:

```css
background: var(--glass-pop-bg);                 /* sheets / large dialogs: var(--glass-sheet-bg) */
-webkit-backdrop-filter: var(--glass-pop-blur);  /* sheets: var(--glass-sheet-blur) */
backdrop-filter: var(--glass-pop-blur);
border: 1px solid var(--line);
box-shadow: var(--shadow-modal);
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  /* the same selector */ { background: var(--bg-elevated); }
}
```
- Scrims under modals: `--scrim` (light) / `--scrim-solid`. A scrim may blur at most 4px (the command palette's): only the
  sheet on top carries the full glass blur, since a full-screen blur costs a frame on open.
- Enter with `pop-in` (`--dur-fast`, `--ease-spring`); exit through `usePresence` (fade, 160ms) — never a blink.
- In-chart readouts (hover boxes, corner badges, zoom controls) are the light variant: `color-mix(in srgb, var(--bg)
  78–88%, transparent)` + `--panel-line` border + `backdrop-filter: blur(8px)` so lines under them never read
  through, `pointer-events: none` unless they are controls. A hover tooltip with more than one line is full glass.
- Dropdowns are the cohort `Picker` (`cohorts/parts.tsx`) or ViewPop — never a native `<select>` (its list cannot be
  glass).
- A pop-up never scrolls as a whole when it can avoid it: fixed sections (headers, tabs, shortcuts) stay put and only
  the list inside scrolls (`min-height: 0; overflow: auto` on the list, the frame `max-height` + flex column).

## 5. Controls
- **Segments** (one of N): `.lbp-seg` (bars) / `.acctf-seg` (inside View). Selected = `.is-on`.
- **Chips** (many of N, brand-coloured): `.lbp-chip` with `--brand`; selected = brand border + 11% brand fill.
- **View** (show / filter): the `ViewPop` panel (`components/ViewPop.tsx`) opened by `.acctf-view` with the
  sliders glyph and an active-count badge; sections are FilterBar `Section` + `Seg`; always a Reset.
- **Pills** for a word + direction (`.coh-bias`): `--pos`/`--neg` text on a 14% tint, arrow glyph.
- **Primary button**: `.pf-btn--primary` (accent). Buy/sell: `.sidetabs` gradients with `--sheen`.
- Focus: `:focus-visible` ring `--focus`; an input inside a bordered row shows the row's accent border, no inner ring.

## 6. Data
- Tables: `.acct-table.acct-t` (20px rows, sentence-case heads, hover tint, `td.num` right-aligned tabular).
- Money: `fmtUsdShort` / `fmtUsd`; signed `+$1.2M` / `−$1.2M` (true minus). Counts `fmtCount`. Missing = `—` (DASH),
  never 0.
- Long/short split: `.pf-split` bar (`--pos` fill over `--neg`).
- Charts: grid `--panel-line`, even line dashed `--muted` at 55%, lines 1.5–1.8px, `vector-effect: non-scaling-stroke`.
  Lines morph between datasets (fixed sample count, CSS `d` transition).

## 7. Logos and icons
- Coins: `CoinIcon` (self-hosted, letter avatar fallback). Venues: `VenueLogo` (brand marks, self-hosted). Cohorts:
  `CohortIcon`. **No runtime image hot-linking** (CSP; see memory "logos self-hosted").
- UI glyphs: inline SVG, 24px grid, 1.6 stroke, `currentColor`, round caps. A list row always has a leading mark
  (coin / venue / avatar / glyph) so rows align.

## 8. States
- Loading: skeleton shimmer (`@keyframes` ≤ 1.2s linear), never a bare "Loading…" in a chart.
- Refresh: keep the last answer on screen; dim to 0.6 only if the new one takes > 350ms (`transition-delay`).
- Empty: a one-line title (`--fs-base`, 500) + one muted sentence; production copy, no internals.
- Errors: `LoadFailed` with Retry.

## 9. Motion
`--dur-fast` 140ms (hover, colour), `--dur-med` 200ms, 220–520ms for layout / data morphs with `--ease-out`.
Everything honours `prefers-reduced-motion: reduce` (transitions and animations off).

## 10. Checklist for a new surface
1. Tokens only (colour, size, space, radius, duration). 2. Floating → glass (§4) with the fallback.
3. Direction colours only `--pos`/`--neg`. 4. Numbers tabular in `--font-num`. 5. Header strip + 12px gutter.
6. Every row has a leading mark. 7. Loading / empty / error states. 8. Reduced motion. 9. Keyboard + focus-visible.
