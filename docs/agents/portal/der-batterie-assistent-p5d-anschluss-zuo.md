# Der BATTERIE-ASSISTENT (P5d): Anschluss, Zuordnung, Kurve — und die Herkunft des Ladestands

Die Bedien-Oberfläche des BMS-unabhängigen Batterie-Anschlusses (Konzept
`vp-deye-diybms-luecke-l5` §3.2b, Bauplan-Paket P5d). Sie setzt auf P5 (Ebene 1:
Entitätstyp `user-defined-battery` + `vp.mqtt.read`) und P5b (Ebene 2:
`soc_derivation` + `vp.soc.derive`) auf; **hier entsteht kein Rechenpfad, nur
die Fläche.**

## Wo was wohnt

| Datei | Was darin steht |
|---|---|
| `src/batterieAnschluss.ts` (+ Test) | ALLE Regeln der Fläche: Anschlussarten, Ziel-Kanäle, Topic-/Pfad-Prüfung, Kurven-Prüfung, die Rümpfe für Speichern und Vorschau, das Zurücklesen einer gespeicherten Fassung, die Deutung der Probe-Antwort |
| `src/components/BatterieAssistent.tsx` (+ Test) | zeichnet nur — vier Schritte, die Bauform des `SelbstbauAssistent` daneben |
| `src/socHerkunft.ts` (+ Test) | die EINE Wahrheit über `soc_source_code` → deutsches Wort |
| `src/anlegenFlow.ts` / `components/AnlegenFlow.tsx` | die Karte `batterie` und ihre Schrittleiste; der Wirt |
| `src/components/KomponenteAssistent.css` (`vp-bat-*`) | Kurven-Editor + die zwei ehrlichen Vorschau-Zustände |
| api: `SocCurveTemplateController`, `SiteComponentController.previewBattery`, `UserDefinedBatteryService.previewConnection` | die zwei neuen Routen |

## Die vier Fragen

1. **Wie ist die Batterie erreichbar?** MQTT ist gebaut; HTTP und Modbus stehen
   SICHTBAR und gesperrt daneben, jeweils mit dem Grund. Ohne sie ließe die Liste
   den Kunden raten, ob VoltPilot seinen Fall grundsätzlich nicht kann oder nur
   noch nicht — und Modbus ist keine Ankündigung, sondern ein Wegweiser auf die
   Eigenbau-Tür, die es längst gibt.
2. **Was kommt wo an?** Topic → Wertepfad → Standard-Kanal, samt Aggregat
   (`min`/`max` über viele Zell-Topics ist der DIYBMS-Fall), Umrechnung,
   Haltbarkeit und Sentinel. Mit **„Werte ansehen"** je Zeile Roh- UND
   umgerechneter Wert.
3. **Wie entsteht der Ladestand?** `direct` / `ocv_curve` / `coulomb`, mit
   Vorlagenwahl, Kurven-Editor (Stützpunkte Spannung → SoC) und den Parametern
   je Methode.
4. **Prüfen & anlegen.**

## Die Regeln, die hier und nur hier leben

- **Jede Prüfung ist ein ZWILLING einer Server-Regel** (`UserDefinedBatteryDefinition`),
  nie eine zweite Wahrheit — sie existiert, damit der Kunde seinen Tippfehler SIEHT
  statt ihn abzuschicken. Der Server prüft unverändert selbst.
- **Die Vorschau ist ein ANGEBOT, keine Pflicht.** `POST
  /api/v1/sites/{id}/components/battery/preview` schickt die GEPRÜFTE Definition
  als `connection` einer `test_connection`-Anfrage plus `listen_s` und schreibt
  nichts — kein Beleg, keine Fassung. Eine MQTT-Vorschau braucht ein
  Lauschfenster statt der Einmal-Lesung des Modbus-Wegs; **ein fehlender
  `samples`-Block heißt „diese Box kann noch nicht lauschen", nie „es kam nichts
  an"**, und der Weiter-Knopf bleibt offen. Eine Pflicht ohne Tür wäre eine
  Sackgasse.
