# Der AUSWEG aus der Sackgasse: eine Anlage OHNE Ladestand ist anlegbar (nur lesend)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 24).


Live-Fall Mühlfeldweg 2 (21.08.2026, Scout `data/vp-am3-registerkarte-v2`): ein Deye
SUN-30K-SG02HP3-EU-AM3 mit EIGENBAU-Batterie, deren BMS nicht am Wechselrichter hängt. Das
SoC-Register liest dauerhaft exakt 0, während Spannung, Strom, Leistung und Temperatur
einwandfrei ankommen. Der Verbindungstest lehnte deshalb ab — mit einem nackten „die Messwerte
sind unplausibel", OHNE eine einzige Zahl —, „Weiter" blieb tot, und die Anlage war nicht
anlegbar. **Alles ist ADDITIV: ohne den Klick verhält sich jede Anlage zeichengleich wie vorher.**

- **⚠ DIE PLAUSIBILITÄTSREGEL WURDE NICHT AUFGEWEICHT — sie wurde PRÄZISE.** `deye-decode.js`
  unterscheidet jetzt DREI Fälle statt eines (`decodeVerbose` → `drop.rule`): **`no_answer`** = der
  ganze Messblock ist 0, die dokumentierte Leerantwort des Loggers (der Juli-2026-Fall) ·
  **`out_of_range`** = ein Wert ausserhalb (0,100], also ein kaputter/verschobener Rahmen ·
  **`missing`** = der Block LEBT nachweislich (`blockAlive`: irgendein Nicht-SoC-Register des
  Familien-Maps ist ungleich 0) und NUR der Ladestand liest exakt 0. Die ersten beiden verwerfen
  weiterhin die GANZE Lesung — **auch mit Opt-in**; nur der dritte ist übergehbar.
- **Das Opt-in ist `connection.allow_missing_soc`, gesetzt AUSSCHLIESSLICH vom Server.** Der Client
  kann es nicht mitschicken (`ComponentService.SERVER_OWNED_CONNECTION_KEYS` entfernt es vor dem
  Fingerabdruck). Es reist über den bestehenden Registry-Push (`driver.connection`) →
  `inverter.Connection.AllowMissingSoc` → `BusPayload`/`sources.busEntry` → Router → Decode-Config.
  **Ohne diesen ganzen Weg wäre die Anlage nach dem Anlegen trotzdem stumm** — der Decoder ist die
  Stelle, an der das Gate sitzt. Solarman-V5 (Deye) only: jeder andere Decoder LÄSST den Kanal
  ohnehin weg statt die Lesung zu verwerfen (`Normalize` löscht das Feld für jeden anderen
  Transport, an EINER Stelle neben der `Channel`-Regel).
- **Der Test wird EHRLICH, nicht nachsichtig.** Der Vertrag `mqtt-probe.schema.json` trägt additiv
  `op_result.finding` (`channel`/`rule`/`raw`/`value`) und erlaubt das `reading` AUCH auf einer
  abgelehnten `test_connection`-Zeile — `raw`/`value` der ZEILE bleiben weg (die gehören einer
  Register-Lesung). Fixture: `examples/mqtt-probe.valid.test-connection-implausible.json`, per PFAD
  vom Go-Parser gelesen. Der Ingest verwirft ein Wort ausserhalb des Vokabulars UND mit ihm die
  Werte: Zahlen ohne benannte Ursache sind Zahlen, denen niemand trauen kann.
- **Die ZUSTIMMUNG ist benannt, nicht pauschal.** `component-test` hinterlegt bei einem solchen Lauf
  einen HALBEN Beleg (`ComponentConnectionReceipts.recordOverridable`, der Kanal kommt aus dem
  Ergebnis der Box), und `SaveComponentRequest.acceptMissingChannel` muss GENAU diesen Kanal nennen,
  sonst 422. Der Beleg wird gestempelt als `connection.reading_override`
  (`channel`/`accepted_at`/`accepted_by`/`origin`) — das `switch.freigabe`-Muster der Stufe 4, also
  trägt die Fassungs-Historie ihn ohne Zutun mit; `origin` kommt aus den Realm-Rollen
  (`kunde`|`voltpilot`), nie aus dem Rumpf.
