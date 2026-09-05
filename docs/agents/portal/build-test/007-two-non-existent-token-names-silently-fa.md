# Two non-existent token names silently fall back to hard-coded hex: use --vp-border/--vp-primary (NOT --vp-color-border/

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 007).

- Two non-existent token names silently fall back to hard-coded hex: use `--vp-border`/`--vp-primary` (NOT `--vp-color-border`/`--vp-color-primary`) and `--vp-radius-md` (NOT `--vp-radius-card`). Grep `--vp-color-`/`--vp-radius-card` before shipping.
