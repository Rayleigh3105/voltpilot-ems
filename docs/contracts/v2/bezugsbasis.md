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

> **Wer anruft:** der Leser `BezugsbasisGrundlage` (IP-7, §13: Basiswert und Datenlage beim Entwurf). Freigabe (IP-8), Lesemodell
> `BezugsbasisVergleich` und die Fläche (IP-9 ff.), der Leistungsvergleich als Bericht (IP-19 ff.) folgen.

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
| Frist | „Bezugsbasis BB-0001, Fassung 2 vom 24.11.2027 · Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.“ | R13 fällig seit 1 Tag |

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

## 13. Routen (IP-7: Anlegen und Entwurf · IP-8: Freigabe, Fassung n + 1, Verantwortlicher · IP-10: Modelle)

Recht `bezugsbasis.verwalten` bzw. `bezugsbasis.freigeben` an der Geltung der Kennzahl (`@Recht` DIENST, genaue Prüfung
`KennzahlService.fuerBezugsbasis`);
die Lese-Routen nennen `bezugsbasis.ansehen` im Kommentar, die Sichtbarkeit kommt über die Kennzahl (außerhalb der Sicht 404,
anderer Kundenbereich 404 über RLS). Ablehnungen `{code, message, …Fakten}`.

| Route | Was | Ablehnungen |
|---|---|---|
| `GET /api/v1/kennzahlen/{id}/bezugsbasen` | alle Bezugsbasen der Kennzahl `{bezugsbasen: [ … ]}`, je Eintrag in der Form von `GET …/bezugsbasen/{bid}`, die laufende zuerst, danach die beendeten (jüngste zuerst) | 404 |
| `POST /api/v1/kennzahlen/{id}/bezugsbasen` | legt BB-… an; Körper `{zweck?}`; Verantwortlicher = der der Kennzahl (B4, ohne ihn die anlegende Person); Protokoll `bezugsbasis_angelegt`; 201 | 409 `bezugsbasis_laeuft` (B1) · 409 `kennzahl_archiviert` · 422 `kennzahl_ohne_bezugsbasis` (B2: Anteil, Quotient ohne Messstelle im Zähler) |
| `GET …/bezugsbasen/{bid}` | die Basis mit ihren Fassungen (Nummer, Referenzperiode, Methode, Datenlage, `freigabe_status`, Basiswert, `gilt_ab`, Prüfsumme) | 404 |
| `POST …/bezugsbasen/{bid}/fassungen` | Entwurf mit Vorschau (F1): Körper `{referenzperiode, methode, variablen?, toleranz_prozent?, wiedervorlage_monate?, faktoren?}` (`faktoren` §17); ein offener Entwurf wird neu gebildet (gleiche Nummer, Variablen und Faktoren aufgehoben und neu); Protokoll `fassung_entworfen` je Bildung; 200 = die gespeicherte Fassung. **Ab Fassung 2** (nach einer freigegebenen oder abgelehnten Fassung, `bezugsbasis_fassung_anpassungsgruende_chk`) zusätzlich `anpassungsgruende` (A1, einer oder mehrere, je höchstens einmal), `anpassung_wortlaut` (nur und immer mit `sonstiger`) und `begruendung` (10–500) Pflicht; `gilt_ab?` Vorgabe der Tag nach der Referenzperiode (P4) | 422 `anpassungsgrund_fehlt` · `anpassungsgrund_unbekannt` · `anpassung_wortlaut` · `anpassung_ohne_vorgaengerin` (Fassung 1 mit Grund) · `begruendung_fehlt` · `gilt_ab_vor_periodenende` · `gilt_ab_vor_vorgaengerin` (vor dem `gilt_ab` der laufenden freigegebenen Fassung) · `referenzperiode_format` · `referenzperiode_reihenfolge` · `periode_nicht_zu_ende` (P1/P3, laufender Monat in der Zeitzone der Kennzahl) · `methode_unbekannt` · `keine_werte` · `zu_viele_variablen` · `variable_nicht_nenner` (V2) · Modelle: `zu_wenig_perioden` (G1, mit `monate`/`mindest_monate`) · `variable_fehlt` (G2, mit `variable` und `perioden`) · `variable_keine_gradtagzahl` (M3) · `zweite_variable_fehlt` · `variable_unbekannt` · `modell_ohne_nenner` · `variable_ohne_periodenwerte` · `toleranz_ungueltig` · `wiedervorlage_ungueltig` · `faktor_unbekannt` · `faktor_doppelt` (§17); 409 `bezugsbasis_beendet` · `fassung_beantragt`; 400 `anfrage_ungueltig` (unbekanntes Feld) |
| `GET …/bezugsbasen/{bid}/fassungen/{n}` | die gespeicherte Fassung — **byte-gleich** zur Antwort ihres Entwurfs | 404 |
| `POST …/fassungen/{n}/beantragen` | F2, nur mit `unternehmen.vieraugen_freigabe`: Entwurf → `beantragt`; Körper `{begruendung?}` (sonst die des Entwurfs; 10–500); Recht `bezugsbasis.freigeben` — wer beantragt, ist die Freigabe-Person (`freigabe_*`, Rolle KA/EM per `bezugsbasis_fassung_freigabe_chk`); Protokoll `fassung_beantragt` mit Begründung | 409 `vieraugen_aus` · `fassung_beantragt` · `fassung_freigegeben` · `fassung_abgelehnt` · `bezugsbasis_beendet`; 422 `begruendung_fehlt`; 403 `recht_fehlt` |
| `POST …/fassungen/{n}/freigeben` | F1: ohne Vier-Augen gibt die Person den **Entwurf** mit Begründung frei (`freigabe_*`); F2: mit Vier-Augen bestätigt eine **zweite Person** den Antrag (`entscheidung_*`; nicht, wer die Fassung gebildet oder beantragt hat; Rolle KA/EM). `freigegeben_am` = jetzt (Beginn der Wiedervorlage, F5). F4: die laufende freigegebene Vorgängerin endet am Vortag des `gilt_ab` (`gilt_bis`, `beendet_grund` „abgelöst durch Fassung n“, Protokoll `fassung_beendet`), sonst bleibt sie byte-gleich. Protokoll `fassung_freigegeben`; freigegeben und abgelehnt kehren nie zurück (Trigger) | 409 `vieraugen_beantragen` (Entwurf bei Vier-Augen) · `fassung_freigegeben` · `fassung_abgelehnt` · `gilt_ab_vor_vorgaengerin` · `bezugsbasis_beendet`; 422 `begruendung_fehlt` · `vieraugen_urheber`; 403 `recht_fehlt` · `vieraugen_rolle` |
| `POST …/fassungen/{n}/ablehnen` | F2: die zweite Person lehnt einen Antrag mit Begründung ab (`entscheidungs_begruendung`); danach ist ein neuer Entwurf möglich (Fassung n + 1 mit Anpassungsgrund); Protokoll `fassung_abgelehnt` | 409 `fassung_entwurf` · `fassung_freigegeben` · `fassung_abgelehnt`; 422 `begruendung_fehlt` · `vieraugen_urheber`; 403 `recht_fehlt` · `vieraugen_rolle` |
| `PUT …/bezugsbasen/{bid}/verantwortlicher` | B4: Körper `{benutzer}` (Kennung eines aktiven Benutzers des Kundenbereichs), Name als Schnappschuss; Recht `bezugsbasis.verwalten`; Protokoll `verantwortlicher_geaendert` (alt/neu) | 422 `benutzer_unbekannt` · 409 `bezugsbasis_beendet` · 400 `anfrage_ungueltig` |

