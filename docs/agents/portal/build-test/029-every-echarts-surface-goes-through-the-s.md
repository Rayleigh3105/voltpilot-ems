# Every ECharts surface goes through the shared useEChart(render, deps) hook (src/useEChart.ts), never a hand-rolled init/

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 029).

- **Every ECharts surface goes through the shared `useEChart(render, deps)` hook (`src/useEChart.ts`), never a hand-rolled init/resize/dispose.**
  It observes the CONTAINER with a ResizeObserver (not just window resize - sidebar collapse and grid reflow resize charts without a window event), calls `chart.resize()` and re-runs `render(chart, width)` at the new width.
  Use the `width` param for width-aware layout: every chart derives `narrow = width < 480` (Weather: 520) and then shortens axis names ("Leistung (kW)" -> "kW"), trims grid margins, or drops secondary y-axes.
  Conventions that keep phones clean, learned in real 375px browser testing: tooltips always set `confine: true` (never overflow the viewport, works for touch-tap tooltips); x-axis labels always set `hideOverlap: true`; do NOT use `alignMinLabel`/`alignMaxLabel` or padded label strings on CATEGORY axes - both degrade the auto-interval badly (charts collapse to 1-2 labels); for hourly week buckets on narrow widths, label only each day's FIRST bucket (weekday short, else `''`) with `interval: 0` + `axisTick: {show: false}` - the auto interval would repeat weekdays ("Mo Mo Di ...") and full "Mi 06:00" labels clip at the canvas edge (see `HistoryChart`/`PriceHistoryChart` `weekNarrow`).
