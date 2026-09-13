# UEMS-Formel-Typen `rest` und `saldo`: feste Ergebnis-Richtung, Terme aus der Stellung (AP-10 IP-4)

Das Paket, das die Plan-Abnahme des Captains aus dem Vertrag in den Code holt: **100 − 60 − 30 =
10 kWh, Richtung Bezug, „10 kWh sind keiner Messstelle zugeordnet“** (Fall F1, Werk Lindach,
18.10.2026). Reine Regeln in Java und TypeScript, keine Migration, keine Route, keine Portal-Fläche.

| Was | Wo |
|---|---|
| Verzweigung je Typ | Java `uems/MessstelleFormelRegeln.hauptgroesse` · `.periodenwert` · `.speichertTerme` ⟷ TS `uemsMessstelleFormel.ts` (ADDITIV unter den bestehenden Funktionen) |
| Die Rechnung | Java `uems/BilanzAbleitung` (`richtung`, `rest`, `saldo`, `summe`, NEU `restAusStellung`) ⟷ TS `uemsBilanz.ts` |
| Katalog `Wirkenergie · saldiert` | Java `MessstelleRegeln.GROESSEN_KATALOG` (`richtungenNurBerechnet`) + `groessePruefen(medium, art, g)` ⟷ TS `uemsMessstelle.ts` (`groessePruefen(medium, g, art)`); Vertrag `messstelle.md` §2, Schema `$defs/richtungNurBerechnet` |
| Vektoren | `bilanz-vectors.json` (neu Regel `rest_aus_stellung`, zwei Richtungs-Prüfungen in F1) · `messstelle-vectors.json` (Katalog-Feld + vier Größen-Fälle) — `messstelle-formel-vectors.json` ist UNBERÜHRT |
| Tests (rein) | `MessstelleFormelTypenTest`, `BilanzVectorsTest`, `MessstelleRegelnVectorsTest` · `uemsMessstelleFormelTypen.test.ts`, `uemsBilanz.test.ts`, `uemsMessstelle.test.ts` |

```bash
(cd services/api && ./mvnw test -Dtest='MessstelleFormelTypenTest,BilanzVectorsTest,MessstelleRegelnVectorsTest,MessstelleFormelRegelnVectorsTest')
(cd frontend/portal && npx vitest run src/uemsMessstelleFormelTypen.test.ts src/uemsBilanz.test.ts src/uemsMessstelle.test.ts src/uemsMessstelleFormel.test.ts src/gesamtwert.test.ts)
```

## Die Richtung ist JE TYP eine Regel (E1)

| `formel_typ` | Ergebnis | Woher |
|---|---|---|
| `gewichtete_summe` | gemeinsame Richtung, sonst `richtungslos`, sonst `groessen_gemischt` | `formelGroesse` — unverändert PR #688 |
| `rest` | **fest** Wirkenergie · **Bezug** · kWh (Live-Wert: Wirkleistung · `richtungslos`) | `BilanzAbleitung.richtung` |
| `saldo` | **fest** Wirkenergie · **saldiert** · kWh — nur `art = berechnet` | `BilanzAbleitung.richtung` fragt den Katalog |

⚠ **Nie aus den Vorzeichen ableiten.** Eine Differenz aus gleichgerichteten Eingängen (Bezug + ·
Bezug − · Bezug −) behält ihre Richtung Bezug; dieselben Terme als `gewichtete_summe` wären ein Netto
ohne Katalog-Richtung (`groessen_gemischt`, Grund `richtung`). Genau daran scheiterte die Abnahme vor
E1 — F1 trägt beide Prüfungen nebeneinander.

## Der Kundensatz: eine Differenz ist eine Differenz

Der Rest heißt „nicht zugeordnet“, **nie „Verlust“**, und nennt keine Ursache. Die Sätze sind
wörtlich die Vorlagen aus `saetze` der Vektor-Datei und stehen als Konstanten in beiden Zwillingen
(`SATZ_REST_ZUGEORDNET` · `SATZ_REST_NEGATIV` · `SATZ_REST_KEINE_WERTE`); die Tests halten sie an der
Datei fest:

- `{menge} {einheit} sind keiner Messstelle zugeordnet`
- `Messwerte passen nicht zusammen ({menge} {einheit})` — negativ gezeigt (U+2212), nie geklemmt
- `nicht zugeordnet: keine Werte` — ein nicht vollständiger Eingang macht die Differenz zu „keine
  Werte“, nie zu einer zu hohen Teil-Differenz (die Summe dagegen rechnet weiter: „mindestens …“)

