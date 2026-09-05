# Eine Batterie OHNE gekoppeltes BMS: das SoC-Gate wird PRÄZISE, nicht weich

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 27).


Live-Fall Mühlfeldweg 2 (21.08.2026): ein Deye-Hybrid mit Eigenbau-Batterie, deren
BMS nicht am Wechselrichter hängt. `0x024C` liest dauerhaft exakt 0, alles andere
(Spannung/Strom/Leistung/Temperatur) einwandfrei — `deye-decode.decode()` verwarf
damit JEDE Lesung, die Anlage blieb für immer stumm und war nicht anlegbar.

- **`decodeVerbose()` sagt jetzt, WAS es verworfen hat** (`drop = {channel, rule,
  raw, value}`), und `decode()` ist seine dünne Hülle. Die drei Regeln:
  **`no_answer`** (der ganze Messblock 0 = die dokumentierte Leerantwort des
  Loggers, der Juli-2026-Fall) · **`out_of_range`** (Wert ausserhalb (0,100] = ein
  kaputter/verschobener Rahmen) · **`missing`** (`blockAlive()`: irgendein
  Nicht-SoC-Register des Familien-Maps ist ungleich 0, UND der Ladestand liest
  exakt 0 = das BMS meldet nichts).
- **Nur `missing` ist übergehbar**, und nur mit dem Opt-in
  `connection.allow_missing_soc` — die Lesung wird dann OHNE `soc_pct` behalten,
  nie mit einer erfundenen 0, also bleibt der SoC-Achsen-Spike strukturell
  unmöglich. Die anderen zwei verwerfen weiterhin alles, **auch mit Opt-in**.
