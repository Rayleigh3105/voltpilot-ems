# Verbrauchsmanagement v1 · P5: die Ladepark-KAPSEL ist entfallen, der RAHMEN steht

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 33).


Portal-Hälfte des größten Pakets (Regeln, Verträge und die Edge-Trennung: root
`AGENTS.md` „Verbrauchsmanagement v1 — Paket 5").

- **⚠ `components/LadeparkKapsel.tsx` ist ERSATZLOS entfallen — und das ist die Aussage.**
  Ihre zwei Radio-Gruppen haben bessere Wohnorte bekommen: die QUELLEN-Wahl ist seit
  P2/P5 der Anlagen-Standard bzw. die Steuerart JE SÄULE (die ein anlagenweiter Radio nie
  ausdrücken konnte), der SPEICHER-VORRANG ist seit P4 die Rangliste (die zusätzlich die
  übrigen Verbraucher einordnet). Sie stehen zu lassen wären zwei Bedienelemente für
  dieselbe Tatsache — genau die Doppeldeutigkeit, gegen die das Programm gebaut ist.
- **Nachfolgerin ist `components/LadeparkRahmenKarte.tsx`** über der reinen
  `src/ladeparkRahmen.ts`: die Anschlussgrenze (die EINE Zahl, die dem Kunden gehört, mit
  ihrer unveränderten Rückfrage) plus die Rahmen-Werte zum LESEN. Der Betreiber-Editor
  liegt hinter dem EINEN Tor `rollen.showTechnicalLayer()` — nie eine zweite Fläche.
- **⚠ ZWEI QUELLEN je Zeile, und ihr Unterschied wird GESAGT:** das IST (der Budget-Block
  der Box, aus `GET /verbraucher`) gewinnt; wo nur ein SOLL vorliegt
  (`ChargingConfig.frame`), trägt die Zeile ausdrücklich „hinterlegt, von Ihrer Box noch
  nicht gemeldet". Liegt weder noch vor, steht `NICHT_GEMELDET` — nie eine 0.
- **⚠ Die ROTATION meldet die Box nicht** und steht deshalb NUR als Soll. Eine erfundene
  „alle 15 Minuten" wäre schlimmer als keine Zeile.
- **⚠ Im Betreiber-Editor ist ein LEERES Feld „nichts sagen", nicht „auf 0 setzen"** — es
  wird gar nicht erst gesendet, damit ein versehentlich geleertes Feld nie eine gepflegte
  Zahl löscht (die PATCH-Regel des retained Dokuments, in der Fläche gespiegelt).
- **`SteuerartHerkunft` kennt seit P5 `saeule`** — „diese Säule trägt eine EIGENE
  Quellen-Bahn", ausdrücklich nicht den Anlagen-Standard. Die Chip-Logik keyt weiterhin
  allein auf `!== 'standard'` ⇒ „abweichend", also rendert jede künftige Herkunft
  automatisch richtig, statt still als „Standard" zu lesen.
- **Die Modus-Frage am Ladepunkt** (`fragen(quelle, ladepunkt)` → `'ueberschussModus'`)
  ist die §3.2-Folgefrage, die P2 noch nicht anbieten konnte: sie beschreibt die BAHN der
  Box, und die Policy-Sprache kann ein „entweder/oder" nicht ausdrücken. **⚠ `ladepunkt`
  ist OPTIONAL und per Vorgabe `false`** — jeder bestehende Aufrufer bekommt Zeichen für
  Zeichen dieselbe Fragenliste wie vor P5. Das kW-Feld erscheint NUR bei „Mindestleistung
  halten", und der Boden reist nur dann mit: bei „pausieren" wäre er eine Zahl ohne
  Wirkung, die der Server als `sonne_zuerst` missverstehen könnte.
- Beweise: `ladeparkRahmen.test.ts` (14) · `steuerartDialog.test.ts` (+5: die Frage gibt
  es NUR am Ladepunkt, jede andere Quelle bleibt unverändert, der Boden reist nur wenn
  gemeint, die Vorgabe ist `pausieren`).