## Die Katalog-Regel: `saldiert` nur berechnet — und die Box merkt nichts

- `saldiert` steht als **`richtungenNurBerechnet`** am Katalog-Eintrag der Wirkenergie, **nicht**
  unter `richtungen`. `groessePruefen(medium, g)` ohne Art urteilt wie vorher und wie die
  Datenbank-Funktion `messstelle_groesse_im_katalog` (`saldiert` → Grund `richtung`); nur mit
  `art = berechnet` ist er zulässig. Eine gemessene Messstelle bekommt ihn nie.
- ⚠ **Nicht der Messpunkt-Katalog.** Das ist der Größen-Katalog der MESSSTELLE (`messstelle.md` §2).
  `catalog/measurement-points`, `MeasurementCatalog.VERSION` und der Laufzeitstand der Box
  (`RUNTIME_VERSION`) sind unberührt — keine Feld-Box sperrt deshalb Messwerte.
- ⚠ **`$defs/richtung` im Schema bleibt, wie es war.** `MesskanalAbbildungTest` hält es gleich den
  Richtungswörtern der Messkanäle, `MessstelleSchnittstelleVertragTest` gleich der OpenAPI
  (`MessGroesse`), `MessstelleMigrationTest` fährt sein Kreuzprodukt gegen die DB-Funktion. Darum
  steht `saldiert` in einem EIGENEN `$defs/richtungNurBerechnet`, und `groesse.richtung` ist
  `anyOf` beider.
- ⚠ **Gespeichert werden kann eine `saldo`-Messstelle noch nicht:** `POST …/messstellen/berechnet`
  lehnt `formel_typ` ≠ `gewichtete_summe` ab, der CHECK von `messstelle_formel_fassung.formel_typ`
  und `messstelle_groesse_im_katalog` kennen die neuen Wörter nicht. Wer den ersten Schreibweg baut
  (IP-9 Rest anlegen, IP-16 Assistent), braucht dafür eine Migration.

## Die Terme eines `rest` kommen je Tag aus der Stellung (E3)

`MessstelleFormelRegeln.speichertTerme("rest")` ist `false`. `BilanzAbleitung.restAusStellung(
hauptzaehler, tag, stellungen)` leitet die Terme ab: X muss an dem Tag Hauptzähler Bezug sein (sonst
`rest_ohne_hauptzaehler`); Zufluss/Abfluss sind X, Erzeuger, Speicher (beide Anteile) und der
Hauptzähler Abgabe DESSELBEN Systems; zugeordnet sind genau die Unterzähler VON X (Unter-Unterzähler
nicht doppelt). Die Vektor-Regel `rest_aus_stellung` liest die Stellungen aus
`uems-referenzunternehmen.json` (TS-Helfer `src/test/uemsReferenzStellungen.ts`), und jede Fassung
mit Termen ist genau die Eingangsmenge einer `rest`-Prüfung desselben Falls — so rechnet F7 (Umzug
MS-08 am 01.03.2027) ohne angefasste Formel. ⚠ Gebaut ist nur der Rest eines Hauptzählers; den
eigenen Rest eines Unterzählers mit Unterzählern (§4.3 Satz 2) hat das Referenzunternehmen nicht.

## Die Portal-Fläche von PR #689 rechnet zeichengleich

`uemsMessstelleFormel.ts` hat nur Zeilen dazubekommen (`git diff origin/uems` ohne `-`-Zeile);
`gesamtwert.ts`, `gesamtwertQuelle.ts` und ihre Tests sind unverändert und grün; für JEDEN Größen-Fall
von `messstelle-formel-vectors.json` ist `hauptgroesse("gewichtete_summe", …)` gleich `formelGroesse`
und dem Vektor (auch `netto-ohne-richtungslos-im-katalog-abgelehnt`). ⚠ `uemsBilanz.ts` importiert
`uemsMessstelleFormel.ts` und umgekehrt: auf oberster Ebene darf `uemsMessstelleFormel.ts` darum
keinen Wert aus `uemsBilanz.ts` lesen. Im Bundle landet `uemsBilanz.ts` nicht (tree-shaking); der
Index-Chunk wächst nur um das Katalog-Feld und die Art-Prüfung.
