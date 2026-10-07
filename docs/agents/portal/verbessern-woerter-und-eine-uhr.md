# Verbessern: eine Uhr, der Grund eines offenen Monats und die Wörter

Stand: Verbessern-Bau v1, PR 0 bis PR 4 nach Review r1 (Konzept `data/vp-verbessern-konzept-v1`, Captain-Freigabe 06.10.2026).

## Eine Uhr (PR 0, Befund 2)

- „Heute“ ist in den Verbessern-Dialogen der Tag der Route (`abruf`), nie die Uhr des Browsers.
  In der Demo liegen beide fast drei Jahre auseinander (Route 30.04.2029, Browser heute).
- `src/routenUhr.ts` merkt sich den Tag aus jeder Verbessern-Antwort (`merkeAbruf`: Register, Seiten, `frist.abruf`, Stand eines Energieziels, Bezugsbasis-Vergleich); `routenHeute()` liest ihn, `useRoutenHeute()` holt ihn ohne gemerkten Tag einmal über `GET /verbesserung/uebersicht`.
- Ein neuer Dialog mit Datumsvorgabe nimmt `routenHeute()`, nicht `heute()` aus `bewertung.ts`; ein Einstieg ohne vorherige Verbessern-Antwort (etwa an der Kennzahl) öffnet seinen Dialog erst, wenn `useRoutenHeute()` den Tag kennt.
- Die Kennzahl-Seite (Auswerten) merkt sich `abruf` der Auffälligkeiten-Route und öffnet „Energieziel setzen“ über `useRoutenHeute()` (`EnergiezielSetzenAmTagDerRoute`); eine Reproduktion mit Browser 2026 und Route 2029 steht in `KennzahlSeite.test.tsx`.
- Browser-Bühnen: der `abruf` jeder gespielten Antwort ist der Tag der Uhr (`page.clock`).
  Ein fester `abruf` in einer Fixture (etwa `standJuli` mit 2028-07-10) verschiebt sonst Vorgaben wie den Ausgangslage-Monat.

## Offener Monat (PR 0, Befund 1)

- `offenGrund` in `energieziele.ts` bildet `bereinigt.grund` ab: `periode_nicht_zu_ende` → „läuft noch“, `keine_werte` → „kein gemessener Wert“, jeder andere Grund → der Satz der Route nach dem Gedankenstrich.
- „noch nicht endgültig“ steht nur ohne Grund; der Wächter in `copy.test.ts` hält die Konstante von jeder Fläche und von den reinen Bildern (`energiezielBild.ts`, `massnahmenBild.ts`) fern.
- Die Monate am Energieziel (`monatsPunkte`) nehmen denselben Grund; das geschätzte „endgültig etwa ab“ nur, wenn der Monat läuft (`laeuftNoch`: Grund `periode_nicht_zu_ende` oder der Monat des Abruf-Tags) - auch im Kopfsatz („Noch keine Aussage …“) und im Hinweis „Erst ein Monat …“; sonst „März 2029 ist noch offen - die Produktionsmenge fehlt.“

## Wörter (PR 4)

- Gruppenfrage „Was tun wir, um Energie zu sparen?“ (`ebenenNav.ts`, Entscheid 1).
- Klartext, Frage und Abgrenzung der Verbessern-Begriffe stehen in `begriffe.ts`; jeder Reiter zeigt seinen als `BegriffAufklapper` unter dem Antwortsatz („Was ist ein Energieziel?“, „Was ist eine Maßnahme?“ mit den Fachwörtern, „Was ist eine Abweichung?“), nie einen eigenen Nachbau; Alltagswörter („auf Kurs“, „Vorher“, „gemessen an“, „zweite Person“, „Einsparung“) in `glossar.ts`, Fachmodell über `docs/fachmodell/tools/fachmodell.py`.
- Entscheid 14: Aktionsplan, Korrekturmaßnahme, Nichtkonformität und Energieleistungsverbesserung stehen nur im Feld `fachwort` der Begriffe aus `NORMWOERTER_IM_FACHWORT`, sichtbar als letzte Zeile von „Was ist …?“ (`fachwortZeile`: „Fachwort:“ / „Fachwörter:“).
  Der Sprach-Wächter lässt genau diese Texte in `begriffe.ts` durch und sonst nirgends.
- Der Grenz-Satz steht einmal an der Seite („Was VoltPilot leistet“), nicht im Dialog: die Dialoge, Blätter und Hinweise unter Verbessern sind `VERBESSERUNG_TEILE` (Muster `BEZUGSBASIS_TEILE`) und dürfen ihn nicht tragen.
  Ihre Eltern leitet der Wächter aus den Imports ab: jede importierende Datei trägt den Satz oder ist selbst ein Teil - ein neuer Teil kommt in die Liste, eine neue Eltern-Seite braucht keinen Eintrag.
- `VerbesserungBereich` hat keinen eigenen Kopf: jeder Reiter (Energieziele, Maßnahmen, Abweichungen) trägt Titel, Satz und `GrenzHinweis` selbst; `REITER_MIT_HINWEIS` in `copy.test.ts` prüft das für K7 und AP-18.
- Die Energieziel-Seite liegt in einem `GrenzSatzBereich` mit `GrenzHinweis` am Fuß; der Hinweis auf eine offene Auffälligkeit ist PR3s `AuffaelligkeitHinweis` über `GET /api/v1/auffaelligkeiten`, kein eigener Ladeweg je Kennzahl.
- Die Länge einer Begründung („10 bis 500 Zeichen“) erscheint nur als Fehler, auch nicht als `hint=`/`hilfe=`; das Feld zeigt ein Beispiel als Platzhalter (`Begruendung`, `beispiel`).
