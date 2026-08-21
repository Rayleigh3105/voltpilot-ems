Getippt wird der Name vom Typenschild — nicht die Marke: die Modell-SUCHE über alle Marken

**Was der Captain am 21.08. sah** (NACHTRAG Punkt 5 der Abnahme, Scout `vp-geraeteseite-rev-b8`): beide Anlege-Flächen fragen zuerst nach der **Marke** — einer Angabe, die auf keinem Typenschild in Katalog-Schreibweise steht. Dort steht `SUN-30K-SG01HP3-EU`; ob das im Katalog unter „Deye" liegt, und ob ein Fronius unter „Fronius" oder „Fronius (Modbus / SunSpec)" — das muss man WISSEN. Wer falsch riet, fand sein Gerät nicht, obwohl es im Katalog stand.

Auf `:8484` kam dazu, dass die vorhandene Suche **roh verglich**: `SUN-30K` fand sie, `sun 30k` und `sun30k` nicht. Und sie erschien überhaupt erst ab sieben Modellen EINER Marke (`SEARCH_THRESHOLD`) — also gerade dann nicht, wenn man sie am nötigsten hat.

Dieser PR macht die Suche zum **primären Weg** auf BEIDEN Flächen. Das Marken-Stufenmenü **bleibt** als Stöber-Weg darunter stehen; beide schöpfen aus derselben Liste, also kann keiner etwas finden, das der andere nicht hat.

## Reine Fläche

Kein Endpunkt, keine Migration, kein Feld. Gesucht wird in der Liste, die beide Seiten ohnehin laden (`GET /api/v1/component-templates` bzw. `GET /api/inverter`).

## Die zwei Regeln, an denen alles hängt

**⚠ Verglichen wird NORMALISIERT, hervorgehoben im ORIGINAL.** Klein, ohne Umlaute/ß, ohne `[\s\-_./]` — nur so finden `SUN-30K`, `sun 30k` und `sun30k` dasselbe Gerät. Markiert werden muss aber der Text, den der Kunde **liest**, deshalb bildet `hervorheben` die Fundstelle Zeichen für Zeichen zurück und schließt einen Trenner ein, der ZWISCHEN zwei markierten Zeichen liegt — sonst zerfiele `SUN-30K` sichtbar in zwei Treffer mit einem unmarkierten Bindestrich dazwischen.

**⚠ Die deutsche Umschrift läuft VOR der NFD-Zerlegung.** Andersherum ist das „ä" längst zerlegt und aus „Zähler" wird „zahler" — im Test genau so aufgefallen.

## Ehrlichkeit, beidseitig

- Eine **leere** Eingabe behauptet GAR NICHTS: kein Treffer, kein Zähler, kein Fehlschlag. Das Menü führt dann.
- Ohne Treffer steht der **Weg** da („sonst hilft die Marken-Auswahl darunter"), nicht nur Leere.
- Die **Kappung** bei 12 Treffern wird gesagt, nie verschwiegen.
- Der Zusatz je Zeile (Leistung · Bauart · Anbindung) beantwortet „ist das meins?" ohne Klick — **eine unbekannte Nennleistung wird WEGGELASSEN, nie als 0 kW erfunden.**
- Die Begriffe sind **UND**-verknüpft: „deye 30k" meint ein Gerät, nicht jede Deye UND jedes 30K-Gerät. Sortiert wird Modell-Anfang vor Modell-Vorkommen vor Marken-Treffer — wer „SG04" tippt, meint das Modell.

## Portal

Das Suchfeld steht über den zwei Auswahlfeldern; ein Treffer ruft **dieselbe** `waehleTemplate`, die auch das Menü ruft (kein zweiter Auswahl-Pfad), und nimmt die **Marke mit** — sonst stünde der Rückweg über das Stufenmenü bei der Marke davor.

## `:8484`

Die reine Hälfte ist das neue `static/modellsuche.js` (`window.VPModellSuche`, das `VPControl`/`VPStatus`-Muster); `inverter.js` zeichnet nur. Sie sucht über **alle** Marken und gruppiert nach Marke.

**⚠ Ein Treffer einer anderen Marke stellt erst die MARKE um, dann das Modell** (`waehleUeberMarken`): die Marke entscheidet Anbindung und Verbindungsfelder — ohne den ersten Schritt stünde unter dem gewählten Modell das Formular der vorigen Marke.

`SEARCH_THRESHOLD` ist **ersatzlos** entfallen.

**⚠ Es gibt bewusst ZWEI Umsetzungen** (TS/Vorlagen-Register und Browser-IIFE/Go-Katalog): verschiedene Laufzeiten, verschiedene Katalog-Formen, aber dieselben Regeln — der Kunde tippt auf beiden Seiten denselben Namen. **Wer die Regeln ändert, ändert beide;** die Vektoren stehen je Seite im Test.

## Beweise

- Portal `komponentenAssistentSuche.test.ts` (13) + `KomponenteHinzufuegenDrawer.test.tsx` (+5). **Mutationsgeprüft:** nimmt man die Normalisierung heraus, fallen auf beiden Ebenen genau die Toleranz-Fälle.
- Edge `jstest/ui.test.js` (+9, 114 gesamt grün) + `web_test.go`: die ausgelieferte `modellsuche.js` UND ihr Skript-Tag sind gepinnt — ohne das Tag wäre der Picker **still** kaputt (`window.VPModellSuche` fehlte). Ebenfalls mutationsgeprüft.
- Portal 4012 Tests / `tsc` / `npm run build` grün; `go build ./...` + `go test ./internal/web/` grün.
- **Im echten Chrome bei 1440 und 375 auf BEIDEN Flächen durchgespielt:** `sun30k` → 1 Treffer mit hervorgehobenem `SUN-30K`; `eco 27` findet über die Markengrenze den Fronius-SunSpec-Eintrag; `huawei` nennt den Weg. 0 px horizontaler Überlauf, 0 überstehende Elemente, keine Konsolenmeldungen.

## Nicht in diesem PR

Der Vorlagen-Katalog selbst (Marken/Modelle) ist unangetastet — die Suche findet, was da ist.