**Register-Eintrag (B3):** `GET /api/v1/kennzahlen` und `GET /api/v1/kennzahlen/{id}` tragen je Kennzahl `bezugsbasis`:
`null` ohne laufende Basis, sonst `{kennzeichen, fassung, freigabe_status, vorlaeufig}` — `fassung` ist die laufende
freigegebene Fassung, sonst die jüngste (`null` ohne Fassung). Das Wort „Energieleistungskennzahl“ leitet der Leser aus
`freigabe_status = freigegeben` ab; es steht an der Kennzahl, nicht in ihr (keine Spalte an `kennzahl`).

Beenden, „geprüft, bleibt“ und die Übersicht stehen bei IP-17, der Vergleich bei IP-19.

**Fassung** (Antwort): `fassung`, `referenzperiode`, `methode`, `gilt_ab` (Tag nach der Referenzperiode, P4), `monate`,
`mindest_monate`, `datenlage`, `datenlage_gruende`, `vorbehalte`, `basiswert` (Dezimaltext, 4 Stellen, M5), `koeffizienten`
(`a`, `b`, beim Modell mit zwei Einflussgrößen `c`; 4 Stellen), `r2` (3), `streuung_prozent` (1) — beim Verhältnis `null` —,
`abgelehnte_variablen` (G4), `kennzeichen` (etwa „ohne Grundlast“, M3), `toleranz_prozent`,
`wiedervorlage_monate`, `variablen` (Position 1 = Nenner mit Bezugsgrößen-Fassung und Spannweite min–max der Nenner),
`faktoren` (§17, leer ohne gewählte Faktoren), `freigabe_status` (`entwurf · beantragt · freigegeben · abgelehnt`), `gebildet_am`, `gebildet_von`,
`gilt_bis` (F4), `anpassungsgruende`, `anpassung_wortlaut`, `begruendung`, `vieraugen`, `freigabe` und `entscheidung`
(`{name, rolle, am}` bzw. `null`), `entscheidungs_begruendung`, `freigegeben_am`, `grundlage` (der gespeicherte
kanonische Text, roh eingebettet) und `pruefsumme` (`sha256:` über ihn, gleich `bericht_pruefsumme`).

