# Dense table-row actions use src/components/RowMenu.tsx

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 006).

- **Dense table-row actions use `src/components/RowMenu.tsx`** (⋯ overflow popover; destructive items separated), not a row of side-by-side buttons. Its popover renders into `document.body` at fixed coords from the button's `getBoundingClientRect()` (viewport-clamped, flips up when no room below) - the same escape-the-clip pattern `InfoTip` uses. This is load-bearing: the host tables sit in `Card` with `overflow: hidden` (rounds the corners), so an `absolute` popover was clipped and the last/only row's actions (incl. destructive "Löschen") were unclickable. Any new in-card popover/menu must portal to body, not rely on `position: absolute`.
