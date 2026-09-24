# Bezugsbasis: reine Regeln (AP-17 IP-2, NW-1)

Verbindlich: [Bezugsbasis-Vertrag](../../contracts/v2/bezugsbasis.md),
[Vektoren](../../contracts/v2/bezugsbasis-vectors.json),
[Schema](../../contracts/v2/bezugsbasis.schema.json). Beispielquelle: Referenzdatei 1.8
(`bezugsbasen[]` BB-0001 … BB-0005, `leistungsvergleiche[]`, `abnahmefaelle_ap17`).

Java `uems/BezugsbasisRegeln`, TS `bezugsbasis.ts`, Python
`voltpilot_optimization/bezugsbasis.py` rechnen jeden Vektor derselben Datei. Die Python-Referenz
ist die bereinigte Rechnung aus AP-17 `k_faelle.py` (fit1, pearson, erwartet, urteil).

**Stand 24.09.2026 (Nachtrag AP-18 W12):** die Regeln haben Aufrufer. Java: `BezugsbasisService`,
`BezugsbasisGrundlage`, `BezugsbasisPflegeService`, `BezugsbasisAnstoesse`, `BezugsbasisVergleich`
(+ `…Satz`), `VariablenAbhaengigkeit`. TS: `bezugsbasisVergleich.ts`, `variablenAbhaengigkeit.ts`.
Python: nur die Tests (Referenz, kein Dienst). Tabellen `bezugsbasis`, `bezugsbasis_fassung`,
`…_variable`, `…_faktor`, `…_anstoss`, `…_aenderung` (`V20260924071500`, IP-6),
`bezugsbasis_struktur_gelesen` (`V20260924200500`, IP-15). Routen: Methoden `GET
/api/v1/bezugsbasis-methoden` (IP-5), `…/kennzahlen/{id}/bezugsbasen[/{bid}/fassungen…]` mit
beantragen/freigeben/ablehnen und Verantwortlichem (IP-7/IP-8, `BezugsbasisController`), `…/bleibt`,
`…/beenden`, `GET /api/v1/bezugsbasen/uebersicht` (IP-17, `BezugsbasisPflegeController`), `GET
…/kennzahlen/{id}/vergleich` (IP-19), Faktoren-Vorschlag (IP-16a). Flächen: Reiter und Assistent
(IP-9, `BezugsbasisReiter`, `BezugsbasisAssistent`), Modell (IP-14), Fassungen und Anstoß (IP-18),
Reiter „Vergleich mit Bezugsbasis“ (IP-20, `BezugsbasisVergleich`), Übersichts-Baustein
(`BezugsbasisUebersichtKarte`), Leistungsvergleich als Bericht (IP-21a–IP-24). Einzelheiten: die
Wegweiser `uems-bezugsbasis-datenhaltung.md`, `-grundlage.md`, `-freigabe.md`, `-methoden.md`,
`uems-bezugsbasis.md` (Einstieg). Die Ereignis-Wörter `bezugsbasis_*` sind weiter nur reserviert
(Anlage offen, `events-vocabulary.md`).

| Was | Wo |
|---|---|
| Rechnen | Basiswert Σ ÷ Σ (M1), kleinste Quadrate mit einer/zwei Variablen und Gradtage (M2/M3), R², Streuung, Spannweite, Pearson r (G4) |
| Urteil | `vergleich` (Δ, Band = max(Toleranz, Streuung), Grund statt Zahl, Kennzeichen-Liste G5), `zeitraum` (Σ ÷ Σ, „x von y Monaten“), `roh` (nie ein Urteil) |
| Faktoren-Vorschlag (IP-16a) | `GET /api/v1/kennzahlen/{id}/faktoren-vorschlag?stichtag=` (`uems/FaktorenVorschlag`, Vertrag §14): Fläche je Ort und als Summe, Standorte, Anlagen, Prozesse, Kostenstellen aus der Struktur der Geltung am Stichtag — nur lesen, Zaun über die Kennzahl; Summe `null` statt Teilsumme; Tests `FaktorenVorschlagSchnittstelleVertragTest`, `FaktorenVorschlagApiTest` (Docker) |
| Faktoren an der Fassung (IP-16b) | `POST …/fassungen` nimmt `faktoren[]` (`uems/BezugsbasisFaktoren`, Vertrag §17): Verweis nur, was der Vorschlag am Bildungstag nennt (sonst 422 `faktor_unbekannt`), Kopie in `bezugsbasis_faktor` + Block `faktoren` der Grundlage (Prüfsumme); ohne Faktoren byte-gleich wie IP-7. Falle: Stichtag ist im Entwurf der Bildungstag, die Neukopie zum Freigabetag ist ein Folgepaket |
| Tests | `BezugsbasisVectorsTest` · `uemsBezugsbasis.test.ts` · `services/optimization/tests/test_bezugsbasis.py` |

## Die Fallen

- **Exakte Brüche, nie Gleitkomma.** Alle drei rechnen mit BigInteger/BigInt/`Fraction` aus Dezimaltexten; Wurzeln
  (Streuung, r) laufen über die ganzzahlige Wurzel. Wer einen `double` einführt, bricht die ,5-Vektoren.
- **Rundung kaufmännisch, vom Nullpunkt weg** — nicht `Math.round` (−2,05 → −2,0) und nicht Pythons `round`
  (81 984,5 → 81 984). Die Vektoren „M5 …“ legen es fest; `k_faelle.py` wich bei negativen ,5-Werten ab.
- **Nie auf das Band gerundet:** Δ 2,04 % zeigt „2,0“ und ist `schlechter`; Band und Spannweite per Kreuzprodukt.
- **Die Koeffizienten der Referenzdatei 1.8 sind gröber gerundet** (a = 10 523 / 119, b = 3,8) als der Vertrag
  einfriert (vier Stellen: 10 522,6206 / 118,9104 / 3,8041). `erwartet` rechnet immer mit der eingefrorenen Kopie —
  deshalb zitieren die Vergleichsvektoren die Datei und treffen 69 098 kWh und −0,7 % wie das Konzept. Ein Paket, das
  Fassungen freigibt (IP-5 ff.), friert vier Stellen ein; die Datei-Zahlen bleiben dann ein gröber gerundetes Beispiel.
- **BB-0004 Fassung 1 hat in 1.8 `spannweite: null`**, obwohl M2 sie speichert (Rechnung: 0–605 Kd, toleriert 0–665,5).
- **Die Fassungen der Vektoren sind wörtlich die der Datei** — `test_bezugsbasis.py` prüft Basiswert, Koeffizienten,
  Streuung, Toleranz, Monate und Spannweite gegen `bezugsbasen[]`. Wer 1.8 ändert, fährt alle drei Zwillinge und
  `UemsReferenzunternehmenVectorsTest`/`uemsReferenzunternehmen.test.ts`.

```bash
(cd services/api && ./mvnw test -Dtest=BezugsbasisVectorsTest)
(cd frontend/portal && npx vitest run src/uemsBezugsbasis.test.ts)
(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_bezugsbasis.py)
```