**Grundlage** (F3, kanonisch wie §6): `referenzperiode`, `methode`, `kennzahl` (Kennzeichen, Rechenform, Definitions-Fassung am
letzten Tag), `perioden[]` — je Monat die AKTUELLE Zeile der Kennzahl (`kennzahl`: ungerundeter `wert`, `version`,
`definition_fassung`, `zustand`, `menge_zustand`, `kennzeichen`), `zaehler`, `nenner` und jeder Eingang (`objekt`, `wert`,
`version` bzw. `fassung`, `einheit`, Kennzeichen); ein Monat ohne Zahl steht nur mit `grund` (`noch_nicht_gebildet` oder
dem Grund der Kennzahl) und zählt nicht —, `monate`, `mindest_monate`, `datenlage`, `datenlage_gruende`, `vorbehalte`,
`variablen`, `faktoren` (§17; ohne Faktoren `[]` — die Grundlage ist dann byte-gleich wie ohne IP-16b), `basiswert`. Nichts wird nachgerechnet: der Basiswert ist `basiswert` (§4) über die gespeicherten
Zähler und Nenner der Monate mit Zahl.

**Modelle beim Bilden (IP-10, M2–M4).** Variable 1 ist der Nenner der Kennzahl mit seinen gespeicherten Monatswerten (V2);
`variablen` im Körper darf ihn vorn nennen. `regression_eine_variable` und `gradtage` rechnen nur mit ihm — `gradtage`
verlangt eine Bezugsgröße der Art `gradtagzahl` (Messkanal oder `bezogen`). `regression_zwei_variablen` nimmt genau eine
weitere, lesbare Bezugsgröße mit Periodenwerten; ihr Monatswert ist die Summe ihrer wirksamen Werte im Monat (fehlt ein
Teil, fehlt der Monat), mit Fassung. Gerechnet wird ausschließlich `modell` (§4) über die Monatspaare; ein Monat mit Nenner 0
(`nenner_null`, etwa null Gradtage im Sommer) ist für ein Modell ein Paar, für das Verhältnis kein Monat. Grenzen beim
Bilden: G1 unter 12 Monaten oder ohne Streuung der Variablen → 422 `zu_wenig_perioden`; G2 Variable 2 fehlt in einem Monat
mit Zahl → 422 `variable_fehlt`; **G4** |r| ≥ 0,9 → die zweite Variable wird nicht aufgenommen, die Fassung rechnet als
Modell mit einer Einflussgröße, `abgelehnte_variablen` nennt `objekt`, `position`, `grund`, `r`, `startwert_r`, und das
Protokoll bekommt `variable_abgelehnt` (200, keine 422 — §3, R9). Koeffizienten, R², Streuung stehen in den Spalten der
Fassung und in der Grundlage (`koeffizienten`, `r2`, `streuung_prozent`, `abgelehnte_variablen`, je Variable `spannweite`
mit `toleriert_von`/`toleriert_bis`, je Monat `variablen[]` mit dem Wert der zweiten Variablen); G3 prüft die Spannweite erst
im Vergleich (IP-13). Ahrenberg: R12 → a = 10 522,6206 (Datei 10 523), b = 0,2343, R² 0,991, Streuung 0,8 %, 254 000–341 000 kg;
R3 → a = 118,9104 (119), b = 3,8041 (3,80) — `BezugsbasisApiTest`.

