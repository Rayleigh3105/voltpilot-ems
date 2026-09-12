# UEMS-Bezugsdaten-Vertrag: eine Wahrheit, zwei Prüfungen (Java ⟷ TypeScript)

Neu angelegt am 12.09.2026 (AP-09 IP-1, das erste Bau-Paket der Bezugsgrößen — die Datei, gegen
die IP-3 … IP-19 gebaut werden).

- **[`docs/contracts/v2/bezugsdaten.md`](../../contracts/v2/bezugsdaten.md)** — der Vertrag in
  Prosa: warum es zwei Umsetzungen gibt, die dreizehn Regeln, die Fallen, was NICHT hier steht.
  Ausdrücklich KEINE zweite Regelbeschreibung: wo Text und Vektor-Datei sich widersprechen, gilt
  die Datei.
- **[`bezugsdaten-vectors.json`](../../contracts/v2/bezugsdaten-vectors.json)** +
  **[`bezugsdaten.schema.json`](../../contracts/v2/bezugsdaten.schema.json)** — 14 handgerechnete
  Fälle (B1–B14) im Referenzunternehmen Ahrenberg mit 78 Prüfungen, dazu die Vokabulare, die
  Einheiten je Größe, die Umrechnungsfaktoren, die Kundensätze je Befund und die Schwellen.
  Erzeugt aus `data/vp-uems-ap09-bezugsgroessen/referenzfaelle.json`, nicht abgeschrieben.
- **Java:** `services/api/.../uems/BezugsdatenRegeln` (rein: ohne Spring, ohne DB, ohne Uhr) +
  `BezugsdatenVectorsTest` (`@TestFactory`, Schema über den geteilten `uems/UemsSchemaLaeufer`).
- **TypeScript:** `frontend/portal/src/bezugsdaten.ts` + `bezugsdaten.test.ts` (Schema über
  `src/test/uemsSchemaLaeufer.ts`).
- ⚠ **Seit AP-09 IP-3 wohnen die Regeln `einheit` und `periode`/`zeit`/`stunden` in eigenen
  Modulen** (`uems/BezugsEinheit`, `uems/BezugsPeriode` ⟷ `bezugsEinheit.ts`, `bezugsPeriode.ts`);
  die beiden Dateien oben RUFEN sie an. Details, Fallen und die Umrechnungsgrenze:
  [`uems-einheiten-perioden-module.md`](./uems-einheiten-perioden-module.md).

## `zwillinge` ist Teil des Vertrags

Die Datei sagt **je Regel**, welche Umsetzung sie prüft, und **je Lücke den Grund**
(`zwillinge_grund`). Neun Regeln stehen in beiden Sprachen — das ist die Vorschau, die der
Kunde sieht, bevor irgendetwas gespeichert ist: `zahl` · `einheit` · `periode` · `zeit` ·
`stunden` · `plausibilitaet` · `zuordnung` · `urteil` · `import`. Vier stehen nur in Java:
`fassung` (Fassungen, Vier-Augen und Rücknahme sind der Schreibweg des Servers), `stammdatum`
(der Stichtag wird im Lesemodell gelesen), `kanal` (die Zustandsdauer entsteht aus Rohwerten,
die das Portal nie sieht) und `menge` (die Verbrauchsregel AP-08 lebt in Java und Python).

⚠ **Beide Tests lesen diese Angabe und prüfen genau die Regeln, die sie nennt.** Wer eine Regel
ergänzt, ohne sie dort einzutragen, bricht den Test `jedeRegelIstDeklariertUndJedeLueckeBegruendet`
(Java) bzw. „jede Regel ist deklariert" (TS) — eine Regel kann also nicht stillschweigend
ungeprüft bleiben. **Beide Zwillinge sind grün** (Java 89 Tests, TS 70 Tests); es gibt keinen
roten und keinen ausgeschalteten Test. Der Bauplan sah für IP-1 rote Zwillinge vor; das wurde
bewusst nicht so gebaut — ein dauerhaft roter Test auf dem Hauptzweig verdeckt echte
Fehlschläge.

## Die Verbrauchsregel wird AUFGERUFEN, nicht nachgebaut

`BezugsdatenRegeln.mengeAblesezeitraum` reicht die beiden Ablesungen an
`VerbrauchRegeln.mengeZaehlerstand` weiter (AP-08 IP-1), und `stundenDesTages` an
`VerbrauchRegeln.stunden`. Auch die Zustandswörter `vollständig` · `unvollständig` ·
`keine Werte` sind wörtlich die der Verbrauchsregel — der Java-Test hält das fest. Zwei Zahlen
für dieselbe Aussage wären genau die Drift, die diese Verträge verhindern sollen.

