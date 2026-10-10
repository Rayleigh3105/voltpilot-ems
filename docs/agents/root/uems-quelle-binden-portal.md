# UEMS „Quelle binden“ und die Quelle-Karte: beide Werte nebeneinander

Neu am 16.09.2026 (AP-04 IP-14, Mockups D3 · V1 · R2, Kasten **E3**, Abnahmefall **A8**).
`frontend/portal/src/quelleBinden.ts` entscheidet (rein), `components/QuelleBindenDialog.tsx` und
`components/QuelleKarte.tsx` rendern. Beweis: `quelleBinden.test.ts` (Regel 7 als TABELLE — je Fall
eine Zeile, passend oder nicht, mit Grund), `components/QuelleBinden.test.tsx` (beide Werte
nebeneinander, Historie mit Lücke, die Auswahl mit Gründen), `e2e/quelle-binden.spec.ts`
(375 und 1440 px, 0 px Querlauf; Bilder mit `QUELLE_BILDER=<Ordner>`), `copy.test.ts` (Kundenwörter).
Fixtures: `src/test/quelleBindenFixtures.ts` (nur Ahrenberg).

## Die Fläche

- **Quelle-Karte** auf der Messstellen-Seite, ÜBER den Zuordnungs-Karten: je Messgröße die führende
  Quelle und jede Vergleichsquelle als Kacheln in EINEM Raster (`.vp-qk-werte`,
  `auto-fit, minmax(9rem, 1fr)`) — bei 375 px also NEBENEINANDER, mit Wert, Stand, Zeitraum und dem
  Anteil-Satz. Darunter die Historie der FÜHRENDEN Quellen; eine Lücke ist eine eigene Zeile
  (`is-luecke`) und bleibt sichtbar.
- **Dialog, zwei Einstiege, eine Regel:** `{art:'messstelle'}` von der Messstellen-Seite (Zielgröße
  steht fest, Komponente und Messwert werden gewählt) und `{art:'messwert'}` von der Geräteseite
  („Als Messstelle verwenden“ an einem Messwert ohne führende Bindung — der Messwert steht fest, die
  Messstellen-Größe wird gewählt). `rolle: 'fuehrend' | 'vergleich'`; eine Vergleichsquelle gibt es
  nie ohne Zweck (E3).

## ⚠ Die Fallen

- **Ausgegraut MIT GRUND ist der Kern.** Was nicht passt, verschwindet NIE aus der Liste: es steht
  grau da und sagt warum (`messstelleDialog.passtNichtSatz`, FEHLER-Tabelle §5.12). Gilt in BEIDE
  Richtungen — auch die Messstellen-Größen, die einen Messwert nicht nehmen können.
- **EINE Regel-Stelle:** `messstelleDialog.messwertZeilen` urteilt, und zwar ausschließlich über
  `uemsMessstelle.passung` (Vertrags-Zwilling zu `MessstelleRegeln`). `kanalOptionen` (IP-6) ruft
  dieselbe Funktion — mit `anteil: false`, denn der Messstellen-Dialog kennt den Anteil nicht.
- **Der Anteil wird ABGELEITET, nie gewählt.** Ein Vorzeichen-Wert (Katalogwort `import_export`) hat
  keine eine Richtung; welchen Teil er liefert, folgt aus der Richtung der ZIELGRÖSSE
  (`ANTEIL_RICHTUNGEN`, AP-08 IP-7 E15). Ohne Anteil bleibt der Grund `richtung`.
- **`letzter_wert` trägt nur, was JETZT gilt.** `GET …/quellen` füllt ihn nur an einer Bindung, die
  zum Stichtag gilt — ein alter Wert neben einem laufenden sähe aus wie ein zweiter Zustand. `null`
  heißt „nichts bekannt“, nie eine 0. Gebildet wird er von `MessstelleBeobachtung.letzterWert`,
  DERSELBEN Stelle wie der letzte Wert des Registers (Einheit des Messkanals ohne Umrechnung,
  Anteil-Schnitt) — sonst stünden zwei verschieden gerechnete Zahlen nebeneinander.
- **E3: hier wird nichts bewertet.** Kein Prozentwert, keine Abweichung, keine Ampel, kein stiller
  Ersatz. `copy.test.ts` wacht darüber; die Bewertung gehört AP-08 und beginnt an dieser Kennzeichnung.
- **Der Dialog zeigt nur die Komponenten der EIGENEN Anlage** (`anlageId` aus der elektrischen
  Stellung am Stichtag). Ohne Stellung bleiben alle offen — geraten wird nichts.
- **Kundenwörter am Messwert:** der Vorspann des Dialogs baut seine Zeile über
  `geraetEinstellungen.kanalZeile`, nie aus `kanal.wertart` (das wäre `counter`).
- **`speist` trägt seit IP-14 `anteil`** (`MesskanalDto.Speist`, additiv): erst damit graut die
  Auswahl richtig aus — EIN Vorzeichen-Kanal führt den Bezug der einen und die Abgabe der anderen
  Messstelle, und nur derselbe Teil zweimal führend ist verboten.

## Offen

- Der Messstellen-Dialog (IP-6, Schritt 3) bietet Vorzeichen-Werte weiterhin NICHT an: er ruft
  `messwertZeilen` ohne `anteil` und schickt kein `anteil`. Wer das ändert, muss `quellePruefen`
  mitziehen — sonst antwortet die Route 422.
- Eine laufende führende Quelle zu ERSETZEN ist ein Zählerwechsel (IP-18), kein Binden: die Karte
  bietet „Quelle binden“ nur, wo keine läuft.
