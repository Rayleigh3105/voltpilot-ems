# Button/Card affordance is CSS, not inline JS.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 004).

- **Button/Card affordance is CSS, not inline JS.** `designsystem/components/core/core.css` owns `.vp-btn*` / `.vp-card*` with real `:hover` / `:active` / `:focus-visible`, so touch + keyboard get feedback (the old `onMouseEnter/Leave` handlers are gone). `core.css` is imported once in `src/main.tsx` after the tokens.
  Keyboard focus rings for non-Button chrome (nav, seg tabs, steppers, links, clickable rows) live in `src/index.css` via `--vp-focus-ring-color`.
