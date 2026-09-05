# Test files (src/

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 002).

- **Test files (`src/**/*.test.ts{,x}`) are EXCLUDED from the `tsc` build** (`tsconfig.json` `exclude`) so the production build stays decoupled from the test types; vitest type-checks them via its own esbuild transform. Prefer **pure, unit-tested logic modules** (e.g. `src/live.ts`) with thin render-only components - the pure module carries the exhaustive state coverage, the component test just asserts it renders. Component tests use `@testing-library/react`.

