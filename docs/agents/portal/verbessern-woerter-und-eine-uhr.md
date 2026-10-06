# Verbessern: eine Uhr, der Grund eines offenen Monats und die Wörter

Stand: Verbessern-Bau v1, PR 0 und PR 4 (Konzept `data/vp-verbessern-konzept-v1`, Captain-Freigabe 06.10.2026).

## Eine Uhr (PR 0, Befund 2)

- „Heute“ ist in den Verbessern-Dialogen der Tag der Route (`abruf`), nie die Uhr des Browsers.
  In der Demo liegen beide fast drei Jahre auseinander (Route 30.04.2029, Browser heute).
- `src/routenUhr.ts` merkt sich den Tag aus jeder Verbessern-Antwort (`merkeAbruf`: Register, Seiten, `frist.abruf`, Stand eines Energieziels, Bezugsbasis-Vergleich); `routenHeute()` liest ihn, `useRoutenHeute()` holt ihn ohne gemerkten Tag einmal über `GET /verbesserung/uebersicht`.
- Ein neuer Dialog mit Datumsvorgabe nimmt `routenHeute()`, nicht `heute()` aus `bewertung.ts`; ein Einstieg ohne vorherige Verbessern-Antwort (etwa an der Kennzahl) öffnet seinen Dialog erst, wenn `useRoutenHeute()` den Tag kennt.
- Browser-Bühnen: der `abruf` jeder gespielten Antwort ist der Tag der Uhr (`page.clock`).
  Ein fester `abruf` in einer Fixture (etwa `standJuli` mit 2028-07-10) verschiebt sonst Vorgaben wie den Ausgangslage-Monat.

## Offener Monat (PR 0, Befund 1)

- `offenGrund` in `energieziele.ts` bildet `bereinigt.grund` ab: `periode_nicht_zu_ende` → „läuft noch“, `keine_werte` → „kein gemessener Wert“, jeder andere Grund → der Satz der Route nach dem Gedankenstrich.
- „noch nicht endgültig“ steht nur ohne Grund; der Wächter in `copy.test.ts` hält die Konstante von jeder Fläche fern.

## Wörter (PR 4)

- Gruppenfrage „Was tun wir, um Energie zu sparen?“ (`ebenenNav.ts`, Entscheid 1).
- Klartext, Frage und Abgrenzung der Verbessern-Begriffe stehen in `begriffe.ts`; Alltagswörter („auf Kurs“, „Vorher“, „gemessen an“, „zweite Person“, „Einsparung“) in `glossar.ts`, Fachmodell über `docs/fachmodell/tools/fachmodell.py`.
- Entscheid 14: Aktionsplan, Korrekturmaßnahme, Nichtkonformität und Energieleistungsverbesserung stehen nur im Feld `fachwort` der Begriffe aus `NORMWOERTER_IM_FACHWORT`, sichtbar als letzte Zeile von „Was ist …?“ (`fachwortZeile`: „Fachwort:“ / „Fachwörter:“).
  Der Sprach-Wächter lässt genau diese Texte in `begriffe.ts` durch und sonst nirgends.
- Der Grenz-Satz steht einmal an der Seite („Was VoltPilot leistet“), nicht im Dialog: die Dialog-Dateien unter Verbessern sind `VERBESSERUNG_TEILE` (Muster `BEZUGSBASIS_TEILE`) und dürfen ihn nicht tragen; jede Eltern-Seite importiert sie und trägt ihn.
- Die Länge einer Begründung („10 bis 500 Zeichen“) erscheint nur als Fehler; das Feld zeigt ein Beispiel als Platzhalter (`Begruendung`, `beispiel`).
