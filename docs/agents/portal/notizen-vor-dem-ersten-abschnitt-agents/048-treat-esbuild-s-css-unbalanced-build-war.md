# Treat esbuild's CSS "unbalanced {" build warning as a hard error.

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 1, Punkt 048).

- **Treat esbuild's CSS "unbalanced {" build warning as a hard error.** An unclosed brace mid-`index.css` silently swallows EVERY later rule (the `.vp-modul-auto-row > svg` case ate the whole Ersparnis-Simulation block + anything appended after it); the build stays green, only the warning tells you.

