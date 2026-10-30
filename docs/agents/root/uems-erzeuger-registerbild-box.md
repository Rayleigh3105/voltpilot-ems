# Erzeuger am WAGO: Box-Leser „Erzeuger-Registerbild“ (EZ-5)

Neu am 21.10.2026, Paket EZ-5 des Konzepts „Erzeuger am WAGO-Modbus-Server“ (Entscheide EW-4 A, EW-5 A,
EW-17 A, Abgleich EZ-1 A1/A2 und Lesarten 1–12). Die Box liest das VoltPilot-Registerbild Erzeuger v1
(schlanke Fassung 1.0) einer Anlagensteuerung und liefert Messpunkte, Qualität und Ereignisse — **nur lesen**,
nichts in Sonnenstrom-Logik oder Steuerung (Verbraucher sind EZ-17). Seit EZ-17 Scheibe 1 (27.10.2026) geht die
Lesung auch in die **Standortbilanz** einer Box ohne Wechselrichter (unten „Standort-Sample“).
Mit dem Box-Leser ging die Katalogfamilie aus EZ-6 an die Box: **Laufzeitstand 2026.10.21.1** (gleich dem
Inhaltsstand), Metadaten `V20261021234700`, wirksam mit dem Box-Release, das diese Palette trägt.

## Aufbau (gebaut wie `wago_registerbild`)

- `edge-app/nodered/measurements/erzeuger-registerbild.js` — der **Leser**: Kopf in der Prüfreihenfolge des
  Vertrags (`zu_wenig_woerter` → `signatur_fremd` → `version_fremd` → `wortfolge_falsch` →
  `te_anzahl_ungueltig` → `zu_wenig_woerter`), dann das Soll (`te_anzahl_abweichend`,
  `steuerung_id_abweichend`, `anlagenart_abweichend`); je Wert Gültigkeitsbit → Typ-Maximum → Vokabular
  (Gründe `gueltigkeit`, `ungueltig`, `fremd`). `FELDER` trägt Adresse, Typ, Punkt, Melde-Klasse und Totband;
  `planeAnfragen` (bis 8 Einheiten eine Anfrage, nie ein Block geteilt), `liesNamen`, `kopfBericht` (Probe).
  Punkte = Feldnamen wie im Katalog: `erzeuger.kopf.{te_anzahl,programmstand,steuerung_id,anlagenart}`,
  `erzeuger.a.*`, `erzeuger.nb.*`, `erzeuger.dv.*`, `erzeuger.wirkung.*`, `erzeuger.te[n].*` (n ab 1).
- `erzeuger-ereignisse.js` — die **Stufe**: `stale` ab der dritten gleichen Lesung (die `HerzschlagWacht` des
  WAGO-Wegs mit `stehtAb: 2`), `uncertain` für `p_nvp_w`, wenn `a_alter_s` über `veraltet_netzpunkt_s`
  liegt, `frozen_source` einmal je Episode, `device_restart` beim Rücksprung.
- `erzeuger-meldung.js` — die **Melde-Regel**: schnelle Größen mit Totband, Zustände/Bitfelder bei jeder
  Änderung, Zähler im Takt; `cadence_s` der Auswahl ist der **längste Abstand** zweier Werte.
- `measurement-planner.js` (`erzeugerbilderJeZiel` liest `erzeuger_registerbilder`: `anlagenart` pv/bhkw/gemischt
  → 1/2/3, `steuerung_kennung` nur wenn da; `groupErzeugerbild`; Vorlage `te[*]` → die Einheiten des Solls),
  `measurement-driver.js` (`te[n]` aus der Vorlage konkret), `measurement-runtime.js`
  (`erzeugerSample`, `erzeugerLesung`), `vp-measurements.js`
  (`modbusFunktionscode`), Budget-Klasse `erzeuger_registerbild` in `measurement-budget-vectors.json`
  (400 ms, 8 Einheiten je Anfrage).
- Go-Kern: `measurements.Erzeugerbild` (Feld `erzeuger_registerbilder`, Form der Cloud), Probe-Op `erzeuger_kopf`
  (`internal/probe`, `agent/probe.go` `erzeugerKopfResult`), `BuiltSupports` meldet `erzeuger_registerbild`.
- Palette: `vp-modbus-probe.js` `runErzeugerKopf` liest Kopf, Einheiten-Blöcke und Namen in Teilen
  dokumentierter Länge.
- `:8484`: die Kopplung hängt an keinem Gerät; die frühere Wahl „Diese Box liest eine Anlagensteuerung“
  (`POST /api/onboarding/anlagensteuerung`) ist mit der Sperre entfallen. Eine alte
  `<DataDir>/onboarding-anlagensteuerung` liest niemand mehr.

## Standort-Sample (EZ-17 Scheibe 1, 27.10.2026)

Befund Gore „Neue Halle“: das Cockpit zeigte die Jetzt-Werte aus `device_measurement_sample`, Verlauf › Energie,
„Heute · kWh“ und die Energiebilanz blieben leer — das v1-Standort-Sample der Box (die EINE Quelle von `telemetry`,
`telemetry_rollup_15m` und Verlauf) entstand nur aus einem Wechselrichter-Sample auf `edge/telemetry` plus den
Rollen `pv-generation`/`grid-meter`, und die Rolle `plant-controller` las kein Fold.

