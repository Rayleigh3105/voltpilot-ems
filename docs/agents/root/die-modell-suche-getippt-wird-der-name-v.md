# Die MODELL-SUCHE: getippt wird der Name vom Typenschild, nicht die Marke

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 22).


Geräteseiten Stufe 2 (Scout `data/vp-geraeteseite-rev-b8` NACHTRAG 5, Captain-Punkt 3 der Abnahme
21.08.2026). Sie gilt für BEIDE Anlege-Flächen — den Portal-Assistenten und die `:8484`-Einrichtung
—, und in beiden ist sie der PRIMÄRE Weg: das Marken-Stufenmenü bleibt daneben als Stöber-Weg
stehen. **Reine Fläche: kein Endpunkt, keine Migration, kein Feld** — gesucht wird in der Liste, die
beide Seiten ohnehin laden (`GET /api/v1/component-templates` bzw. `GET /api/inverter`).

- **Der behobene Befund ist die REIHENFOLGE der Fragen.** Beide Flächen fragten zuerst nach der
  MARKE — eine Angabe, die auf keinem Typenschild in Katalog-Schreibweise steht (dort steht
  „SUN-30K-SG01HP3-EU", nicht „Deye"), und die auf der `:8484`-Seite zusätzlich als
  Katalog-Bezeichnung geraten werden musste („Fronius" oder „Fronius (Modbus / SunSpec)"?). Wer die
  Marke falsch riet, fand sein Gerät nicht — obwohl es im Katalog stand.
- **⚠ Verglichen wird NORMALISIERT, hervorgehoben im ORIGINAL.** Klein, ohne Umlaute/ß, ohne
  `[\s\-_./]`, damit „SUN-30K", „sun 30k" und „sun30k" dasselbe Gerät finden; markiert wird der
  Text, den der Kunde LIEST, also bildet die Hervorhebung die Fundstelle Zeichen für Zeichen zurück
  und schließt einen Trenner ein, der ZWISCHEN zwei markierten Zeichen liegt (sonst zerfiele
  „SUN-30K" sichtbar in zwei Treffer). Der frühere `:8484`-Filter verglich ROH und fand genau die
  drei Schreibweisen nicht.
- **⚠ Es gibt ZWEI Umsetzungen, und das ist Absicht** — `frontend/portal/src/komponentenAssistent.ts`
  (TS, Vorlagen-Register) und `edge-app/core/internal/web/static/modellsuche.js` (Browser-IIFE,
  Go-Katalog). Sie teilen KEINEN Code (verschiedene Laufzeiten, verschiedene Katalog-Formen), aber
  dieselben REGELN — der Kunde tippt auf beiden Seiten denselben Namen. **Wer die Regeln ändert,
  ändert beide;** die Vektoren stehen je Seite im Test (`komponentenAssistentSuche.test.ts` ·
  `edge-app/core/internal/web/jstest/ui.test.js`).
- **Drei Ehrlichkeitsregeln, beidseitig:** eine LEERE Eingabe behauptet GAR NICHTS (kein Treffer,
  kein Zähler, kein Fehlschlag — das Stufenmenü führt dann); ohne Treffer steht der WEG da statt
  nur Leere; und eine Kappung (12 Treffer) wird GESAGT, nie verschwiegen. Der Zusatz je Zeile
  (Leistung · Bauart · Anbindung) beantwortet „ist das meins?" ohne Klick — **eine unbekannte
  Nennleistung wird WEGGELASSEN, nie als 0 kW erfunden.**
- **Auf `:8484` sucht sie über ALLE Marken** und gruppiert nach Marke; ein Treffer einer anderen
  Marke stellt erst die MARKE um (sie entscheidet Anbindung und Verbindungsfelder), dann das Modell
  — ohne den ersten Schritt stünde unter dem gewählten Modell das Formular der vorigen Marke. Der
  frühere `SEARCH_THRESHOLD` (Suchzeile erst ab 7 Modellen EINER Marke) ist ersatzlos entfallen: die
  Suche ist der primäre Weg, nicht die Hilfe für lange Listen. **`static/*` ist `//go:embed`-t — nach
  einer Änderung das Core-Binär neu bauen** (`go test ./internal/web` bettet neu ein).
- **Beweise:** Portal `komponentenAssistentSuche.test.ts` (13) + `AnlegenFlow.test.tsx`
  (+5, mutationsgeprüft: ohne die Normalisierung fällt der Tolerenz-Fall) · Edge
  `jstest/ui.test.js` (+9) + `web_test.go` (die ausgelieferte `modellsuche.js` und ihr Skript-Tag
  sind gepinnt — ohne das Tag wäre der Picker still kaputt; mutationsgeprüft). Im echten Chrome bei
  1440 und 375 auf beiden Flächen durchgespielt: 0 px horizontaler Überlauf, 0 überstehende
  Elemente.

