# Bezugsbasis: fester Maßstab, bereinigter Vergleich, Urteil nur mit Bedingung (UEMS AP-17)

Stand 23.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap17-fundament` §4.1–4.9, §5.8, §7 R1–R13, §8 IP-2; Entscheide
E1–E8 und E10–E12 = A, E9 = C, W1–W15 übernommen (23.09.2026).

Die Abnahme des Captains: **„Ein Rückgang der Produktion wird nicht automatisch als Effizienzverbesserung bewertet.“** —
Dezember 2027 bei Spritzguss: Produktion −21,9 % zum Vormonat, Strom −8,8 %. Roh trägt das **kein Urteil**; gegen die
Bezugsbasis BB-0001 Fassung 2 (10 523 kWh + 0,2343 kWh je kg) werden bei 250 000 kg 69 098 kWh erwartet, gemessen sind
78 000 kWh: **12,9 % mehr — schlechter**.

| Datei | Rolle |
|---|---|
| [`bezugsbasis.schema.json`](./bezugsbasis.schema.json) | die Form der Vektor-Datei (geschlossen, Dezimaltexte statt Gleitkomma) |
| [`bezugsbasis-vectors.json`](./bezugsbasis-vectors.json) | 45 Fälle je Regel mit Handrechnung (`rechnung`), Startwerte, Vokabulare |
| [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) 1.8 | `bezugsbasen[]` BB-0001 … BB-0005, `leistungsvergleiche[]`, `abnahmefaelle_ap17` — die Fassungen der Vektoren sind wörtlich diese |
| `services/api/.../uems/BezugsbasisRegeln.java` | der Java-Zwilling (rein) |
| `frontend/portal/src/bezugsbasis.ts` | der TS-Zwilling (rein) |
| `services/optimization/voltpilot_optimization/bezugsbasis.py` | die Python-Referenz — die bereinigte Rechnung aus `k_faelle.py` |

> **Wer anruft:** noch niemand. Tabellen, Freigabe und Routen (IP-5 ff.), Lesemodell `BezugsbasisVergleich` und die Fläche
> (IP-9 ff.), der Leistungsvergleich als Bericht (IP-19 ff.) rufen diese Regeln an. Keine Migration, keine Route, keine Fläche.

## 1. Das Objekt (B1–B4)

Eine **Bezugsbasis** `BB-0001` (Format wie `KZ-…`) gehört zu genau einer Kennzahl und übernimmt deren Geltung. Die Kennzahl
bleibt unverändert — keine Spalte, kein Wert, keine Fassung an `kennzahl*`. Je Kennzahl höchstens eine laufende Bezugsbasis;
beendet, nie gelöscht. Getragen werden nur `quotient`-Kennzahlen mit einer Energie-Menge im Zähler; eine
`zusammenfassung` nur mit der Methode Verhältnis (Σ ÷ Σ der Paare); ein `anteil` nie. Eine Kennzahl mit freigegebener
Bezugsbasis heißt **Energieleistungskennzahl** — das Wort steht an der Kennzahl, nicht in ihr.

Die Bezugsbasis besteht aus **Fassungen**. Eine Fassung = Referenzperiode × Methode × Variablen × statische Faktoren ×
Toleranz × Wiedervorlage × eingefrorene Grundlage × Freigabe. Fassung n + 1 beendet Fassung n am Vortag ihres `gilt_ab`
und nennt einen oder mehrere Anpassungsgründe (Vokabular `anpassungsgrund`; `sonstiger` nur mit Wortlaut).

## 2. Referenzperiode (P1–P4, E2)

- **P1** Ein fester Zeitraum ganzer, abgeschlossener Kalendermonate `JJJJ-MM/JJJJ-MM` (Format der Datengrundlage), nie
  rollierend; gerechnet auf den Monatswerten der Kennzahl. Operation `referenzperiode`: `referenzperiode_format`,
  `referenzperiode_reihenfolge` (Ende vor Anfang), `periode_nicht_zu_ende` (der laufende Monat ist nie Teil davon).
- **P2** Mindestlänge **12 Monate** (Startwert, `startwerte.mindest_monate`). Darunter ist die Fassung `vorlaeufig` —
  freigebbar, und jede Zahl daraus trägt „Bezugsbasis vorläufig (n von 12 Monaten)“.
- **P4** Eine Periode liest die Fassung ihres LETZTEN Tags; ohne gültige Fassung `nicht_anwendbar` mit `basis_fehlt` oder
  `basis_beendet`.

## 3. Variablen und statische Faktoren (V1–V5, E3, E6)

- Eine **Variable** ist eine Bezugsgröße mit Periodenwerten oder Kanal; **Variable 1 ist der Nenner der Kennzahl**.
  Höchstens **zwei** Variablen je Fassung.
- Zwei Variablen müssen unabhängig sein: **|r| < 0,9** (Startwert). Geprüft wird ohne Wurzel als `Sxy² ≥ 0,81 · Sxx · Syy`;
  bei Abhängigkeit wird die zweite mit `variablen_abhaengig` abgelehnt (G4) und die Fassung rechnet mit einer Variablen.
- Ein **statischer Faktor** (Vokabular `faktor_art`) ist ein Verweis mit dem Wert zum Freigabetag **als Kopie** in einer
  Liste; ein Stammdatum-Nenner (Bezugsfläche) ist beim Verhältnis erlaubt, für ein Modell aber Faktor, nie Variable.

## 4. Methoden (E4, M1–M6)

| Methode | Kundenwort | Rechnung | Kennzeichen an jeder Zahl |
|---|---|---|---|
| `verhaeltnis` | Verhältnis | Basiswert = **Σ Zähler ÷ Σ Nenner** der Referenzperiode, nie ein Mittel; erwartet = Basiswert × Variable 1 | „bereinigt um {Variable} (Bezugsbasis BB-…, Fassung n)“; über Gradtage zusätzlich „ohne Grundlast“ |
| `regression_eine_variable` | Modell mit einer Einflussgröße | erwartet = a + b × x; kleinste Quadrate: b = Sxy ÷ Sxx, a = ȳ − b · x̄ | „bereinigt um {Variable} (Modell mit einer Einflussgröße, Bezugsbasis BB-…, Fassung n; Streuung ± x %)“ |
| `regression_zwei_variablen` | Modell mit zwei Einflussgrößen | erwartet = a + b × x₁ + c × x₂; b = (S₁y·S₂₂ − S₂y·S₁₂) ÷ det, c = (S₂y·S₁₁ − S₁y·S₁₂) ÷ det, det = S₁₁·S₂₂ − S₁₂² | „bereinigt um {V1} und {V2} (Modell mit zwei Einflussgrößen, …; Streuung ± x %)“ |
| `gradtage` | Wetterbereinigung über Gradtage | wie ein Modell mit einer Einflussgröße über die Gradtagzahl (G20/15, VDI 3807); a = witterungsunabhängiger Anteil | „bereinigt um Gradtage (G20/15, Bezugsbasis BB-…, Fassung n)“ und „Streuung ± x %“ |

- **Güte (M2):** R² = 1 − SSres ÷ SStot; **Streuung** = √(SSres ÷ (n − k − 1)) ÷ ȳ × 100 (k = Zahl der Variablen), in %
  des Mittels; **Spannweite** je Variable = [min, max], **toleriert** = [min × 0,9, max × 1,1] (Startwert ± 10 %).
- **Mindestumfang (G1):** ein Modell braucht 12 Monate mit Zähler und Variable(n), sonst `zu_wenig_perioden`. Eine
  Variable ohne Streuung (Sxx = 0, etwa zwölf Sommermonate ohne Heizgradtage) trägt keine Steigung und ist ebenfalls
  `zu_wenig_perioden`. Das Verhältnis rechnet ab einem Monat und ist darunter `vorlaeufig`.
- **Eingefroren (M4):** Basiswert und Koeffizienten einer Fassung sind Teil der Grundlage und werden nie nachgerechnet;
  `erwartet` rechnet immer mit der **eingefrorenen Kopie**, egal wie viele Stellen sie trägt.

## 5. Rechnen und Runden (M5)

- Alle drei Zwillinge rechnen mit **exakten Brüchen** aus Dezimaltexten — kein `double`, kein `float`, kein `number`.
  Wurzeln (Streuung, r) werden exakt über die ganzzahlige Wurzel gerundet: ⌊(⌊√⌊4 · x · 10^2k⌋⌋ + 1) ÷ 2⌋.
- Gerundet wird **nur die Ausgabe, kaufmännisch: ,5 vom Nullpunkt weg** (`BigDecimal.HALF_UP`). Das ist weder
  `Math.round` in Java und JS (−2,05 → −2,0; −81 984,5 → −81 984) noch Pythons `round` (81 984,5 → 81 984). Die Vektoren
  „M5 …“ legen es fest: 81 984,5 → 81 985, 2,05 → 2,1, −2,05 → −2,1, −0,04 → 0,0 (nie „−0,0“).
- Stellen: **Basiswert und Koeffizienten 4** Nachkommastellen (ohne Nullen am Ende), **R² und r 3**, **Prozent 1**
  (Δ, Band, Streuung — mit fester Stelle, `2.0`). `erwartet` und Summen sind exakte Dezimalbrüche ohne Rundung
  (81 984,5), die Anzeige rundet sie auf ganze Einheiten.
- **Nie auf eine Schwelle oder ein Band gerundet:** Band, Spannweite und Abhängigkeit werden per Kreuzprodukt auf den
  ungerundeten Zahlen geprüft. Δ = 2,04 % zeigt „2,0“ und ist trotzdem `schlechter` (Band 2,0); genau 2,00 % ist `im_rahmen`.
- Die Referenzdatei 1.8 trägt die Koeffizienten des Konzepts auf **weniger** Stellen (BB-0001: a = 10 523, b = 0,2343;
  BB-0004: a = 119, b = 3,8). Die Rechnung aus den Reihen liefert 10 522,6206 / 0,2343 und 118,9104 / 3,8041 — auf die
  Stellen der Datei gerundet dieselben Zahlen (Python-Test `test_modell_rechnet_die_referenzdatei_auf_ihre_stellen_nach`).
  Die Vergleichsvektoren rechnen mit der Kopie der Datei; so entstehen 69 098 kWh und −0,7 % wie im Konzept.

## 6. Freigabe und Grundlage (E5, F1–F5)

Eine Fassung entsteht als Entwurf mit Vorschau und wird von einer Person mit Recht `bezugsbasis.freigeben` mit Begründung
freigegeben (`freigabe_status`: `beantragt · freigegeben · abgelehnt`; Vier-Augen nach Einstellung des Unternehmens). Die
**Grundlage** ist eine Kopie — jeder Zähler- und Nennerwert mit Version bzw. Fassung, die Kennzahl-Fassung, die Faktoren
mit Wert, Basiswert oder Koeffizienten, Güte, Spannweite — mit **Prüfsumme** `sha256:` über den kanonischen Text: Schlüssel
sortiert, keine Leerzeichen, Zahlen als Dezimaltext ohne Nullen am Ende (`2.0` → `2`, dieselbe Kanonisierung wie die Prüfsummen von `bezugsbasen[]` in der
Referenzdatei 1.8, `UemsReferenzunternehmenVectorsTest.kanonisch`). Wiedervorlage 12 Monate (Startwert); „Überprüfung
fällig“ wird beim Abruf abgeleitet — kein Läufer. Zustände der Basis für den Leser: Vokabular `basis_zustand`.

## 7. Grenzen (G1–G4) und Kennzeichen (G5)

| Regel | Fall | Ergebnis |
|---|---|---|
| G1 | weniger als 12 Monate für ein Modell | `modell` → `zu_wenig_perioden` (Lindach: 1 von 12) |
| G2 | keine Fassung · Periode läuft · kein Zählerwert · Variable ohne Wert | `nicht_anwendbar` mit `basis_fehlt`/`basis_beendet` · `periode_nicht_zu_ende` · `keine_werte` · `variable_fehlt` |
| G2 | Zähler oder Variable `unvollstaendig` | Zahl mit Richtung, **`ohne_urteil`**, Kennzeichen „unvollständig“ |
| G3 | Variable außerhalb [min − 10 %, max + 10 %] | Modell: `nicht_anwendbar` `variable_ausserhalb` — kein erwarteter Wert. Verhältnis: rechnet, Kennzeichen „{Variable} außerhalb der Basis-Spannweite (min–max Einheit)“ |
| G4 | zwei Variablen mit \|r\| ≥ 0,9 | zweite abgelehnt `variablen_abhaengig` mit r (Ahrenberg BZ-3: r = 0,997) |

**G5 — die Kennzeichen-Liste**, in dieser Reihenfolge, ohne Doppel: (1) „bereinigt um …“ der Methode; (2) bei `gradtage`
„Streuung ± x %“; (3) Verhältnis über eine Gradtagzahl „ohne Grundlast“; (4) unter der Mindestlänge „Bezugsbasis vorläufig
(n von 12 Monaten)“; (5) Verhältnis außerhalb der Spannweite; (6) die Kennzeichen der Eingänge (erst gemessen, dann jede
Variable — etwa „Temperatur von VoltPilot bezogen (…)“, „mit Ersatzwert (…)“); (7) „unvollständig“; im Zeitraum (8) „x von
y Monaten“. Zahlen im Kennzeichen: Dezimalkomma, Tausender mit Leerzeichen (§5.8), echtes Minus. Die Modellgüte wird nie
verschwiegen.

## 8. Urteil (U1–U6)

- **U1** Ein Urteil gibt es **nur bereinigt** gegen eine freigegebene Fassung. Die rohe Veränderung (Operation `roh`)
  trägt immer `ohne_urteil` — VG3 bleibt für Messstellen, Vorperiode, Vorjahr und die Kennzahl ohne Basis.
- **U2** Δ = (gemessen − erwartet) ÷ erwartet × 100, eine Stelle. Weniger Energie als erwartet ist `besser`, mehr ist
  `schlechter`; `richtung` = `mehr · weniger · gleich`.
- **U3** `im_rahmen`, wenn |gemessen − erwartet| × 100 ≤ Band × erwartet; **Band = max(Toleranz der Fassung (Startwert
  2 %), Streuung der Fassung)**. Das Band steht neben dem Urteil (`band_prozent`).
- **U4** Jedes Urteil nennt Bedingung (Variable mit Wert), Basis (Kennzeichen, Fassung, Methode) und Vorbehalte — die
  Kennzeichen-Liste aus §7. Ohne Bedingung kein Urteil.
- **U5** Zeiträume rechnen **Σ gemessen ÷ Σ erwartet**, nie ein Mittel der Monats-Δ (November 2027 bis Februar 2028:
  1,8 %, das Mittel wäre 2,2 %). Ein Monat, der `nicht_anwendbar` ist, fehlt: der Zeitraum ist dann `ohne_urteil` mit
  „x von y Monaten“ und rechnet die Zahl über die vorhandenen Monate.
- **U6** Kein Satz behauptet eine Ursache: „mehr/weniger Energie als unter diesen Bedingungen erwartet“, nie „Leckage“,
  nie „Maßnahme wirkt“.

## 9. Vokabulare (geschlossen, in `bezugsbasis-vectors.json`)

| Block | Werte |
|---|---|
| `methode` | `verhaeltnis · regression_eine_variable · regression_zwei_variablen · gradtage` |
| `urteil` | `besser · schlechter · im_rahmen · ohne_urteil · nicht_anwendbar` |
| `grund` | `basis_fehlt · basis_beendet · zu_wenig_perioden · variable_fehlt · variable_ausserhalb · variablen_abhaengig · keine_werte · periode_nicht_zu_ende` |
| `datenlage` | `vollstaendig · vorlaeufig` |
| `richtung` | `mehr · weniger · gleich` |
| `anpassungsgrund` | `referenzperiode_vervollstaendigt · grundlage_korrigiert · struktur_geaendert · variable_geaendert · methode_geaendert · nicht_mehr_anwendbar · sonstiger` |
| `faktor_art` | `flaeche · standort · anlage · prozess · kostenstelle · wortlaut` |
| `basis_zustand` | `entwurf · freigegeben · anstoss_liegt_vor · ueberpruefung_faellig · beendet` |
| `freigabe_status` | `beantragt · freigegeben · abgelehnt` |

Startwerte (`startwerte`, ohne Norm-Herleitung): Mindestlänge 12 Monate · Toleranz 2 % · Spannweite ± 10 % ·
Abhängigkeit |r| ≥ 0,9 · Wiedervorlage 12 Monate. Toleranz und Wiedervorlage ändert der Kunde je Basis als Fassung mit
Begründung; Mindestlänge, Spannweite und Abhängigkeits-Schwelle stehen im Vertrag.

## 10. Kundensätze (§5.8)

Die Fläche baut IP-9 ff.; der Wortlaut steht hier, damit Vektoren und Sätze dieselben Zahlen sprechen. Kundenwörter nach
SP1, nie „EnPI“, „EnB“, „Baseline“, „Normalisierung“, „KPI“ (SP2); jede Fläche trägt den Grenz-Satz.

| Wo | Satz | Vektor |
|---|---|---|
| Basis-Zeile | „Bezugsbasis BB-0001 · Oktober 2026 · Verhältnis 0,2837 kWh je kg · vorläufig (1 von 12 Monaten) · freigegeben von Ines Kaltenbach am 12.11.2026.“ | R1 Basiswert |
| Fassung 2 | „Bezugsbasis BB-0001 · Fassung 2 (November 2026 bis Oktober 2027, 12 Monate): Modell mit einer Einflussgröße — 10 523 kWh Grundlast + 0,2343 kWh je kg, Streuung ± 0,8 % · gilt seit 01.11.2027.“ | R12 Modell |
| Vergleich, schlechter | „Dezember 2027: 78 000 kWh gemessen, 69 098 kWh erwartet bei 250 000 kg — 12,9 % mehr als die Bezugsbasis erwarten lässt: schlechter.“ | R2 Dezember |
| Vergleich, roh daneben | „Dezember 2027: 78 000 kWh — 8,8 % weniger als im November (Produktion: 21,9 % weniger).“ | roh und bereinigt |
| Vergleich, besser | „Januar 2028: 78 000 kWh gemessen, 80 813 kWh erwartet bei 300 000 kg — 3,5 % weniger: besser.“ | R2 Januar |
| Vergleich, im Rahmen | „Februar 2028: 81 500 kWh gemessen, 81 985 kWh erwartet bei 305 000 kg — 0,6 % weniger: im Rahmen (± 2 %).“ | R2 Februar, M5 81 984,5 |
| Zeitraum | „November 2027 bis Februar 2028: 323 000 kWh gemessen, 317 395 kWh erwartet — 1,8 %: im Rahmen der Bezugsbasis (Summe über vier Monate).“ | R11 |
| Vorläufig | „März 2027: 88 265 kWh bei 331 000 kg — 6,0 % weniger als die Bezugsbasis Oktober 2026 erwarten lässt: besser. Die Bezugsbasis ist vorläufig (1 von 12 Monaten).“ | R6 |
| Nicht anwendbar, Spannweite | „Modell nicht anwendbar: die Produktionsmenge im März 2028 (390 000 kg) liegt außerhalb der Bezugsbasis (254 000–341 000 kg).“ | R4/G3 |
| Nicht anwendbar, Perioden | „Modell nicht möglich: 1 von 12 Monaten in der Referenzperiode. Das Verhältnis ist vorläufig.“ | R4/G1 |
| Abhängige Variablen | „Betriebsstunden nicht aufgenommen: sie hängen an der Produktionsmenge (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.“ | R9/G4 |
| Wetter | „Januar 2028: 1 930 m³ Gas bei 480 Gradtagen — 1 943 m³ erwartet: im Rahmen der Bezugsbasis (± 4,6 %). Temperatur von VoltPilot bezogen (Wetter-Archiv), nicht am Standort gemessen.“ | Verhältnis über Gradtage … |
| Beendet | „Nicht bewertbar: Bezugsbasis beendet am 31.12.2026 (Anbau Halle 2). Fassung 2 gilt seit 01.03.2027.“ | R5 Januar 2027 |
| Leer | „Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen werden soll — der Vergleich entsteht aus den gespeicherten Werten.“ | R10 |

## 11. Die Vektoren

Jeder Fall trägt `name`, `regel`, `operation`, `quelle`, `rechnung` (die Handrechnung), `eingang` und `erwartet`.
Operationen: `referenzperiode · basiswert · modell · abhaengigkeit · vergleich · roh · roh_und_bereinigt · methoden_paar ·
zeitraum · runden`. Pflichtfälle aus §8 IP-2: „Dezember 2027: roh ohne Urteil, bereinigt schlechter“ und „Verhältnis
über Gradtage sagt besser, Modell im Rahmen“ (Januar 2028: −5,3 % gegen −0,7 %) sind eigene Vektoren. Fassungen mit
`BB-0001 … BB-0005` sind wörtlich die der Referenzdatei 1.8 (geprüft in `test_bezugsbasis.py`); `BB-9001` ist eine
konstruierte Rundungsprobe, ebenso der Fall „zwei unabhängige Einflussgrößen“ (Spritzguss-Reihe mit der Gradtagzahl).

## 12. Abweichungen und Grenzen

- **Rundung anders als `k_faelle.py`:** dort rundete `r1(x) = round(x + 1e-9, 1)` negative ,5-Werte zum Nullpunkt hin
  (−2,05 → −2,0). Der Vertrag sagt kaufmännisch (M5) und legt −2,1 fest; keine Zahl der Referenzfälle ändert sich dadurch.
- **BB-0004 Fassung 1 hat in der Referenzdatei 1.8 keine Spannweite** (`spannweite: null`), obwohl M2 sie für jedes Modell
  speichert; die Rechnung liefert 0–605 Kd (toleriert 0–665,5). Die Vektoren zitieren die Datei, G3 greift dort deshalb nicht.
- Nicht in diesem Vertrag: P3 (vorläufige Werte in der Grundlage), Anstoß (A1–A5), Frist-Ableitung, Faktor-Änderung und
  Prüfsummen-Bildung als Operation — sie gehören zu den Paketen mit Tabelle und Lauf (IP-5 ff.).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest=BezugsbasisVectorsTest)
(cd frontend/portal && npx vitest run src/uemsBezugsbasis.test.ts)
(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_bezugsbasis.py)
```