- **Seit dem 24.08.2026 kann derselbe Fall den Ladestand aus der GEMESSENEN
  Batteriespannung SCHÄTZEN** (`connection.soc_from_voltage = {v_empty, v_full}`,
  die zwei Eckpunkte aus dem Datenblatt; Register `0x024B` hybrid_3p mit der
  `[0,01/0,1]`-LV/HV-Skala, `0x00B7` hybrid_1p ×0,01 — der hybrid_3p-Leseblock ist
  dafür um EINE Adresse nach unten auf `0x024B..0x02C4` (122 Register) geweitet).
  Vier Regeln, alle mutationsgeprüft: nur bei `missing`, nie über einen echten
  BMS-Wert, auf **`[1,100]` geklemmt** (die exakte 0 ist die Leerantwort-Signatur,
  die beide Tore verwerfen — eine geschätzte 0 wäre unveröffentlichbar), und eine
  unlesbare/0-Spannung schätzt NICHTS.
  - **⚠ DIE SICHERHEITS-AUSSAGE: eine Schätzung schaltet NIE die Steuerung
    scharf.** Der Verbindungstest setzt das Opt-in nie (`test-read.js`) und meldet
    den fehlenden Kanal UNVERÄNDERT — er trägt die Schätzung nur additiv als
    `finding.estimate` daneben (Vertrag `mqtt-probe.schema.json`). Die Komponente
    braucht damit weiterhin die ausdrückliche Zustimmung, behält ihren
    `reading_override`-Stempel, und `ControlCertificationService.activate` lehnt
    unverändert ab: die SoC-Klemme von `guards.Clamp` läuft nie auf einer groben
    Schätzung (bei LiFePO4 ist die Kennlinie im mittleren Bereich fast flach).
  - **⚠ `blockAlive` urteilt bewusst NICHT über `battVolt`** — die
    no_answer/missing-Grenze bleibt exakt, was sie war (ein Nachtblock, dessen
    Leistungskanäle alle 0 sind, während der Pack Spannung hält, ist weiterhin die
    Leerantwort). Widerum eine Regel, die man beim Aufräumen zerstören würde.
  - **⚠ Die Zahlen-Grenzen leben DREIMAL** (api `SocFromVoltageBounds`, Box
    `inverter.SocFromVoltage.validate`, Portal `src/socSchaetzung.ts`) — das
    LAN-Regel-Muster. **Alle drei zusammen ändern.** Das Band ist bewusst weit
    (10..1000 V), weil weder api noch Box die Bauart besser kennen als der Kunde.
  - Eingetragen wird sie im PORTAL (Anlege-Assistent, im „Trotzdem
    fortfahren"-Kasten); auf `:8484` gibt es bewusst KEIN Feld dafür.
- **⚠ `blockAlive` urteilt NIE über das Identitäts-Register `0x0000`** — ein
  Logger kann es aus dem Cache beantworten, während der Messblock tot ist.
- **Der Weg des Flags** (ohne ihn wäre das Opt-in wirkungslos, weil das Gate im
  DECODER sitzt): Portal → `driver.connection` im Registry-Push →
  `inverter.Connection.AllowMissingSoc` → `Selection.BusPayload()` bzw.
  `sources.busEntry()` → `edge/inverter/config` → Router (`inverter-routing.js`,
  `build-flows.js`) → Decode-Config. `Normalize` LÖSCHT es für jeden anderen
  Transport an EINER Stelle (neben der `Channel`-Regel) — jeder andere Decoder
  lässt einen unplausiblen Kanal ohnehin weg, statt die Lesung zu verwerfen.
- **Der Verbindungstest wird ehrlich, nicht nachsichtig:** `test-read.js` gibt bei
  einem Drop `reading` (die übrigen Kanäle) UND `finding` zurück; der Kern reicht
  beides über `testconn.Result.Finding` in den Probe-Kanal
  (`probe.FailedReading`). Der TEST selbst setzt das Opt-in NIE — er sagt immer
  die Wahrheit, und ob sie hinnehmbar ist, entscheidet der Mensch im Portal.
- **⚠ Die BOX-OBERFLÄCHE zeigt den Befund seit dem 24.08.2026 auch** (Diagnose
  `vp-wr-eigenbau-soc-d4`): sie BERECHNETE die ganze Diagnose und lieferte sie
  über `POST /api/test-connection` aus — `verify.js` las im Fehlerzweig aber nur
  `error_code`+`message` und warf `reading` UND `finding` weg, also stand vor dem
  Installateur der feste, ursachenlose Zweizeiler „Verbindung ok, aber die Werte
  ergeben keinen Sinn. Bitte Modell/Anschluss prüfen." — im `missing`-Fall
  nachweislich FALSCH (Modell und Anschluss stimmen, das BMS fehlt). `verify.js`
  hat dafür die reine `VP.fehlerAnsicht(res)`: gelesene Werte (`readingChips`,
  dieselben Chips wie das Erfolgs-Panel) → benannter Befund (`befundText`) → der
  Weg (`portalWegText`).
- **⚠ ZWILLING: `verify.js befundText` ⟷ `frontend/portal/src/komponentenAssistent.ts
  regelText`** — dieselben Sätze, zwei Laufzeiten, KEIN geteilter Code (derselbe
  Mensch liest beide Flächen, derselbe Gerätezustand darf dort nicht anders
  heißen). **Beide zusammen ändern**; die Vektoren sind beidseitig gepinnt
  (`internal/web/jstest/ui.test.js` ⟷ `komponentenAssistent.test.ts`). Ein
  unbekanntes (Kanal, Regel)-Paar erzeugt KEINEN Satz.
- **⚠ Die Box VERWEIST, sie entscheidet nicht:** `portalWegText` gibt bei
  `rule === 'missing'` genau einen Satz („… im VoltPilot-Portal anlegen — nur
  lesend."), bei jeder anderen Regel NICHTS. Es gibt auf `:8484` weiterhin kein
  „Trotzdem fortfahren" und kein Setzen von `allow_missing_soc` — die
  Design-Grenze bleibt, nur ihre Unsichtbarkeit fällt weg.
- **Beweise:** `deye/deye-decode.test.js` · `flows-sync.test.js` (die INLINE-Kopie
  im Flow stimmt in allen drei Fällen mit dem Modul überein) ·
  `internal/probe` (Kontrakt-Fixture per PFAD) · `agent/testconn_test.go` ·
  `internal/web/jstest/ui.test.js` (die sechs Fälle der Fläche, mutationsgeprüft)
  · `internal/web/web_test.go` (//go:embed-Vertrag: die drei Anker reisen wirklich
  mit dem Binär).

