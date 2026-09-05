# ⚠ Die Test-Umgebung leert sessionStorage vor jedem Test

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2, Punkt 020).

- **⚠ Die Test-Umgebung leert `sessionStorage` vor jedem Test** (`src/test/setup.ts`). jsdom teilt ihn über alle Tests EINER Datei, also veränderte der Umschalt-Klick des einen Tests den Grundzustand des nächsten — genau so beim Bau der Detailtiefe aufgefallen. Ein Test, der einen Zustand ABSICHTLICH vorbelegt, setzt ihn in seinem eigenen `beforeEach`/Körper (der läuft danach).
