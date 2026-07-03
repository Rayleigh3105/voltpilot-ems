# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Design-system foundation (premium bar)

- **Interactive ink = one token: `--vp-action` (`#2F6BD6`, in `designsystem/tokens/colors.css`).**
  It is the single deep blue that passes WCAG AA both white-on-fill and text-on-white, used by the primary Button, links (`--vp-link`) and Stat/KPI ink fallback.
  The pale cornflower `--vp-primary` (#95B9FF) stays for DECORATIVE fills only (gradients, IconTiles, accent bars, tints) - contrast does not bind decoration.
  Retuning the brand action shade = change that ONE value; do not scatter new interactive blues.
- **Button/Card affordance is CSS, not inline JS.** `designsystem/components/core/core.css` owns `.vp-btn*` / `.vp-card*` with real `:hover` / `:active` / `:focus-visible`, so touch + keyboard get feedback (the old `onMouseEnter/Leave` handlers are gone). `core.css` is imported once in `src/main.tsx` after the tokens.
  Keyboard focus rings for non-Button chrome (nav, seg tabs, steppers, links, clickable rows) live in `src/index.css` via `--vp-focus-ring-color`.
- **Loading/empty/error states go through `src/components/States.tsx`** (`Skeleton`, `TextSkeleton`, `ChartCardSkeleton`, `TableSkeleton`, `ErrorState` with retry, `EmptyState`). Never ship bare `<p>Lade …</p>`; data pages show a shaped skeleton while loading and a distinct `ErrorState` (with a retry that bumps a `reloadKey`) on failure.
- **Dense table-row actions use `src/components/RowMenu.tsx`** (⋯ overflow popover; destructive items separated), not a row of side-by-side buttons.
- Two non-existent token names silently fall back to hard-coded hex: use `--vp-border`/`--vp-primary` (NOT `--vp-color-border`/`--vp-color-primary`) and `--vp-radius-md` (NOT `--vp-radius-card`). Grep `--vp-color-`/`--vp-radius-card` before shipping.