**Datenlage** (P2/P3): `vorlaeufig` mit je einem Grund `monate` (n von 12, dazu `ohne_wert[]`), `angeschnitten` (Monat mit
„ab TT.MM.JJJJ“ im Kennzeichen der Kennzahl) und `vorlaeufige_werte` (`zustand` ≠ `endgueltig`); sonst `vollstaendig`.
Die Monats-Zeilen der Referenzdatei 1.8 (`bezugsbasen[].fassungen[].grundlage`) sind eine verkürzte Form dieser Grundlage
(dort `annahme` statt Eingängen, der Kennzahl-Wert gerundet); ihre Prüfsummen entstehen mit derselben Kanonisierung
(`BezugsbasisGrundlageTest`), die der API aus dem ungerundeten gespeicherten Wert — es sind darum nicht dieselben Zahlen.

Löschweg: eine Bezugsgröße, die Variable einer Fassung ist (auch eines aufgehobenen Entwurfs), lehnt `DELETE
/api/v1/bezugsgroessen/{id}` mit 409 `bezugsgroesse_in_verwendung` und `bezugsbasen: ["BB-…"]` ab.

## 14. Faktoren-Vorschlag (V3, E6 = A; IP-16a)

`GET /api/v1/kennzahlen/{id}/faktoren-vorschlag?stichtag=JJJJ-MM-TT` schlägt die statischen Faktoren vor, die die
**Struktur der Geltung** der Kennzahl am Stichtag hergibt (ohne `stichtag`: heute in der Zeitzone der Kennzahl). Ein
Lese-Weg: nichts wird gespeichert, nichts geändert. Die Liste an der Fassung mit der Kopie zum Freigabetag und der
Anstoß `struktur_geaendert` kommen mit IP-16b; ein `wortlaut`-Faktor wird nie vorgeschlagen — den schreibt der Kunde.
Rechte: gelesen wird wie die Kennzahl (`messwerte.ansehen`), Zaun über die Kennzahl — wer sie nicht ganz sieht, bekommt
404, nie 403 und nie einen Teil der Struktur. Ein unbekannter Parameter oder ein Stichtag, der kein Tag ist, ist 400
`anfrage_ungueltig` mit `feld`. Java: `uems/FaktorenVorschlag`, Route `web/FaktorenVorschlagController`.

**Die Struktur der Geltung** sind die Orte der Geltung und die Messstellen, die am Stichtag darin liegen — jede
Zuordnung tagesgenau, der letzte Tag eingeschlossen, aufgehobene nie:

| Geltung | Messstellen | Fläche je Ort | Standorte |
|---|---|---|---|
| `unternehmen` | alle verorteten | die Standorte (eigene Fläche, sonst Summe der Gebäude) | alle |
| `standort` | am Standort und in seinen Orten | seine Gebäude; ohne Gebäude er selbst | er selbst |
| `gebaeude` · `bereich` | im Ort (ein Gebäude mit seinen Bereichen) | der Ort selbst | sein Standort |
| `prozess` | zugeordnet dem Prozess oder einem Unterprozess (eine Ebene) | die Gebäude der Messstellen (ein Bereich zählt zu seinem Gebäude) | die der Messstellen |
| `kostenstelle` | mit einem Anteil an der Kostenstelle | wie `prozess` | wie `prozess` |
| `messstelle` | sie selbst | wie `prozess` | wie `prozess` |

