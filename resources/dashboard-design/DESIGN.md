# Designing an `html` dashboard component in Cinna Desktop

Read this before you build or restyle a `view: "html"` component. Cinna Desktop serves
a design pack to every dashboard frame so your page looks like the app in light and
dark: a stylesheet (`_cinna/ui.css`), a chart helper (`_cinna/charts.js`) and the
app's colours as `--cinna-*` variables. Start from the example beside this file
(`example/`): copy it to `dashboards/<name>/`, rename it, then change it.

## 1. Native first

A table, a list, a row of figures or a note is a native view (`table`, `list`,
`metrics`, `markdown`): no page at all, and it already matches the app. Build an
`html` view only for charts and for what the native views cannot draw.

## 2. Link the pack

```html
<link rel="stylesheet" href="_cinna/ui.css">
<body class="cinna-page"> …
<script src="_cinna/charts.js"></script>
```

- Relative paths, exactly `_cinna/ui.css` and `_cinna/charts.js`, from a page at the
  component's root. The host answers them; never copy the files into your folder.
  A folder of your own named `_cinna/` is never served.
- The body is the tile's body: `.cinna-page` fills the frame, pads it, stacks its children with an 8 px gap and is the size container
  for `.cinna-hide-short` / `.cinna-hide-narrow`. Give the part that should take the
  remaining height `.cinna-fill` (a chart, a table wrap).
- Hide with the `hidden` attribute (the pack makes it win over its classes) or with
  `.cinna-hide-*`.
- Outside Cinna Desktop the pack is not there and `window.cinna` is not set: say
  "Open this component in Cinna Desktop" and stop.

## 3. Tokens

The host sets these on `<html>` and re-sets them when the theme changes. Use them
for every colour: `var(--cinna-fg)`, never a hex, `rgb()` or a named colour.

