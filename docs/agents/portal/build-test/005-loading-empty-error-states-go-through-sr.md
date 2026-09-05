# Loading/empty/error states go through src/components/States.tsx

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 005).

- **Loading/empty/error states go through `src/components/States.tsx`** (`Skeleton`, `TextSkeleton`, `ChartCardSkeleton`, `TableSkeleton`, `ErrorState` with retry, `EmptyState`). Never ship bare `<p>Lade …</p>`; data pages show a shaped skeleton while loading and a distinct `ErrorState` (with a retry that bumps a `reloadKey`) on failure.