Anlagen: die Anlagen, an denen die Messstellen am Stichtag stehen (im Unternehmen und am Standort zusätzlich jede dort
zugeordnete Anlage). Prozesse: im Unternehmen alle, beim Prozess er und seine Unterprozesse, sonst die der Messstellen.
Kostenstellen: im Unternehmen alle, bei der Kostenstelle sie selbst, sonst die der Messstellen. **Ein Objekt ohne
Gültigkeit am Stichtag entfällt** — ein Ort, den es noch nicht oder nicht mehr gibt, ein Prozess vor seinem `gueltig_ab`,
eine Anlage ohne Standort an dem Tag.

**Antwort** (alle Felder stehen immer da; `null` heißt unbekannt, nie 0): `kennzahl_id`, `kennzeichen`, `geltung_art`,
`geltung_id`, `geltung_name`, `stichtag`, `faktoren`, `flaeche`, `hinweis`. Je Kandidat in `faktoren` (Reihenfolge:
Fläche, Standorte, Anlagen, Prozesse, Kostenstellen; darin nach Kennung):

- `art` — `faktor_art` ohne `wortlaut`; `objekt_id` und `kennung` (G-2, ST-1, P-1, 4100; eine Anlage hat keine Kennung,
  `null`) und `bezeichnung`;
- `wert` und `einheit` **nur bei der Fläche** (ganze m² am Stichtag, Einheit `m²`), bei allen anderen `null` — sie sind
  ein Verweis ohne Zahl;
- `gueltig_ab` und `gueltig_bis` (einschließlich, `null` = offen): das Flächen-Intervall, das Bestehen des Standorts,
  die Zuordnung der Anlage zu ihrem Standort, die Gültigkeit von Prozess und Kostenstelle;
- `satz` — „Fläche Halle 2 (G-2): 3 100 m² am 01.10.2026 · gültig 01.10.2026 bis 31.12.2026.“ ·
  „Standort Werk Ahrenberg (ST-1) · gültig ab 01.01.2026 · Verweis ohne Zahl.“

`flaeche` ist die Fläche der Geltung als Summe der Flächen-Kandidaten: `wert`, `einheit`, `objekte` (die summierten
Kennungen), `ohne_flaeche`, `gueltig_ab`/`gueltig_bis` (der Schnitt der Teil-Gültigkeiten) und `satz` —
„Fläche der Geltung am 01.01.2027: 3 400 m² (G-2) · gültig ab 01.01.2027.“ Fehlt einem Ort der Geltung die Fläche am
Stichtag, ist `wert` `null` und `ohne_flaeche` nennt ihn: „… keine Summe — für G-3 ist an diesem Tag keine Fläche
eingetragen.“ — nie eine Teilsumme, nie 0 (AP-02 E3). `hinweis`: „Vorschlag aus der Struktur am 01.10.2026 — nichts
ist gespeichert. Statische Faktoren gelten erst mit der Bezugsbasis, die Sie freigeben.“

R5/KZ-0005 (Geltung G-2): am 01.10.2026 schlägt die Route „Fläche G-2 3 100 m²“ (gültig bis 31.12.2026) vor, am
01.01.2027 „3 400 m²“ ab 01.01.2027 — genau die Kopie, die BB-0003 Fassung 1 bzw. 2 in der Referenzdatei 1.8 trägt;
dazu ST-1 und die Prozesse und Kostenstellen der Messstellen in Halle 2. **Keine Vektoren:** die Stichtags-Auswahl ist
die tagesgenaue Regel der Ortsstruktur (`OrtsbaumAbleitung`, `ortsbaum-vectors.json`) und der Zuordnungen (daterange
`[]`), keine neue reine Regel; geprüft wird die Route in `FaktorenVorschlagApiTest` und die Form in
`FaktorenVorschlagSchnittstelleVertragTest`.

## 15. Pflege: bleibt, beenden, Übersicht (F4, F5, A4, R13 — IP-17)