## Die Fallen

- ⚠ **Die Prüfreihenfolge ist ergebnisrelevant** (`regeln.pruefreihenfolge`: Zahl → Einheit →
  Periode → Zeit → Bezug → Schlüssel). In B13 wird die Zeile mit „lbs" abgelehnt, BEVOR ihr
  Schlüssel mit der anderen Zeile derselben Datei verglichen wird; umgekehrt wären beide Zeilen
  als widersprüchliches Paar abgelehnt und die Datei hätte ein anderes Ergebnis.
- ⚠ **Die Abdeckung eines Kanal-Werts ist ZEITBASIERT** (gemessene Zeit ÷ Periodenlänge, eine
  Nachkommastelle: 23 von 24 h = 95,8 %). Die Abdeckung der Verbrauchsregel ist WERTBASIERT und
  abgeschnitten (erhaltene ÷ erwartete Werte, AP-08 Z9). Zwei verschiedene Zahlen mit demselben
  Namen — die Datei hält beide Rundungsregeln getrennt.
- ⚠ **Jeder Betrag reist als DEZIMALTEXT**, nie als Gleitkommazahl, und wird NUMERISCH
  verglichen: „312400" und „312400.0" sind derselbe Betrag. Java rechnet mit `BigDecimal`, TS mit
  einer ganzzahligen Mantisse (`Dez` = `{z: bigint, e: number}`) — `312,4 t` sind dort genau
  `312400 kg`, nicht `312399,99999999994`.
- ⚠ **`null` ist nie 0.** Eine Periode ohne gültiges Stammdatum, ein Tag ohne Werte am Kanal und
  eine zurückgenommene Fassung tragen KEINEN Betrag.
- **Ein Konflikt wird nie still ersetzt.** `entscheidung: null` heißt „noch nicht entschieden"
  (Vorschau) und ergibt das Urteil `konflikt`; „behalten" (die Vorgabe) ergibt `uebersprungen`,
  „ersetzen" ergibt `berichtigung`. Eine Zeile mit dem Urteil `berichtigung` zählt in BEIDEN
  Zählern (`konflikt` und `berichtigung`) — so steht es in §7 B3.
- **`_abweichungen`** nennt jede bewusste Abweichung von der Vorlage mit Feld, Vorlagenwert,
  neuem Wert und Grund (heute drei, alle ohne Wirkung auf ein Ergebnis). **`_nicht_geprueft`**
  nennt jede Erwartung der Vorlage, die hier steht, aber (noch) kein Zwilling nachrechnet — mit
  dem Paket, das sie einlöst. Beide Listen werden von beiden Tests auf Vollständigkeit der
  Felder geprüft.
- **`referenz_stand`:** BZ-5 „Ladezeit Ladepunkt Halle 2", die Ablesungen an MS-21 und die
  Einheiten-Kennungen stehen NUR in dieser Datei; ins Referenzunternehmen trägt sie **AP-09
  IP-2** nach.

## Es ändert sich kein Verhalten

Kein Produktionsweg ruft `BezugsdatenRegeln` oder `bezugsdaten.ts` an: keine Tabelle, keine
Migration, keine Route, keine Portal-Fläche, kein CSV-Leser. Der Messwert-Herkunftsvertrag
(`messwert-herkunft.*`) ist unberührt — E3 entscheidet, dass die Bezugsdaten einen EIGENEN
Vertrag bekommen. Dazu kamen sieben **Glossar-Nachträge** (Ablesung · Ablesezeitraum · Fassung ·
Herkunft · Import · Zuordnungs-Vorlage · Befund) und eine Verfeinerung von „Bezugsgröße“ — über
`docs/fachmodell/tools/fachmodell.py` plus `build_fachmodell.py`, nie durch Handeditieren der
erzeugten `glossar.md`.

## Wie man hier weiterbaut

```bash
# Java-Zwilling (rein, ~2 s, kein Docker)
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest=BezugsdatenVectorsTest)
# TS-Zwilling
(cd frontend/portal && npx vitest run src/bezugsdaten.test.ts)
# Glossar nach einer Änderung an fachmodell.py
python3 docs/fachmodell/tools/build_fachmodell.py --check
```

Wer eine Regel ändert, ändert **die Vektor-Datei UND beide Zwillinge** — und wer eine Regel
ergänzt, trägt sie in `zwillinge` ein.
