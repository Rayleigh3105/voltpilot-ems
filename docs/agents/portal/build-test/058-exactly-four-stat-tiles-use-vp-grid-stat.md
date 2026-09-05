# Exactly-four stat tiles use .vp-grid-stats-4

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 058).

- **Exactly-four stat tiles use `.vp-grid-stats-4`** (explicit 2x2, 4x1 at >=1200px) so the 4th tile never wraps alone and phones never stack one-per-row; the `auto-fit` `.vp-grid-stats` stays for grids with other tile counts (Historie has 6).