**Frist (F5), Operation `frist`.** Die Frist der laufenden Fassung wird beim Abruf abgeleitet — kein Läufer, kein
Ereignis, keine Nachricht: Beginn = Freigabetag (`freigegeben_am`, in der Zeitzone der Kennzahl) oder das jüngste
„geprüft, bleibt“ dieser Fassung, wenn es später liegt; `faellig_am` = Beginn + `wiedervorlage_monate` Kalendermonate
(Monatsende geklemmt: 31.01. + 1 → 28.02.; 29.02. + 24 → 28.02.). Ab `faellig_am` ist der Zustand
`ueberpruefung_faellig` mit `faellig_seit_tagen` = Stichtag − `faellig_am` (0 am Fälligkeitstag), davor `freigegeben`;
eine beendete Basis hat keine Frist (`beendet`). Der Stichtag wird übergeben, nie aus einer Uhr gelesen. Zwillinge:
`BezugsbasisRegeln.frist`, `bezugsbasis.ts` `frist`, `bezugsbasis.py` `frist`; acht Vektoren (`regel` F4/F5) ergänzen
die Datei, darunter R13 „fällig seit 1 Tag“, „bleibt → neue Frist“ und „beendet“ — die Datei trägt damit 53 Fälle.

**„Geprüft, bleibt“ (F5, A4)** `POST /api/v1/kennzahlen/{id}/bezugsbasen/{bid}/bleibt` `{begruendung}` (10–500):
ein Protokolleintrag `gueltig_bleibt` an der laufenden Fassung (`neu`: `bestaetigt_am`, `faellig_am`); die Fassung
bleibt byte-gleich, `freigegeben_am` ist eingefroren — die neue Frist steht im Protokoll. Offene Anstöße der Fassung
gelten als beantwortet (`bleibt`, mit derselben Begründung). Der andere Weg ist Fassung n + 1 (IP-8).

**Beenden (F4)** `POST …/bezugsbasen/{bid}/beenden` `{tag, grund, begruendung, rueckwirkend?}`: `tag` ist der letzte
eingeschlossene Tag; vor heute nur mit `rueckwirkend: true`, nie vor dem `gilt_ab` der laufenden Fassung. `grund` aus
`anpassungsgrund` (A1). Die Basis bekommt `beendet_zum/_am/_grund` genau einmal, die laufende Fassung `gilt_bis`;
offene Anstöße gelten als beantwortet (`beendet`); Protokoll `bezugsbasis_beendet`. Nie gelöscht; danach darf die
Kennzahl eine neue Basis bekommen (B1). **Archivierung der Kennzahl** beendet die laufende Basis am Archivierungstag
mit Grund `nicht_mehr_anwendbar` (Begründung „Kennzahl archiviert“) in derselben Transaktion; ohne Basis geschieht
nichts (R10). Ein Vergleich danach sagt `nicht_anwendbar`/`basis_beendet` (IP-19) mit dem Satz „Nicht bewertbar:
Bezugsbasis beendet am …“ (§10).

**Übersicht** `GET /api/v1/bezugsbasen/uebersicht` (Recht `bezugsbasis.ansehen` über die Sichtbarkeit der Kennzahl):
`laufend` · `freigegeben` · `vorlaeufig` · `mit_anstoss` · `ueberpruefung_faellig` und `faellig[]` (am längsten fällig
zuerst). Die Portal-Kachel `BezugsbasisUebersichtKarte` am Unternehmen zeigt die Zähler und je fälliger Basis den Satz
„Frist“ (§10); ohne laufende Basis zeigt sie nichts (R10). Kundensätze der Kachel:
„Überprüfung fällig seit n Tagen — bestätigen oder neu fassen.“ (1 Tag · n Tagen · am Fälligkeitstag „seit heute“).

Rechte: Schreiben `bezugsbasis.verwalten` am Geltungsbereich der Kennzahl (`@Recht` mit Ziel DIENST, genaue Prüfung
`KennzahlService.darfAnKennzahl`), Lesen `bezugsbasis.ansehen`. Prüfreihenfolge: Anfrage 400 → Kennzahl 404 → Recht
403/404 → Inhalt 422 (`begruendung_fehlt`, `grund_unbekannt`, `rueckwirkend_fehlt`, `tag_vor_fassung`) → Zustand 409
(`bezugsbasis_beendet`, `keine_freigegebene_fassung`).

## 17. Statische Faktoren an der Fassung (V3, E6 = A; IP-16b)