| Token | For |
|---|---|
| `--cinna-bg` | the tile's surface; the page background |
| `--cinna-surface`, `--cinna-surface-2` | a raised card (KPI, callout), and one step more (code, badges, the empty heat cell) |
| `--cinna-hover` | a hovered row |
| `--cinna-fg` | text |
| `--cinna-fg-secondary` | secondary text, legends, labels |
| `--cinna-muted` | captions, axis ticks, units, "vs last week" |
| `--cinna-border` | dividers, table header rule |
| `--cinna-grid`, `--cinna-axis` | chart grid hairlines; the zero/base axis |
| `--cinna-accent`, `--cinna-on-accent` | the one accent (links, the selected row, the sparkline's last point); text on it |
| `--cinna-success`, `--cinna-warning`, `--cinna-danger` | status only, always with an icon, arrow or word |
| `--cinna-highlight`, `--cinna-highlight-tint` | what the agent highlighted (`cinna.onHighlight`): a mark, and a row's background |
| `--cinna-chart-1` … `--cinna-chart-8` | series colours, by slot, in this order |
| `--cinna-chart-pos`, `--cinna-chart-neg` | a diverging scale: above / below a target |
| `--cinna-seq` | the sequential hue (= slot 1); mix it toward `--cinna-bg` for magnitude |
| `--cinna-font`, `--cinna-font-mono` | the app's text and code fonts |

## 4. Classes (`_cinna/ui.css`)

- Page: `.cinna-page`, `.cinna-fill`; text `.cinna-muted`, `.cinna-secondary`,
  `.cinna-meta` (12 px caption), `.cinna-num` (tabular figures), `.cinna-section-title`.
- Prose: `.cinna-prose` around HTML text — h1–h3, p, lists, links, `code`, blockquote,
  hr, a small table — at the app's markdown scale.
- Figures: `.cinna-kpi-row` > `.cinna-kpi` > `.cinna-kpi-label`, `.cinna-kpi-value`
  (with `.cinna-unit` inside), `.cinna-delta`, an optional `.cinna-sparkline`. One hero
  figure: `.cinna-hero` > `.cinna-hero-value` + `.cinna-hero-label`.
- Delta: `.cinna-delta` plus `.is-good` / `.is-bad` (none for no change); arrow and sign
  in the text (`▲ +6.1%`, `▼ −3`, `— 0`), the comparison in `.cinna-vs`, kept short
  (`vs last wk`): a delta stays on one line and one too long for its card ends in an
  ellipsis. Good is a judgement: fewer open tickets is `.is-good`.
- Badge: `.cinna-badge`, with `.is-success`, `.is-warning`, `.is-danger`, `.is-accent`
  for a status dot; the word says the status.
- Table: `.cinna-table-wrap.cinna-fill` > `table.cinna-table`; `th`/`td` `.is-num` for
  right-aligned figures; `tr.is-selected` (the owner's pick), `tr.is-highlighted`
  (the agent's).
- List: `ul.cinna-list` > `li` > `.cinna-list-title` + `.cinna-list-meta`.
- Controls, sparingly: `.cinna-seg` > `button[aria-pressed]` (a segmented switch),
  `.cinna-button`. The tile's own params row is the host's; prefer params.
- States: `.cinna-empty` (an icon and a sentence, centred), `.cinna-skeleton` (give it
  a height and width), `.cinna-callout` with `.is-warning` / `.is-danger` /
  `.is-success` (an icon `svg.cinna-icon` + a sentence).
- Charts: `.cinna-legend`, `.cinna-tooltip` are drawn by `charts.js`; you rarely write them.
- Size: `.cinna-hide-short` (hidden below 150 px of page height; KPI values drop to 22,
  the hero to 32), `.cinna-hide-narrow` (below 300 px of width; the KPI row goes to two
  columns).

## 5. Charts (`_cinna/charts.js`, `window.CinnaCharts`)

Dependency-free SVG, no `eval`. Colours are tokens, so a theme change needs no redraw;
a resize redraws itself. Give the chart's element a height (`.cinna-fill`).

```js
const chart = CinnaCharts.line(el, { x: ids, xLabels, series: [{ id, label, values, slot }], format: 'money' })
chart.update(spec); chart.select(id); chart.highlight(ids); chart.destroy()
```

- `line(el, spec)` — `x` (ids, also the labels unless `xLabels`), `series`, `format`
  (`'number'` default, `'money'`, `'percent'` for a fraction, or a function), `unit`,
  `zero: false` to not start at 0, `area: true` for a wash under the line, `endLabels:
  false`, `label` (the chart's accessible name). Curved (monotone), a `null` breaks the
  line, a hover shows every series at that x.
- `bar(el, spec)` — one series, grouped (several), `stacked: true`, or `diverging: true`
  (one series coloured by sign with `--cinna-chart-pos/neg`); `ids` when the ids are
  not `x`; `labelMax: false` to not label the tallest bar; `onSelect(id)` makes bars
  clickable (a second click clears, with `null`).
- `hbar(el, spec)` — a ranking: `items: [{ id, label, value, slot }]`, `onSelect`.
- `donut(el, spec)` — `items`, `centerLabel`, `total`; for a part of a whole with ≤ 5 parts.
- `heatmap(el, spec)` — `rows`, `cols`, `values[row][col]`, `valueLabel`; sequential colour.
- `sparkline(el, values, { color })` — a trend in muted ink, the last point in the accent.
- `segmented(el, items, { format })` — one whole split into a thin bar with a legend.
- `CinnaCharts.format(v, format, unit)`, `CinnaCharts.signed(v, format, unit)` — the
  same number formatting outside a chart.
- `slot` (1–8) fixes a series' colour; default is its position. Keep a series on the
  same slot across tiles and refreshes.

Wire selection and the agent's highlight in one line each:

```js
const chart = CinnaCharts.bar(el, { x: weekIds, series, onSelect: (id) => cinna.setContext({ summary, selection: id ? [id] : [], visible: weekIds }) })
cinna.onHighlight((ids) => chart.highlight(ids))   // [] clears
```

`highlight` draws on `line` and `bar` (by x id) and `hbar` (by item id). For a table,
toggle `tr.is-highlighted` yourself. Call `setContext` after each data and selection
change, with the ids you highlight by.

## 6. Type scale

Body and prose 14; prose headings 17 / 16 / 14. Legends, chart labels, tooltips, KPI
labels, deltas, subtitles 12. Callouts and empty states 13. Dense rows (tables, lists,
rankings) and axis ticks 11. Table headers 10. KPI value 28 (22 on a short tile); one
hero figure 40 (32 short). The tile bar above your page shows the title at 13. The
classes already set these sizes: do not set font sizes of your own.

## 7. Rules

- **No title inside the tile.** The tile bar shows it; a subtitle or a "vs last month"
  line is fine.
- **Tokens only.** Every colour is a `var(--cinna-*)`.
- **Colour by slot, in order.** Up to 8 series; fold a 9th and more into "Other". Never
  two y-axes.
- **Text never wears a series colour.** Identity comes from the swatch, line key or
  mark beside it.
- **Status colours mean status** and always come with an icon, arrow or word.
- **A legend for two or more series** (`charts.js` draws it); label selectively — the
  end, the max, the selection — never every point.
- **Fit the size** (below); hide secondary parts with `.cinna-hide-short` / `-narrow`.
- **Empty, loading and notice states** use `.cinna-empty`, `.cinna-skeleton` and
  `.cinna-callout`; never a blank tile.
- **Selection and highlight** go through the chart's `select` / `highlight`, and
  `setContext` after each.
- **Look at it in both themes** before you print the reference.

## 8. Tile sizes

The grid has 12 columns and 110 px rows; the page gets the tile minus its 34 px bar.

- **Small `s`, 3×2** — one number (`.cinna-hero`) with a sparkline or a segmented bar,
  or one single-series chart. Nothing else.
- **Medium `m`, 6×2** — one chart, or a KPI row of up to four; short: use `.cinna-hide-short`.
- **Large `l`, 6×4** — a KPI row plus a chart, or a chart plus a short table or note.
- **Wide `wide`, 12×2** — a KPI row of up to six, a heatmap, or a long time series.
- **Tall `tall`, 3×4** — a ranking (`hbar`), a list, a donut with its legend, or prose.

The owner can resize a tile: build for the size you declare and degrade with the
`.cinna-hide-*` classes rather than overflowing.
