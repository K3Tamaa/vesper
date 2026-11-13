# Vesper — design system

Mode: **Operate**. The interface serves a task. Familiarity is a feature; the identity
lives in material precision, not in novelty.

## World

A graphite instrument panel in a dark room: matte black ground, warm paper-white text,
hairline rules, engraved uppercase labels, and a single brass signal used only for the
thing that is active, selected, or moving. No glow, no neon, no glass, no gradients as
decoration. The brass is a lamp, not a paint colour.

The physical reference is analog studio hardware and darkroom equipment: rectangular
plates, precise tick marks, brass indicators, numbers set in a mono face. The interface
never draws a picture of a tape machine; it borrows the discipline.

## Colour

| Token | Value | Role |
|---|---|---|
| `--ground` | `#090A0B` | Window, rail |
| `--main` | `#0B0C0E` | Content field |
| `--panel` | `#0E1013` | Sheets, queue, tables |
| `--panel-2` | `#121519` | Inputs, pressed/hover surfaces |
| `--panel-3` | `#171A1F` | Toasts, switch pill, thumbs |
| `--line` | `#1C2024` | Structural hairline |
| `--line-soft` | `rgba(255,255,255,.055)` | Row separators |
| `--ink` | `#EDEBE6` | Primary text |
| `--ink-2` | `#A9AEB4` | Secondary text, meta |
| `--ink-3` | `#7E858C` | Labels, hints, disabled |
| `--brass` | `#D9A566` | Primary action, selection, progress, live signal |
| `--ok` / `--warn` / `--bad` | `#79A98B` / `#D0A45F` / `#D0796F` | State only |

Contrast: body and placeholder text clear 4.5:1 on the ground; the faintest ink is
reserved for decorative rules and never for text below 11px.

A 4.5%-opacity fractal noise tile sits over the ground. It is texture, not an effect:
it keeps large near-black fields from banding on wide-gamut displays.

## Type

One family carries the UI: `-apple-system, "SF Pro Text", "Helvetica Neue"`. One mono
face carries measurement: `ui-monospace, "SF Mono"`. Tabular numerals everywhere numbers
change in place.

| Role | Size / weight |
|---|---|
| Page title | 21px / 560 / -0.015em |
| Sheet title | 19px / 560 / -0.014em |
| Section label | 11px / 600 / uppercase / 0.14em |
| Body | 13px / 400 |
| Secondary | 12px / 400 |
| Control | 12–12.5px / 500–600 |
| Data / mono | 11px / 400 / tabular |

Labels are engraved, not decorative: they name a field, never sit above a heading as a
kicker. Numbers use mono because they are measurements, not because "technical".

## Layout

- Grid: 72px rail, flexible content, 344px queue dock. Below 1180px the dock becomes a
  right-side drawer with a scrim and a 280ms iOS-style curve.
- Content max width: 940px for the inspection stage, 860px for settings. Archive tables
  may run full width; data tolerates density.
- Spacing on a 4px base. Groups are separated by 24–38px; labels sit 12px above their
  rows; rows are 13px padded with a hairline between.
- The sheet is a single bounded record: 302px media plate, metadata, then a format
  ledger. The commit bar is sticky to the bottom of the content column.

## Components

- **Primary button:** brass fill, near-black label, 34px, 6px radius, 97.5% press.
  Disabled is a neutral plate, never translucent brass.
- **Quiet button:** 1px line, transparent ground, ink-2 text.
- **Inputs:** 30px, panel-2 ground, line border, brass-dim border on focus, mono for
  paths and templates.
- **Chips:** 27px; selected = brass-dim border + 7% brass wash + primary ink.
- **Format composer:** four labelled rows — Type, Container, Quality, Extras. The type
  control is a two-button switch with a sliding plate (same-width buttons, transform
  only). Containers and quality are quiet chips; the selected chip is brass-bordered
  with a 7% wash. Less common containers live in an anchored *More* menu.
- **Extras panel:** an inline disclosure that expands under the row with
  `grid-template-rows` (0fr → 1fr), so it never covers the media. Rows pair a label and
  hint with a segmented control, native select, or 32×18 toggle.
- **Resolved line:** a brass-lit dot, the resolved stream, and a mono estimate. It is the
  only place the app predicts a size, always marked with `≈`.
- **Preset chips:** the built-in setup, saved presets, and a dashed *+ Save*. The default
  carries a 4px brass dot; the active preset gains star (set default) and trash actions.
  Saving opens a small anchored form with a name field and a default toggle.
- **Queue cards:** thumbnail, title, one-line state, 2px progress rule, one mono
  telemetry line. Errors state the problem and offer Retry.
- **Status lamps:** 6px, one solid colour, no halo. Busy is the only pulsing state.
- **Focus:** 2px brass ring, 2px offset, only on `:focus-visible`.

## Motion

Tokens: `--e-out cubic-bezier(.23,1,.32,1)`, `--e-in-out cubic-bezier(.77,0,.175,1)`,
`--e-drawer cubic-bezier(.32,.72,0,1)`.

| Moment | Motion |
|---|---|
| View switch | 190ms opacity + 7px rise |
| Sheet arrival | 230ms opacity + 9px rise |
| Format rows | 240ms, 28–35ms stagger, only on first render |
| Queue card arrival | 210ms opacity + 6px rise; exit 150ms |
| Queue drawer | 280ms drawer curve |
| Kind switch | 190ms transform on a fixed-width plate |
| More / Save popovers | 190ms opacity + 4px + scale .985, origin at trigger |
| Extras disclosure | 260ms grid-row expansion, 170ms fade |
| Preset actions | 140ms color; new chip fades in with the row re-render |
| Toast | 200ms in, 180ms out, symmetric |
| Button press | 140–160ms, scale 0.975–0.98 |
| Progress | direct `scaleX` updates, 220ms linear retrace |

Rules: transform and opacity only; no keyframes on anything a user can trigger twice in
a second; no entrance choreography on page load; `prefers-reduced-motion` removes
movement and keeps state changes.

The only perpetual motion is progress: the indeterminate bar slide while a total is
unknown, and the busy lamp during install. Nothing else loops.

## Browser surfaces

Selection is 30% brass. The caret is brass. Scrollbars are 11px, graphite thumbs with a
transparent border, visible on hover. Links are underlined with brass-dim. Numerals in
tables and telemetry are tabular. The page is `color-scheme: dark` so native selects and
scrollbars match.

## Voice

Terse, second person, no exclamation marks, no marketing. Controls name the action
("Inspect", "Download", "Retry", "Reveal"). Errors name the problem and the recovery
("Checksum mismatch — the build was discarded."). Estimates are marked with `≈`.
Empty states teach the next action, never apologise.

## Guardrails

- One accent. Brass never fills an inactive surface.
- No gradient text, no glass, no zero-offset halos, no hard offset shadows.
- No emoji or unicode glyphs as icons; every icon is a 1.5px stroked SVG on a 20px grid.
- No display type in UI labels. No card-in-card nesting. No section numbering.
- Dark is chosen from the room, not from the category.