`POST …/bezugsbasen/{bid}/fassungen` nimmt `faktoren: [{art, objekt_id?, wortlaut?}]`. `art` aus `faktor_art`
(`flaeche · standort · anlage · prozess · kostenstelle · wortlaut`). Ein **Verweis** (`objekt_id`, kein `wortlaut`) ist nur
zulässig, wenn der Faktoren-Vorschlag (§14) ihn für die Geltung der Kennzahl am **Stichtag** mit derselben `art` nennt —
sonst 422 `faktor_unbekannt` mit `art`, `objekt_id`, `stichtag` (ebenso eine unbekannte `art`). Ein **Wortlaut** (`wortlaut`
1–500 Zeichen, keine `objekt_id`) hat keinen Wert und stößt nie an. Falsche Form (Verweis ohne `objekt_id`, Wortlaut mit
`objekt_id`, leerer Wortlaut, fehlende `art`) → 400 `anfrage_ungueltig` (`feld: faktoren`); derselbe Faktor zweimal → 422
`faktor_doppelt`. Ohne das Feld oder mit `[]` hat die Fassung keine Faktoren.

**Stichtag** ist im Entwurf der **Bildungstag** (heute in der Zeitzone der Kennzahl) — V3 verlangt den Wert zum
Freigabetag; die Neukopie am Freigabetag, falls er sich bis dahin geändert hat, ist ein eigenes Folgepaket (die
Freigabe aus IP-8 übernimmt die Kopie des Entwurfs unverändert). Die **Kopie** steht in
`bezugsbasis_faktor` (Position, Art, `verweis` bzw. `wortlaut`, `wert`/`einheit` nur bei der Fläche, `wert_gueltig_ab`,
`kopie_am` = Stichtag); ein erneut gebildeter Entwurf hebt die bisherigen Faktoren auf (`aufgehoben_am`) und schreibt sie neu.
Der Struktur-Läufer (Pfad 2, A3) liest genau diese Zeilen: `art` und `verweis` sind die `art`/`objekt_id` des Vorschlags.

**Reihenfolge** stabil: Art in Vokabular-Reihenfolge, dann Kennung (ohne Kennung die Bezeichnung, beim Wortlaut sein
Text); Position ab 1. **Grundlage** (F3): der Block `faktoren` trägt je Faktor `position`, `art`, `kopie_am` und
beim Verweis `objekt` (Kennung, fehlt bei einer Anlage), `bezeichnung`, `wert` + `einheit` (Fläche), `gueltig_ab`; beim
Wortlaut `wortlaut`. Die Prüfsumme deckt den Block ab — die Form der Referenzdatei 1.8 (`faktoren[]`: `art`, `objekt`,
`wert`, `einheit`, `gueltig_ab`, `kopie_am`) ist darin enthalten.

**Antwort** (Vorschau und `GET …/fassungen/{n}`, byte-gleich): `faktoren[]` mit `position`, `art`, `objekt_id`, `kennung`,
`bezeichnung`, `wortlaut`, `wert` (Dezimaltext), `einheit`, `gueltig_ab`, `stichtag`, `ohne_anstoss` (`true` genau beim
Wortlaut) und `satz` — „Statischer Faktor: Fläche G-2 3 100 m² (Stand 12.11.2026)“, „Statischer Faktor: Standort ST-1
Werk Ahrenberg (Stand 12.11.2026)“, „Statischer Faktor: Zweischichtbetrieb, Halle 2 (Wortlaut, ohne Anstoß)“.

R1/R5: BB-0001 mit dem Faktor Fläche G-2 am 12.11.2026 → Kopie 3 100 m² gültig ab 01.10.2026; nach der Freigabe stößt der
Anbau der Halle 2 (3 100 → 3 400 m² ab 01.01.2027) die Fassung im Struktur-Läufer an (`struktur_geaendert`). Geprüft in
`BezugsbasisApiTest`; keine Vektoren (keine neue reine Regel: Auswahl = §14, Kanonisierung = §6).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest=BezugsbasisVectorsTest)
(cd services/api && ./mvnw test -Dtest='BezugsbasisGrundlageTest,BezugsbasisApiTest')   # Routen, Docker
(cd frontend/portal && npx vitest run src/uemsBezugsbasis.test.ts)
(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_bezugsbasis.py)
```
