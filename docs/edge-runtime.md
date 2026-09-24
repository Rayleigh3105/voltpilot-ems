# Edge-Laufzeit

Der Go-Core hält Identität, Cloud-Verbindung, Puffer und Steuerungsverantwortung. Node-RED übernimmt Geräte-I/O; der OTA-Updater tauscht signierte Softwarestände aus.

## Ausführung

```mermaid
flowchart TD
    Plan["Cloud-Fahrplan"] --> Wunsch["Lokale Wünsche"]
    Flow["Regeln und Flows"] --> Wunsch
    Lokal["Lokale Bedienung / Fallback"] --> Wunsch
    Wunsch --> Arbiter["Vorrang, Besitzer, TTL"]
    Arbiter --> Guards["Freigaben und Schutzgrenzen"]
    Guards --> Adapter["Geräteadapter"]
    Adapter --> Hardware["Physisches Gerät"]
    Hardware --> Rueck["Readback und Messwerte"]
    Rueck --> Core["Core: Zustand und Wirkung"]
```

Nicht jede Quelle darf jede Priorität beanspruchen. Der normale Entitätsflow schreibt keine Register am Arbiter vorbei. Explizite generische Modbus-Knoten sind die gesonderte [Governance-Ausnahme](contracts/v2/flow-graph.md#katalogausnahmen), kein automatisch zertifizierter Steuerpfad. Verbindliche Reihenfolge und Ausnahmen stehen in [Arbitration](contracts/v2/edge-desired-arbitration.md) und [Ausführungsverantwortung](contracts/v2/plan-execution-ownership.md).

## Messwerte

Die Standortbilanz wird in dieser Reihenfolge gebildet: frische PV-Quellen addieren, frischen Standort-Netzzähler gegenüber dem primären Wechselrichter bevorzugen, gemessene Batterieleistung übernehmen und Hauslast ableiten:

`Hauslast = PV + Netzbezug − Batterieladung`

Die Vorzeichen folgen dem lokalen Vertrag. Der primäre Netzwert wird standardmäßig als Standortbilanz verwendet; `PrimaryGridNotSiteTotal` ist der ausdrückliche Ausweg bei anders platziertem CT.

- Batterie wird gemessen, nicht aus der Bilanz als Messwert rekonstruiert.
- Ein nachweislich batterieloses Modell erlaubt Batterie = 0. Bei einem Hybrid ohne Batteriemessung bleibt die abgeleitete Hauslast unbekannt.
- Unbekannte Gerätekategorien und fehlende Standortbilanz verwenden den vorhandenen, gerätespezifischen Rohlastpfad; keine pauschale Ersatzformel ergänzen.
- Quellwechsel und veraltete Messungen müssen im Zustand nachvollziehbar bleiben. Eine Komponente behält Kennung und Historie bei Aliasänderung.

Quellen: `agent.onLocalTelemetry`, `sources.BalanceSettings`, `inverter.FamilyHasBattery` im [Core](../edge-app/core/internal/).

## Schutzgrenzen

Die konkrete Kette steht unter `internal/guards`. Sie berücksichtigt Nennleistung, SoC, Netzgrenzen sowie aktivierte Betriebsregeln. Solar-only-Laden wird an der **gemessenen PV-Leistung** begrenzt; fehlende PV erlaubt dabei keine Ladung. Die Hauslast darf im PV-Bus-Modell gleichzeitig aus dem Netz versorgt werden.

Weitere lokale Funktionen sind Lastnachführung, PV-Überschussaufnahme, Einspeisebegrenzung, Zyklenschutz, oberer PV-Puffer und native Selbstregelung. Ihre Wirkung ist nicht pauschal „nur weniger Sollwert“: einzelne Funktionen dürfen innerhalb der Schutzgrenzen einen Bedarf erhöhen. Sie brauchen ihre eigenen Voraussetzungen und Tests.

Die messwertgeführten Korrekturen (Trim, Überschuss-Speichern/-Aufnahme, Lastnachführung, Defizitdeckung) laufen hinter dem **gedämpften Folger** (`guards/followdamper.go`): Sie sehen ein neues Messpaar Netz/Batterie erst, wenn beide Hälften nach dem letzten Schreibbefehl plus Einschwingzeit gemessen wurden; die teure Seite (Laden aus dem Netz, Entladen ins Netz) wird sofort verlassen, die billige in Rampen mit Reserve angefahren. Einschwingzeit und Messtakt stehen je Gerätefamilie im Profil (Deye gemessen: 15 s / 25 s, sonst diese Vorgabe). Ohne gewähltes Gerät und auf Dauerspeicher-Hebeln (Deye-ToU) ist er aus. Schutzgrenzen klemmen den gedämpften Wert weiterhin in jedem Takt mit der Live-Messung.

**Absicht + Fenster** (`guards/intent.go`, K4b): die Box übersetzt die Flaggen eines Slots in eine Absicht mit Leistungsfenster und lässt ein offenes Fenster das Gerät selbst regeln, sobald Layer 1 für genau diese Absicht einen zertifizierten Hebel meldet und ihn im Rücklesen belegt; sonst regelt sie gedämpft wie oben. Umgeschaltet wird nur an Slotgrenzen. Vertrag, Aufsicht und Schreibbudget: [Wer führt den Fahrplan aus?](contracts/v2/plan-execution-ownership.md#absicht--fenster-k4b-24092026). Simulatorbelege ersetzen keinen Hardware-Prüfstand; freigegeben für echte Geräte ist weiterhin nur die Entladeseite des Deye-Piloten.

**Steuerprofile** (`catalog/control-profiles`, K7): je Gerätefamilie beschreibt ein Profil Hebel, Schreibfolge, Beleg, Rückfall, Totmann, Schreibbudget und Dämpfung je Absicht, mit Quellen und Sicherheit A–D – Wissen, keine Freigabe. Die Box liest daraus nur Einschwingzeit/Messtakt des gedämpften Folgers und das Tagesbudget eines Dauerspeicher-Hebels (`internal/controlprofile`, eingebettet); Schreibfolgen bleiben Code im Adapter, `edge-app/nodered/control-profiles.test.js` hält beide zusammen. Freigegeben wird weiter je Modell + Firmware + Prüfnachweis über das Zertifikat.

Bei Cloud-Ausfall gelten Frische-/Fallbackregeln pro Plan und Entität. Eine generelle Zusage „jeder Verbraucher läuft autonom weiter“ wäre falsch. Der [Deadline-Fallback](verbrauchssteuerung.md#offline-verhalten) startet nur bei belegtem Bedarf und zulässiger Ausführung.

## I/O und physische Freigabe

- Poll, Probe und Schreiben teilen den vorgesehenen Verbindungsmanager. Ein langsamer Poll darf keinen zweiten konkurrierenden Socket erzeugen.
- Palette-Knoten prüfen die Struktur. Routing entscheidet, ob ein Transport unterstützt wird, und meldet unverdrahtete Quellen sichtbar.
- Physische Geräteidentität, Connection und Registerziel getrennt erhalten. Eine Auswahl darf keine zweite Quelle erzeugen oder einen fremden Registerauftrag umlenken.
- Plattform-/Modellfreigabe, gerätespezifische Kalibrierung und Laufzeitflags zusammen auswerten. Steuerung muss auch wieder sauber freigegeben werden können.
- Deye-ToU benötigt bekannte Leistungsskalierung. Fronius-PV-Steuerung braucht die belegte Blockschreibfolge. [Deye](../edge-app/nodered/DEYE.md), [Fronius](../edge-app/nodered/FRONIUS.md), [Prüfstand](../edge-app/nodered/CONTROL-BENCH.md).
- Readback bewertet Semantik vor Zahlenvergleich: Füllwerte sind ungelesen, Watchdog-Zähler haben eigene Regeln, signed Register benötigen passende Toleranz. Eine fehlende Antwort ist kein abweichender Messwert.

## OCPP und lokale Netze

Die Box ist OCPP-Central-System auf `ws://<box>:8887/ocpp/<kennung>`. Nur registrierte Kennungen werden angenommen. `VP_OCPP_ENABLED` aktiviert den Server; die optimierte Verteilung benötigt zusätzlich `VP_CONTROL_ENABLED` und `VP_CONSUMER_CONTROL_ENABLED`.

Das Sicherheitsprofil der Säule bleibt bei Box-Ausfall wirksam. Protokollannahme und tatsächliches Laden werden separat erfasst; echte Modelle benötigen einen Prüfstandnachweis.

Web `8484`, Node-RED-Editor `1881` und OCPP `8887` gehören ins Kundennetz. Der lokale MQTT-Bus ist im Standard am Host nur über Loopback `1884` erreichbar. Für Cloud-Verbindung braucht die Box ausgehendes HTTPS und MQTT-mTLS, keine öffentliche Portweiterleitung.

## Prüfpunkte

- `go test ./...` im Core: Guards, Arbitration, Enrollment, Puffern, OCPP und OTA.
- Node-RED-Modul-/Palette-Tests: Routing, Protokolle, eingebettete Flows, Readback.
- `test/e2e-compose.sh`: vollständiger Simulatorpfad.
- `test/e2e-ocpp.sh`: OCPP-Protokoll, Budget und Ausfallverhalten.
- [OTA-Soak](../edge-app/test/ota-soak/README.md): unterbrochene Updates und Rücknahme.

Installationsregeln: [Edge-Deployment](../edge-app/DEPLOY.md). Signatur-/Updatepfad: [OTA](ota-autonomie.md).