- **`count: 0` ist eine Aussage, keine 0.** Eine Zuordnung ohne Empfang steht als
  „Nichts empfangen" da; Roh- und Endwert reisen nur als PAAR (die Regel des
  Register-Lesens, auf die Zuordnung angewandt).
- **Die Kurven-Vorlagen kommen vom Server** (`GET /api/v1/soc-curve-templates`,
  aus `soccurves/catalog.json`). Eine Kennlinie im Portal wäre ein Zwilling, der
  abdriften darf — und eine abgedriftete Kennlinie ist ein falscher Ladestand mit
  Nachkommastellen. Jede Vorlage nennt ihre **Chemie und ihr Zellfenster**
  sichtbar: dieselbe Spannung bedeutet an LiFePO₄ etwas anderes als an NMC.
- **Ein von Hand geänderter Stützpunkt löst die Vorlagen-Bindung.** Die Kennung
  stehen zu lassen behauptete eine Herkunft, die nicht mehr gilt.
- **⚠ Formularzahlen tragen KEINEN Tausenderpunkt** (`feldZahl` statt `fmt`).
  Aus einer Umrechnung 1000 würde sonst beim Zurücklesen „1.000" → die Zahl 1:
  eine Batterie, die man nur ANSIEHT, hätte danach den Faktor 1000 verloren —
  stillschweigend und mit plausibel aussehenden Werten. Der Rundlauf
  Formular → Server-Form → Formular ist deshalb festgenagelt.
- **Der ENTITÄTSTYP entscheidet beim Bearbeiten, nicht die Rolle.** Eine selbst
  angebundene Batterie ist Rolle `storage` und liefe über `typFuerRolle` in das
  Katalog-Formular, das nach Marke und Modell fragt, die es bei ihr nicht gibt
  (`typFuerZeile` in `AnlegenFlow.tsx`, `data-testid="batterie-bearbeiten"`).

## Die Herkunft des Ladestands (`soc_source_code`)

`src/socHerkunft.ts` ist die EINE Übersetzung: 1 = „gemessen", 2 = „berechnet:
Kennlinie", 3 = „berechnet: Ladungszählung". Sie wird an drei Stellen gezeigt:

- **Cockpit-Speicherzeile** — `adaptiveLive.storageTile` → `LivePulsRow.herkunft`
  → `components/LivePuls.tsx`. Sie ERSETZT das Zustandswort nicht: „Lädt" bleibt
  wahr, auch wenn die Zahl daneben gerechnet ist.
- **Geräteseite / Komponenten-Zeile** — `komponenten.readingFor('storage')` setzt
  die `caption`; Geräteseite und Geräte-Gesicht lesen dieselbe.
- **Fahrplan** — `schedule.ladestandHerkunftNote`; das Vokabular ist ADDITIV
  erweitert (`berechnet:kennlinie` / `berechnet:ladungszaehlung` NENNEN die
  Methode, das grobe `berechnet` bleibt richtig gelesen).

**⚠ Ein abwesender Kanal ist „unbekannt", nie „gemessen".** Fast jede über einen
Katalog-Treiber gelesene Batterie meldet `soc_source_code` nie — eine Kachel, die
dort „gemessen" schriebe, hätte sich das ausgedacht. Ein Code außerhalb des
Vokabulars wird VERWORFEN. Melden mehrere Batterien verschiedene Herkünfte,
gewinnt die BERECHNETE: ein Speicherstand, der teilweise geschätzt ist, ist als
Ganzes geschätzt.

## Was P5d NICHT ist

Der Read-/Rechenpfad (P5/P5b, fertig), der Schutz-/Grenzbaustein (P5c), die
Speiser-Bindung an den Hybrid-Speicherknoten (P6) und der HTTP-Lesetyp. **Die
Box-Hälfte der Vorschau fehlt ebenfalls**: der `samples`-Block steht im Vertrag
(`docs/contracts/mqtt-probe.schema.json` + die zwei
`mqtt-probe.valid.test-connection-battery*`-Fixtures), eine heutige Box antwortet
`not_supported` — und die Fläche sagt genau das.
