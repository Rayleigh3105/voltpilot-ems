# useSimulationJob's poll effect deliberately depends on status

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 1, Punkt 047).

- **`useSimulationJob`'s poll effect deliberately depends on `status`** (first-run race fix): the effect first fires when `busy` flips - BEFORE the start POST resolved and set `jobRef` (a ref, not state) - and with a memoized jobApi it would otherwise never re-arm; `start()` sets the first status right after `jobRef`, which re-runs the effect once the job id exists. Don't "clean up" that dependency.