- `measurement-runtime.js` `erzeugerQuelle`: nach jeder **erkannten** Lesung dieselbe Quellen-Nachricht wie jede
  andere Quelle auf `edge/sources/<pin>/telemetry` — `pv_power_kw` aus `p_erzeugung_w`, `power_kw` aus `p_nvp_w`
  (kW, +Bezug/−Einspeisung, Zeit der Lesung), im Takt der Lesung, unabhängig von der Melde-Regel der Samples. Nur
  `good` wird Kanal: `stale`, `uncertain` (Netzpunkt zu alt), ungültig oder ungedeckt lässt den Kanal weg, nie 0;
  Eigenbedarf (`p_erzeugung_w` < 0) ist Verbrauch, `pv_power_kw` floor 0.
- Go-Kern `agent.plantControllerSample` (aus `onSourceTelemetry`): auf einer Box **ohne Wechselrichter** nimmt die
  Lesung den Platz des Wechselrichter-Samples in `foldSiteSample` ein — derselbe Fold (Quellen-Summe, Tore, Puffer,
  Ring, Spiegel, Zustand), Hauslast = Standardbilanz pv + grid − Batterie mit Batterie 0 als Tatsache des Bilds.
  Fehlt ein Kanal, fehlt er im Sample (Büttner ohne Netzpunkt: PV ohne Last). Neben einem Wechselrichter bleibt die
  Lesung außerhalb der Bilanz (einmal geloggt).
- ⚠ **Palette und Kern gehören zusammen:** ein alter Kern ignoriert die Nachricht (Rolle ungelesen), eine alte
  Palette sendet keine — wirksam erst mit dem Box-Release, das beides trägt. Rückwirkend entsteht nichts.
- Nachweise: Go `plant_controller_sample_test.go`, Node-RED `erzeuger-laufzeit.test.js` („Quellen-Telemetrie“).

## Fallen

- ⚠ **Der Leser deutet nach dem Bild, nicht nach dem Katalog.** Die Box erkennt einen Punkt an
  `source_kind: erzeuger_registerbild` oder der Familie und liest Adresse/Typ/Faktor aus `FELDER`; gekoppelt
  sind Katalog (EZ-6) und Leser über die **Punktnamen**. Der Test „die Box-Sicht des Katalogs führt genau die
  Punkte des Lesers - an derselben Adresse“ hält Namen, Offsets, Breiten und Faktoren zusammen.
- ⚠ **Laufzeitstand gehoben = api-Deploy und Box-Release gehören zusammen.** Ab dem api-Deploy lehnt eine Box
  mit älterer Palette jede Mess-Konfiguration ab (`unsupported_catalog`). Mitgezogen: Palette, Metadaten,
  Kernspiegel (`runtime_catalog_versions`, beide Kopien), die festgenagelten Konfig-Beispiele, `strecke-seed.sql`,
  Portal-Zwilling `registerFamilie.ts`. Die Simulator-Abnahme (`tools/edge-simulator`, `KATALOGSTAND`,
  NW6-Vorlage) bleibt auf 2026.09.23.3 bis zum nächsten Abnahmelauf (`make abnahme`).
- ⚠ **Gelesen wird alle 5 s, egal welche Kadenz eine Auswahl nennt.** Das Budget zählt je Punkt einen Wert je
  `cadence_s` (Katalog: 5 s für Leistungen und Zustände, 60 s für Zähler und Kennzahlen) und je Bild 12 bzw. 24
  Anfragen je Minute; Werte über der Untergrenze (Totband,
  Änderung) deckelt das Sample-Fenster der Laufzeit (600/min). Unter 5 s gibt es keine Erzeuger-Kadenz
  (`min_cadence_s`).
- ⚠ **Eine nicht lesbare Lesung ist keine Herzschlag-Beobachtung** (Vertrag §8); ein Soll-Grund lässt das Bild
  lesbar, sein Herzschlag zählt. Ein Lesefehler liefert keinen Wert und meldet den Quellenstatus — `data_gap`
  bildet der Writer, ein Treiber-`data_gap` weist der Kern ab.
- ⚠ **Namen sind keine Messpunkte** (Katalog EZ-6): Netzbetreiber, Direktvermarkter und Typ je Einheit liest
  nur die Probe `erzeuger_kopf` (Anlege-Schritt); die Cloud speichert sie als Vorbelegung. Ein leerer Name ist
  `""` („keiner“), ein nicht gelesener fehlt.
- ⚠ **Mischbetrieb:** ein Kern ohne das Feld lehnt eine Konfiguration mit `erzeuger_registerbilder` ganz ab
  (`DisallowUnknownFields`) — die Cloud sendet es nur an eine Box mit dem Wort `erzeuger_registerbild`.
- Abgleich bei Bau: der Leser stimmt mit den EZ-1-Vektoren (20 Fälle) und den EZ-2-Simulatorfällen (9) überein;
  EZ-2 nennt den Wortfolge-Grund noch `wortfolge_abweichend` (WAGO-Wort), der Vertrag `wortfolge_falsch`.

## Nachweise

`erzeuger-registerbild.test.js` (Vorlage ⟷ Leser, Gore, Büttner, Fehlerfälle, Stufe, Melde-Regel),
`erzeuger-laufzeit.test.js` (Ende zu Ende über den Modbus-Weg der WAGO-Bühne), `vp-palette/test/erzeuger_kopf_spec.js`
(Mocha, `npm test`), Go `measurements` (`TestErzeugerbild*`), `probe` und `agent` (`*ErzeugerKopf*`),
`web` (`TestTheRetiredAnlagensteuerungChoiceIsGone`), `jstest/ui.test.js`.
