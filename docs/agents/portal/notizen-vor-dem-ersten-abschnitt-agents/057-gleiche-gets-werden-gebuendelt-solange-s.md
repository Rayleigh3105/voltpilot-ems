# Gleiche GETs werden gebündelt, solange sie unterwegs sind (api.ts request).

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 1, Punkt 057).

- **Gleiche GETs werden gebündelt, solange sie unterwegs sind (`api.ts` `request`).** Gemessen waren **8 von 21** anlagenbezogenen Anfragen des Cockpits exakte Doppel - `/profile` DREIMAL, `/entities`/`/flows`/`/profiles`/`/history` je zweimal. Sie entstehen STRUKTURELL, nicht durch einen Fehler: die Schale (`App.tsx`) und die Anlagen-Seite lesen beide dasselbe Lese-Modell (`useAnlageSurface`), und `useAdaptiveLive` braucht dasselbe Profil noch einmal. Drei Grenzen sind tragend und dürfen nicht aufgeweicht werden: **nur GET** (eine Mutation darf nie geteilt werden), **nur solange unterwegs** (kein Ergebnis-Zwischenspeicher - der Takt muss wirklich neu holen) und der Schlüssel trägt den **Mandanten-Umschalter** (sonst bekäme ein umschaltender Admin die Antwort des vorherigen Mandanten). Beweis: `apiCoalesce.test.ts`.
  - Dazu entfällt der Tages-Abruf, wenn der gewählte Zeitraum „Heute" IST (`dayIsRange` in `AnlagenPage`): er fragte zeichengleich dasselbe wie der Zeitraum-Abruf, samt zweitem Takt.

