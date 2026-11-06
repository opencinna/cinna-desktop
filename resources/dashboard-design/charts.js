// Cinna dashboard charts — the desktop design pack's chart helper, served to every
// dashboard frame at `_cinna/charts.js` (`<script src="_cinna/charts.js"></script>`).
// Guide: DESIGN.md beside this file.
// Dependency-free SVG, no eval (the frame's CSP allows none), no network.
// Every colour is a `var(--cinna-*)` in a style, so a theme change needs no redraw;
// a resize redraws through a ResizeObserver.
//
//   const chart = CinnaCharts.line(el, { x, series: [{ id, label, values, slot? }], format })
//   chart.update(spec) · chart.select(id) · chart.highlight(ids) · chart.destroy()
//
// Forms: line (area: true for a wash), bar (stacked, diverging), hbar (ranking),
// donut, heatmap, segmented, sparkline. Colour follows the series' slot, never its rank.
(function () {
  'use strict'
  const NS = 'http://www.w3.org/2000/svg'
  const SLOTS = 8

  // ---- formatting -----------------------------------------------------------

  function compact(v) {
    const a = Math.abs(v)
    if (a >= 1e9) return trim(v / 1e9) + 'B'
    if (a >= 1e6) return trim(v / 1e6) + 'M'
    if (a >= 1e4) return trim(v / 1e3) + 'K'
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  }
  function trim(v) {
    return (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toString()
  }
  /** number · money · percent (a fraction: 0.31 → 31%) · a function. */
  function format(v, f, unit) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—'
    if (typeof f === 'function') return f(v)
    const a = Math.abs(v)
    const sign = v < 0 ? '−' : ''
    let s
    if (f === 'money') s = sign + '$' + (a >= 1e9 ? trim(a / 1e9) + 'B' : a >= 1e6 ? trim(a / 1e6) + 'M' : a >= 1e3 ? trim(a / 1e3) + 'K' : Math.round(a))
    else if (f === 'percent') s = sign + trim(a * 100) + '%'
    else s = sign + compact(a)
    return unit ? s + ' ' + unit : s
  }
  function signed(v, f, unit) {
    return (v > 0 ? '+' : '') + format(v, f, unit)
  }

  function niceTicks(min, max, count) {
    if (min === max) max = min + 1
    const span = max - min
    const raw = span / Math.max(1, count)
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag
    const lo = Math.floor(min / step) * step
    const hi = Math.ceil(max / step) * step
    const ticks = []
    for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t / step) * step)
    return ticks
  }

  // ---- dom helpers ----------------------------------------------------------

  function svgEl(name, attrs, parent, style) {
    const node = document.createElementNS(NS, name)
    for (const k in attrs) node.setAttribute(k, String(attrs[k]))
    if (style) node.setAttribute('style', style)
    if (parent) parent.appendChild(node)
    return node
  }
  function div(cls, parent, text) {
    const node = document.createElement('div')
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    if (parent) parent.appendChild(node)
    return node
  }
  const color = (slot) => `var(--cinna-chart-${((slot - 1) % SLOTS) + 1})`
  const textW = (s, px) => String(s).length * px * 0.58

  /** Rounded data end, square at the baseline. y0 = baseline, y1 = data end. */
  function barPath(x, y0, y1, w, r) {
    const up = y1 < y0
    const len = Math.abs(y0 - y1)
    r = Math.min(r, w / 2, len)
    if (len < 0.5) return ''
    if (up) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`
    return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`
  }
  function hbarPath(x0, x1, y, h, r) {
    const len = x1 - x0
    r = Math.min(r, h / 2, len)
    if (len < 0.5) return ''
    return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 - r},${y + h}H${x0}Z`
  }

  // ---- the shell every chart shares ----------------------------------------

  function mount(el, spec, draw) {
    el.classList.add('cinna-chart')
    el.innerHTML = ''
    const legend = div('cinna-legend', el)
    const plot = div('cinna-chart-plot', el)
    const tip = div('cinna-tooltip', el)
    tip.hidden = true
    const state = { spec, selected: spec.selected ?? null, highlight: spec.highlight || [] }

    function showTip(html, px, py) {
      tip.innerHTML = html
      tip.hidden = false
      const box = el.getBoundingClientRect()
      const tw = tip.offsetWidth
      const th = tip.offsetHeight
      let left = px + 12
      if (left + tw > box.width - 4) left = px - tw - 12
      let top = py - th / 2
      top = Math.max(4, Math.min(top, box.height - th - 4))
      tip.style.left = Math.max(4, left) + 'px'
      tip.style.top = top + 'px'
    }
    function hideTip() {
      tip.hidden = true
    }

    function render() {
      const w = plot.clientWidth
      const h = plot.clientHeight
      plot.innerHTML = ''
      if (w < 20 || h < 20) return
      const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img' }, plot)
      if (state.spec.label) svg.setAttribute('aria-label', state.spec.label)
      draw({ svg, w, h, spec: state.spec, state, legend, showTip, hideTip, plot, el, select })
    }
    function select(id) {
      state.selected = state.selected === id ? null : id
      render()
      if (state.spec.onSelect) state.spec.onSelect(state.selected)
    }

    const ro = new ResizeObserver(() => render())
    ro.observe(plot)
    render()
    return {
      update(next) {
        state.spec = next
        state.selected = next.selected ?? state.selected
        render()
      },
      select(id) {
        state.selected = id
        render()
      },
      highlight(ids) {
        state.highlight = ids || []
        render()
      },
      destroy() {
        ro.disconnect()
        el.innerHTML = ''
      }
    }
  }

  function drawLegend(legend, items) {
    legend.innerHTML = ''
    legend.hidden = items.length < 2
    for (const it of items) {
      const row = div('cinna-legend-item', legend)
      const sw = document.createElement('span')
      sw.className = 'cinna-swatch' + (it.line ? ' is-line' : '')
      sw.style.background = it.color
      row.appendChild(sw)
      row.appendChild(document.createTextNode(it.label))
    }
  }

  function tipRows(title, rows, fmt, unit) {
    let html = `<div class="cinna-tooltip-title">${esc(title)}</div>`
    for (const r of rows) {
      html += `<div class="cinna-tooltip-row"><span class="cinna-swatch" style="background:${r.color}"></span><span class="cinna-tooltip-label">${esc(r.label)}</span><span class="cinna-tooltip-value">${esc(r.text ?? format(r.value, fmt, unit))}</span></div>`
    }
    return html
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  }

  /** A value axis: grid hairlines, tick labels, and the scale. */
  function valueAxis(svg, min, max, top, bottom, left, right, fmt, unit) {
    const ticks = niceTicks(min, max, Math.max(2, Math.min(5, Math.floor((bottom - top) / 36))))
    const lo = ticks[0]
    const hi = ticks[ticks.length - 1]
    const y = (v) => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top)
    for (const t of ticks) {
      const yy = Math.round(y(t)) + 0.5
      svgEl('line', { x1: left, x2: right, y1: yy, y2: yy }, svg, `stroke:var(${t === 0 || t === lo ? '--cinna-axis' : '--cinna-grid'});stroke-width:1`)
      svgEl('text', { x: left - 6, y: yy, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'cinna-axis-text' }, svg).textContent = format(t, fmt, unit)
    }
    return { y, lo, hi }
  }
  function axisWidth(min, max, fmt, unit) {
    const ticks = niceTicks(min, max, 4)
    return Math.max(...ticks.map((t) => textW(format(t, fmt, unit), 11))) + 10
  }
  function categoryLabels(svg, labels, xOf, y, avail) {
    const widest = Math.max(...labels.map((l) => textW(l, 11))) + 10
    const every = Math.max(1, Math.ceil((widest * labels.length) / avail))
    // Every `every`-th label, counted back from the last so the newest always shows.
    const last = labels.length - 1
    labels.forEach((l, i) => {
      if ((last - i) % every !== 0) return
      svgEl('text', { x: xOf(i), y, 'text-anchor': 'middle', class: 'cinna-axis-text' }, svg).textContent = l
    })
  }

  /**
   * A monotone cubic through the points (Fritsch–Carlson, as d3's curveMonotoneX):
   * smooth, and never bulging above a peak or below a trough the data does not have.
   */
  function smooth(p) {
    const f = (n) => n.toFixed(1)
    if (p.length === 1) return `M${f(p[0][0])},${f(p[0][1])}`
    if (p.length === 2) return `M${f(p[0][0])},${f(p[0][1])}L${f(p[1][0])},${f(p[1][1])}`
    const n = p.length
    const dx = []
    const m = []
    for (let i = 0; i < n - 1; i++) {
      dx.push(p[i + 1][0] - p[i][0])
      m.push((p[i + 1][1] - p[i][1]) / (dx[i] || 1))
    }
    const t = [m[0]]
    for (let i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) t.push(0)
      else {
        const w1 = 2 * dx[i] + dx[i - 1]
        const w2 = dx[i] + 2 * dx[i - 1]
        t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]))
      }
    }
    t.push(m[n - 2])
    let d = `M${f(p[0][0])},${f(p[0][1])}`
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3
      d += `C${f(p[i][0] + h)},${f(p[i][1] + h * t[i])} ${f(p[i + 1][0] - h)},${f(p[i + 1][1] - h * t[i + 1])} ${f(p[i + 1][0])},${f(p[i + 1][1])}`
    }
    return d
  }

  // ---- line / area ----------------------------------------------------------

  function line(el, spec) {
    return mount(el, spec, (c) => {
      const { svg, w, h, spec, state } = c
      const series = spec.series
      const n = spec.x.length
      const slots = series.map((s, i) => s.slot || i + 1)
      drawLegend(c.legend, series.map((s, i) => ({ label: s.label, color: color(slots[i]), line: true })))
      const all = series.flatMap((s) => s.values.filter((v) => v !== null))
      const min = spec.zero === false ? Math.min(...all) : Math.min(0, ...all)
      const max = Math.max(...all)
      const endLabels = series.length <= 4 && spec.endLabels !== false && w > 260
      const pl = axisWidth(min, max, spec.format, spec.unit)
      const pr = endLabels ? Math.max(...series.map((s) => textW(s.label, 12))) + 14 : 10
      const pt = 8
      const pb = h - 18
      const ax = valueAxis(svg, min, max, pt, pb, pl, w - pr, spec.format, spec.unit)
      const x = (i) => pl + (n === 1 ? (w - pr - pl) / 2 : (i / (n - 1)) * (w - pr - pl))
      for (const id of state.highlight) {
        const i = spec.x.indexOf(id)
        if (i < 0) continue
        const bw = Math.max(8, (w - pr - pl) / Math.max(1, n - 1))
        svgEl('rect', { x: x(i) - bw / 2, y: pt, width: bw, height: pb - pt }, svg, 'fill:var(--cinna-highlight);fill-opacity:0.14')
        svgEl('rect', { x: x(i) - bw / 2, y: pb - 2, width: bw, height: 2 }, svg, 'fill:var(--cinna-highlight)')
      }
      const ends = []
      series.forEach((s, si) => {
        const pts = s.values.map((v, i) => (v === null ? null : [x(i), ax.y(v)]))
        // Curved through every point (monotone: no overshoot past the data); a null breaks the line.
        let d = ''
        let run = []
        for (const p of [...pts, null]) {
          if (p) run.push(p)
          else if (run.length) {
            d += smooth(run)
            run = []
          }
        }
        if (spec.area) {
          const first = pts.findIndex(Boolean)
          const last = pts.length - 1 - [...pts].reverse().findIndex(Boolean)
          const base = ax.y(Math.max(ax.lo, 0))
          svgEl('path', { d: `${d}L${pts[last][0]},${base}L${pts[first][0]},${base}Z` }, svg, `fill:${color(slots[si])};fill-opacity:0.1`)
        }
        svgEl('path', { d }, svg, `fill:none;stroke:${color(slots[si])};stroke-width:2;stroke-linejoin:round;stroke-linecap:round`)
        const lastI = pts.length - 1 - [...pts].reverse().findIndex(Boolean)
        const p = pts[lastI]
        svgEl('circle', { cx: p[0], cy: p[1], r: 4 }, svg, `fill:${color(slots[si])};stroke:var(--cinna-bg);stroke-width:2`)
        ends.push({ y: p[1], x: p[0], label: s.label })
      })
      if (endLabels) {
        ends.sort((a, b) => a.y - b.y)
        let prev = -Infinity
        const clear = ends.every((e) => {
          const ok = e.y - prev >= 14
          prev = e.y
          return ok
        })
        if (clear || series.length === 1)
          for (const e of ends) svgEl('text', { x: e.x + 8, y: e.y, 'dominant-baseline': 'middle', class: 'cinna-label-text' }, svg).textContent = e.label
      }
      categoryLabels(svg, spec.x.map((l, i) => (spec.xLabels ? spec.xLabels[i] : l)), x, h - 4, w - pl - pr)
      // hover: crosshair + every series at that x
      const guide = svgEl('line', { y1: pt, y2: pb, visibility: 'hidden' }, svg, 'stroke:var(--cinna-muted);stroke-width:1')
      const dots = series.map((s, si) => svgEl('circle', { r: 4, visibility: 'hidden' }, svg, `fill:${color(slots[si])};stroke:var(--cinna-bg);stroke-width:2`))
      const hit = svgEl('rect', { x: pl, y: pt, width: w - pl - pr, height: pb - pt }, svg, 'fill:transparent')
      hit.addEventListener('pointermove', (ev) => {
        const r = svg.getBoundingClientRect()
        const px = ev.clientX - r.left
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - pl) / (w - pr - pl)) * (n - 1))))
        guide.setAttribute('x1', x(i))
        guide.setAttribute('x2', x(i))
        guide.setAttribute('visibility', 'visible')
        const rows = []
        series.forEach((s, si) => {
          const v = s.values[i]
          if (v === null) return void dots[si].setAttribute('visibility', 'hidden')
          dots[si].setAttribute('cx', x(i))
          dots[si].setAttribute('cy', ax.y(v))
          dots[si].setAttribute('visibility', 'visible')
          rows.push({ label: s.label, value: v, color: color(slots[si]) })
        })
        rows.sort((a, b) => b.value - a.value)
        c.showTip(tipRows(spec.xLabels ? spec.xLabels[i] : spec.x[i], rows, spec.format, spec.unit), x(i), ev.clientY - r.top)
      })
      hit.addEventListener('pointerleave', () => {
        guide.setAttribute('visibility', 'hidden')
        dots.forEach((d) => d.setAttribute('visibility', 'hidden'))
        c.hideTip()
      })
    })
  }

  // ---- vertical bars: single, grouped, stacked, diverging --------------------

  function bar(el, spec) {
    return mount(el, spec, (c) => {
      const { svg, w, h, spec, state } = c
      const series = spec.series
      const n = spec.x.length
      const slots = series.map((s, i) => s.slot || i + 1)
      const diverging = !!spec.diverging
      const colorOf = (si, v) => (diverging ? (v < 0 ? 'var(--cinna-chart-neg)' : 'var(--cinna-chart-pos)') : color(slots[si]))
      drawLegend(c.legend, diverging ? [] : series.map((s, i) => ({ label: s.label, color: color(slots[i]) })))
      let min = 0
      let max = 0
      for (let i = 0; i < n; i++) {
        if (spec.stacked) {
          max = Math.max(max, series.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0))
          min = Math.min(min, series.reduce((a, s) => a + Math.min(0, s.values[i] || 0), 0))
        } else
          for (const s of series) {
            max = Math.max(max, s.values[i] || 0)
            min = Math.min(min, s.values[i] || 0)
          }
      }
      const pl = axisWidth(min, max, spec.format, spec.unit)
      const pr = 8
      const pt = 14
      const pb = h - 18
      const ax = valueAxis(svg, min, max, pt, pb, pl, w - pr, spec.format, spec.unit)
      const band = (w - pl - pr) / n
      const zero = ax.y(0)
      const k = spec.stacked ? 1 : series.length
      const groupW = Math.min(band * 0.72, k * 24 + (k - 1) * 2)
      const barW = (groupW - (k - 1) * 2) / k
      const ids = spec.ids || spec.x
      const hasSel = state.selected !== null && state.selected !== undefined
      for (let i = 0; i < n; i++) {
        const bx = pl + i * band
        const id = ids[i]
        if (state.highlight.includes(id)) {
          svgEl('rect', { x: bx + 1, y: pt, width: band - 2, height: pb - pt, rx: 3 }, svg, 'fill:var(--cinna-highlight);fill-opacity:0.14')
          svgEl('rect', { x: bx + 1, y: pb - 2, width: band - 2, height: 2 }, svg, 'fill:var(--cinna-highlight)')
        }
        const dim = hasSel && state.selected !== id ? ';opacity:0.38' : ''
        const x0 = bx + (band - groupW) / 2
        if (spec.stacked) {
          let up = 0
          let down = 0
          const top = series.reduce((last, s, si) => ((s.values[i] || 0) > 0 ? si : last), -1)
          series.forEach((s, si) => {
            const v = s.values[i] || 0
            if (!v) return
            const from = v > 0 ? up : down
            const to = from + v
            if (v > 0) up = to
            else down = to
            let y0 = ax.y(from)
            let y1 = ax.y(to)
            if (from !== 0) y0 -= 1 * Math.sign(v) // 2px surface gap between segments
            if (si !== top) y1 += 1 * Math.sign(v)
            const r = si === top ? 4 : 0
            svgEl('path', { d: barPath(x0, y0, y1, barW, r) }, svg, `fill:${colorOf(si, v)}${dim}`)
          })
        } else {
          series.forEach((s, si) => {
            const v = s.values[i]
            if (v === null || v === undefined) return
            svgEl('path', { d: barPath(x0 + si * (barW + 2), zero, ax.y(v), barW, 4) }, svg, `fill:${colorOf(si, v)}${dim}`)
          })
        }
        if (series.length === 1 && (state.selected === id || (!hasSel && spec.labelMax !== false && series[0].values[i] === Math.max(...series[0].values)))) {
          const v = series[0].values[i]
          const ty = v >= 0 ? ax.y(v) - 5 : ax.y(v) + 12
          svgEl('text', { x: bx + band / 2, y: ty, 'text-anchor': 'middle', class: 'cinna-label-text' }, svg).textContent = format(v, spec.format, spec.unit)
        }
        const hit = svgEl('rect', { x: bx, y: pt, width: band, height: pb - pt }, svg, 'fill:transparent;cursor:' + (spec.onSelect ? 'pointer' : 'default'))
        hit.addEventListener('pointermove', (ev) => {
          const r = svg.getBoundingClientRect()
          const rows = series.map((s, si) => ({ label: diverging ? s.label : s.label, value: s.values[i], color: colorOf(si, s.values[i] || 0), text: diverging ? signed(s.values[i], spec.format, spec.unit) : undefined }))
          if (spec.stacked && series.length > 1) rows.push({ label: 'Total', value: series.reduce((a, s) => a + (s.values[i] || 0), 0), color: 'transparent' })
          c.showTip(tipRows(spec.xLabels ? spec.xLabels[i] : spec.x[i], rows, spec.format, spec.unit), bx + band / 2, ev.clientY - r.top)
        })
        hit.addEventListener('pointerleave', c.hideTip)
        if (spec.onSelect) hit.addEventListener('click', () => c.select(id))
      }
      categoryLabels(svg, spec.x.map((l, i) => (spec.xLabels ? spec.xLabels[i] : l)), (i) => pl + i * band + band / 2, h - 4, w - pl - pr)
    })
  }

  // ---- horizontal ranking ---------------------------------------------------

  function hbar(el, spec) {
    return mount(el, spec, (c) => {
      const { svg, w, h, spec, state } = c
      const items = spec.items
      drawLegend(c.legend, [])
      const max = Math.max(...items.map((it) => it.value))
      const labelW = Math.min(w * 0.42, Math.max(...items.map((it) => textW(it.label, 11))) + 8)
      const valueW = Math.max(...items.map((it) => textW(format(it.value, spec.format, spec.unit), 12))) + 8
      const rowH = Math.min(26, h / items.length)
      const thick = Math.max(6, Math.min(12, rowH - 12))
      const x0 = labelW
      const span = w - labelW - valueW
      items.forEach((it, i) => {
        const y = i * rowH
        const mid = y + rowH / 2
        if (state.highlight.includes(it.id)) {
          svgEl('rect', { x: 0, y: y + 1, width: w, height: rowH - 2, rx: 3 }, svg, 'fill:var(--cinna-highlight);fill-opacity:0.14')
          svgEl('rect', { x: 0, y: y + 1, width: 2, height: rowH - 2 }, svg, 'fill:var(--cinna-highlight)')
        }
        const dim = state.selected !== null && state.selected !== undefined && state.selected !== it.id ? ';opacity:0.38' : ''
        const label = svgEl('text', { x: 6, y: mid, 'dominant-baseline': 'middle', class: 'cinna-row-text' }, svg, dim ? 'opacity:0.6' : '')
        label.textContent = fit(it.label, labelW - 10, 11)
        svgEl('path', { d: hbarPath(x0, x0 + (it.value / max) * span, mid - thick / 2, thick, 4) }, svg, `fill:${color(it.slot || spec.slot || 1)}${dim}`)
        svgEl('text', { x: x0 + (it.value / max) * span + 6, y: mid, 'dominant-baseline': 'middle', class: 'cinna-label-text' }, svg).textContent = format(it.value, spec.format, spec.unit)
        const hit = svgEl('rect', { x: 0, y, width: w, height: rowH }, svg, 'fill:transparent;cursor:' + (spec.onSelect ? 'pointer' : 'default'))
        if (spec.onSelect) hit.addEventListener('click', () => c.select(it.id))
      })
    })
  }
  function fit(s, px, size) {
    const max = Math.floor(px / (size * 0.58))
    return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s
  }

  // ---- donut ----------------------------------------------------------------

  function donut(el, spec) {
    return mount(el, spec, (c) => {
      const { svg, w, h, spec } = c
      const items = spec.items
      drawLegend(c.legend, items.map((it, i) => ({ label: it.label, color: color(it.slot || i + 1) })))
      const total = items.reduce((a, it) => a + it.value, 0)
      const size = Math.min(w, h)
      const cx = w / 2
      const cy = h / 2
      const ro = size / 2 - 2
      const ri = ro * 0.68
      let a0 = -Math.PI / 2
      items.forEach((it, i) => {
        const a1 = a0 + (it.value / total) * Math.PI * 2
        const p = arc(cx, cy, ro, ri, a0, a1)
        const seg = svgEl('path', { d: p }, svg, `fill:${color(it.slot || i + 1)};stroke:var(--cinna-bg);stroke-width:2;stroke-linejoin:round`)
        seg.addEventListener('pointermove', (ev) => {
          const r = svg.getBoundingClientRect()
          c.showTip(tipRows(it.label, [{ label: format(it.value, spec.format, spec.unit), value: 0, color: color(it.slot || i + 1), text: Math.round((it.value / total) * 100) + '%' }]), ev.clientX - r.left, ev.clientY - r.top)
        })
        seg.addEventListener('pointerleave', c.hideTip)
        a0 = a1
      })
      if (ri > 22) {
        svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'cinna-donut-value' }, svg).textContent = format(spec.total ?? total, spec.format, spec.unit)
        if (spec.centerLabel) svgEl('text', { x: cx, y: cy + 13, 'text-anchor': 'middle', class: 'cinna-axis-text' }, svg).textContent = spec.centerLabel
      }
    })
  }
  function arc(cx, cy, ro, ri, a0, a1) {
    const large = a1 - a0 > Math.PI ? 1 : 0
    const p = (r, a) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`
    return `M${p(ro, a0)}A${ro},${ro} 0 ${large} 1 ${p(ro, a1)}L${p(ri, a1)}A${ri},${ri} 0 ${large} 0 ${p(ri, a0)}Z`
  }

  // ---- heatmap (sequential) -------------------------------------------------

  function heatmap(el, spec) {
    return mount(el, spec, (c) => {
      const { svg, w, h, spec } = c
      drawLegend(c.legend, [])
      const rows = spec.rows
      const cols = spec.cols
      const flat = spec.values.flat()
      const max = Math.max(...flat)
      const labelW = Math.max(...rows.map((r) => textW(r, 10))) + 8
      const pb = 16
      const cw = (w - labelW) / cols.length
      const ch = (h - pb) / rows.length
      rows.forEach((rl, ri) => {
        svgEl('text', { x: labelW - 6, y: ri * ch + ch / 2, 'text-anchor': 'end', 'dominant-baseline': 'middle', class: 'cinna-axis-text' }, svg).textContent = rl
        cols.forEach((cl, ci) => {
          const v = spec.values[ri][ci]
          const t = v / max
          const fill = v === 0 ? 'var(--cinna-surface-2)' : `color-mix(in srgb, var(--cinna-seq) ${Math.round(18 + t * 82)}%, var(--cinna-bg))`
          const cell = svgEl('rect', { x: labelW + ci * cw + 1, y: ri * ch + 1, width: Math.max(1, cw - 2), height: Math.max(1, ch - 2), rx: 2 }, svg, `fill:${fill}`)
          cell.addEventListener('pointermove', (ev) => {
            const r = svg.getBoundingClientRect()
            c.showTip(tipRows(`${rl} · ${cl}`, [{ label: spec.valueLabel || 'Value', value: v, color: fill }], spec.format, spec.unit), ev.clientX - r.left, ev.clientY - r.top)
          })
          cell.addEventListener('pointerleave', c.hideTip)
        })
      })
      const every = Math.max(1, Math.ceil(((textW(cols[0], 10) + 10) * cols.length) / (w - labelW)))
      cols.forEach((cl, ci) => {
        if (ci % every) return
        svgEl('text', { x: labelW + ci * cw + cw / 2, y: h - 3, 'text-anchor': 'middle', class: 'cinna-axis-text' }, svg).textContent = cl
      })
    })
  }

  // ---- figures: sparkline, segmented bar -----------------------------------

  /** Trend in the de-emphasis ink, the current point in the accent. */
  function sparkline(el, values, opts) {
    opts = opts || {}
    el.classList.add('cinna-sparkline')
    const draw = () => {
      el.innerHTML = ''
      const w = el.clientWidth || 80
      const h = el.clientHeight || 24
      const min = Math.min(...values)
      const max = Math.max(...values)
      const x = (i) => 3 + (i / (values.length - 1)) * (w - 6)
      const y = (v) => 3 + (1 - (v - min) / (max - min || 1)) * (h - 6)
      const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' }, el)
      const d = smooth(values.map((v, i) => [x(i), y(v)]))
      svgEl('path', { d }, svg, 'fill:none;stroke:var(--cinna-muted);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round')
      const last = values.length - 1
      svgEl('circle', { cx: x(last), cy: y(values[last]), r: 2.5 }, svg, `fill:${opts.color || 'var(--cinna-accent)'}`)
    }
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    draw()
    return { destroy: () => ro.disconnect() }
  }

  /** One whole split into parts: thin, rounded, no text; the legend names the parts. */
  function segmented(el, items, opts) {
    opts = opts || {}
    el.classList.add('cinna-segmented')
    el.innerHTML = ''
    const total = items.reduce((a, it) => a + it.value, 0)
    const bar = div('cinna-segmented-bar', el)
    items.forEach((it, i) => {
      if (!it.value) return
      const part = div('cinna-segmented-part', bar)
      part.style.flexGrow = String(it.value)
      part.style.background = it.color || color(it.slot || i + 1)
      part.title = `${it.label}: ${format(it.value, opts.format, opts.unit)} (${Math.round((it.value / total) * 100)}%)`
    })
    const legend = div('cinna-legend', el)
    for (const [i, it] of items.entries()) {
      const row = div('cinna-legend-item', legend)
      const sw = document.createElement('span')
      sw.className = 'cinna-swatch'
      sw.style.background = it.color || color(it.slot || i + 1)
      row.appendChild(sw)
      row.appendChild(document.createTextNode(`${it.label} ${Math.round((it.value / total) * 100)}%`))
    }
  }

  window.CinnaCharts = { line, bar, hbar, donut, heatmap, sparkline, segmented, format, signed }
})()