- **Seit dem 24.08.2026 hat derselbe Fall einen ZWEITEN Ausweg: den Ladestand aus der GEMESSENEN
  Batteriespannung SCHÄTZEN** (Batteriemodus „User defined" / „Use battery voltage" - dort hängt
  gar kein BMS am Wechselrichter, siehe Mühlfeldweg 2). Der Betreiber trägt die zwei Eckpunkte des
  Speichers ein (`connection.soc_from_voltage = {v_empty, v_full}`, aus dem Datenblatt), und der
  Decoder interpoliert die Klemmenspannung linear dazwischen (`0x024B` auf `hybrid_3p` mit
  derselben `[0,01/0,1]`-LV/HV-Skala wie PV/Batterie-Leistung, `0x00B7` ×0,01 auf `hybrid_1p`; der
  hybrid_3p-Leseblock ist dafür um EINE Adresse nach unten auf `0x024B..0x02C4` (122 Register)
  geweitet - jede Feldadresse bleibt, wo sie war). Die Kette ist die des Opt-ins: Portal →
  `ComponentService` → `inverter.Connection.SocFromVoltage` → `BusPayload` / `sources.busEntry` →
  `inverter-routing.js` → `deye-decode.js`.
  - **⚠ DIE SICHERHEITS-AUSSAGE ist KONSTRUKTIV: eine Schätzung schaltet NIE die Steuerung
    scharf.** Der Verbindungstest setzt das Opt-in nie (`test-read.js`) und weist den fehlenden
    Kanal UNVERÄNDERT aus - die Schätzung reist nur ADDITIV als `finding.estimate` daneben (Vertrag
    `mqtt-probe.schema.json`, `{soc_pct, voltage_v}`, nur zur Regel `missing`). Also braucht die
    Komponente weiterhin die ausdrückliche Zustimmung, behält ihren `reading_override`-Stempel, und
    `ControlCertificationService.activate` lehnt unverändert mit demselben deutschen Grund ab. Bei
    LiFePO4 ist die Zellkennlinie zwischen ~20 % und ~90 % nahezu flach, und unter Last verschiebt
    der Innenwiderstand sie zusätzlich - die SoC-Klemme von `guards.Clamp` darf darauf nie
    scharfgeschaltet werden.
  - **⚠ Vier Regeln im Decoder, alle mutationsgeprüft:** nur bei `missing` (`no_answer` und
    `out_of_range` verwerfen weiterhin ALLES, auch mit Opt-in), nie über einen echten BMS-Wert, auf
    **`[1,100]` geklemmt** (die exakte 0 ist die Leerantwort-Signatur, die `socPlausible` UND
    `guards.SocPlausible` verwerfen - eine geschätzte 0 wäre unveröffentlichbar), und eine
    unlesbare oder auf 0 stehende Spannung schätzt NICHTS. `blockAlive` urteilt bewusst NICHT über
    die Spannung, damit die no_answer/missing-Grenze exakt bleibt, was sie war.
  - **⚠ Die Zahlen-Grenzen leben DREIMAL** (api `SocFromVoltageBounds`, Box
    `inverter.SocFromVoltage.validate`, Portal `src/socSchaetzung.ts`) - das LAN-Regel-Muster;
    **alle drei zusammen ändern.** Das Band ist bewusst weit (10..1000 V, Mindestabstand 0,5 V),
    weil weder api noch Box die Bauart besser kennen als der Kunde: gefangen wird nur, was gar
    keine Batterie sein kann (Millivolt, ein Prozentwert, eine Ziffer zu viel).
  - **KEIN Cloud-Telemetriefeld.** `mqtt-telemetry.schema.json` ist `additionalProperties:false`
    und eingefroren; die Herkunft steht deshalb auf dem LOKALEN Bus (`soc_source: "voltage"`, vom
    Go-Core ignoriert) und - dauerhaft für jede Cloud-Fläche - in der gespeicherten
    `connection.soc_from_voltage`. Eingetragen wird sie im Portal-Assistenten im selben Kasten wie
    „Trotzdem fortfahren"; auf `:8484` gibt es bewusst KEIN Feld (die `allow_missing_soc`-Regel).
