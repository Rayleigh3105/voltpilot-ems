# npm run build

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 001).

- **`npm run build`** = `tsc && vite build` (the type-check is the primary CI gate). **`npm test`** = `vitest run` (jsdom); `npm run test:watch` for the loop. Config in `vitest.config.ts` (separate from `vite.config.ts`); jest-dom matchers are wired in `src/test/setup.ts`.