- **⚠ Die STEUERUNG dieser Anlage bleibt AUS, server-seitig.**
  `ControlCertificationService.activate` fragt `ControlCertificationRepository.missingReadingChannel`
  und verweigert mit deutschem Grund: ohne Ladestand ist die SoC-Klemme von `guards.Clamp` blind,
  und ein Prüfstandslauf ändert daran nichts. **Der Weg zurück ist selbstheilend:** der Stempel
  wohnt in der Anbindung, verschwindet also, sobald die Komponente nach einem VOLLSTÄNDIGEN Test neu
  gespeichert wird — niemand muss ein Flag zurücksetzen. Ein Opt-in „steuern ohne SoC" wurde bewusst
  NICHT gebaut (es bräuchte Spannungs-Wächter statt der SoC-Klemme; eigener Entscheid).
- **⚠ Nebenbefund, mitgefixt, weil der Rückweg darüber läuft:** `ComponentService.update` verglich die
  KUNDEN-Rolle des Rumpfs (`inverter`) zeichenweise mit der gespeicherten Rolle der komponierten
  Zeile (`battery-hybrid`) — ein Wechselrichter liess sich damit NIE bearbeiten, jedes `PUT` endete
  im 409 „die Art lässt sich nicht ändern". `sameRole` übersetzt jetzt über `ROLE_ENTITY_TYPE`; eine
  echte Umwidmung bleibt ein Konflikt.
- **Katalog:** die AM3-Baureihe (`SUN-25/29.9/30K-SG02HP3-EU-AM3`) ist `hybrid_3p`-kompatibel und im
  Deye-Katalog (`inverter.go` + `DEYE.md` + regeneriertes `builtin.json`, 44 → 47 Vorlagen). Die
  SoC-0-Lage ist dort als GERÄTEZUSTAND vermerkt, nicht als Kartenabweichung.
- **Beweise:** Node `deye/deye-decode.test.js` (+18: der Mühlfeldweg-Block, die drei Regeln, „das
  Opt-in rettet weder Leerantwort noch kaputten Rahmen", Byte-Gleichheit ohne Opt-in,
  `blockAlive` ignoriert das Identitäts-Register - dazu die SCHÄTZUNG: Klemmung auf [1,100],
  LV/HV-Skala auch auf der Spannung, hybrid_1p ohne Block-Weitung, unsinnige Paare schätzen
  nichts, „ein echter SoC gewinnt", `blockAlive` urteilt nicht über die Spannung) +
  `flows-sync.test.js` (+10: die INLINE-Kopie stimmt in allen drei Fällen UND in allen
  Schätz-Fällen mit dem Modul überein - mutationsgeprüft) · Go
  `internal/inverter/socvoltage_test.go` (5) · api `SocFromVoltageBoundsTest` (6) +
  `ProbeResultListenerTest` (+2) +
  `ComponentApiTest.theVoltageEstimateReachesTheBoxButNeverUnlocksBatteryControl` · Portal
  `socSchaetzung.test.ts` (12) + `AnlegenFlow.test.tsx` (+4) · Go `internal/probe` (die Fixture per PFAD) +
  `agent/testconn_test.go` (+2: der Befund reist durch Kern und Probe-Kanal; ein Fehlschlag OHNE
  Befund trägt weiterhin nichts) · api `ProbeResultListenerTest` (+4) +
  `ComponentConnectionReceiptsTest` (+2) + `ComponentApiTest` (7, echte DB + Keycloak: ohne
  Zustimmung 422, falscher Kanal 422, gespeichert mit Opt-in + Beleg im Push, Scharfschalten 409 mit
  Grund, und der selbstheilende Rückweg) · Portal `komponentenAssistent.test.ts` (+9),
  `AnlegenFlow.test.tsx` (+4), `control.test.ts` (+3),
  `AnlagenModellSection.test.tsx` (+2). Im echten Chrome bei 1440 und 375 durchgespielt: 0 px
  horizontaler Überlauf, 0 überstehende Elemente, keine Konsolenfehler.

