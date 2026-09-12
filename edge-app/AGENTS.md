# Edge-App: Arbeitsregeln

Go-Core, Node-RED-I/O und OTA-Updater bilden die Kunden-Box. [Laufzeitregeln](../docs/edge-runtime.md), [Installation](DEPLOY.md), [Prüfstände](nodered/CONTROL-BENCH.md).

## Build und Konfiguration

- Core: `cd core && go test ./...`. Node-RED: `node --test nodered/*.test.js nodered/deye/*.test.js`; Palette separat mit `npm test` prüfen.
- `test/install-selfcheck.sh` und `test/update-selfcheck.sh` prüfen Installer/Updater. Die gemeinsame Compose-Vorlage, Installer und Updatepfad synchron halten.
- Neue Env-Optionen müssen im Core, Beispiel-Env, Compose und erzeugten Installations-Compose ankommen.
- Generierte Flows aus `build-flows.js` erzeugen; eingebettete Module nicht als unabhängige Kopien pflegen. `flows-sync.test.js` prüft die Übereinstimmung.
- Änderungen an `DefaultCatalog()` verlangen den vorgesehenen Vorlagenexport. Messpunkt-/Runtime-Artefakte mit den Katalogwerkzeugen erzeugen, nicht manuell editieren.
- Cloud-Standard ist `https://portal.voltpilot.de`. Geänderte MQTT-Endpunkte bei Enrollment-Reconcile auch bei identischer Geräte-ID übernehmen; der MQTT-Client cached seinen Broker.

## Identität, Quellen und Transport

- Geräte-/Quellkennungen sind dauerhaft. Umbenennen ist label-only; existierende Kennungen nicht neu vergeben.
- Referenz-Prüfziffer und Normalisierung mit Java/API und Portal synchron halten; geteilte Vektoren testen.
- Quelle, physisches Ziel, Verbindung und Modbus-Unit getrennt behandeln. Zusätzliche Messwerte über die zugeordnete Komponente lesen.
- Ein physischer Wechselrichter-Socket braucht gemeinsame Koordination von Poll, Probe und Schreibauftrag. Kein zweiter Poll bei laufendem Read; keine still verschluckten Fehler.
- Palette-Konfiguration strukturell prüfen; keine veralteten Transport-Whitelists, die gültige Quellen vor dem Router verwerfen.
- Self-Build-Geräte (`modbus_baukasten`) erhalten ihren Leseplan über Flows. Sie dürfen einen Registry-Push für andere Geräte nicht scheitern lassen.
- LAN-Zielprüfung beim tatsächlichen Verbindungsöffner wiederholen; die geteilten `lan-host-vectors.json` verwenden.

## Messwerte und Schutz

- Hausbilanz: frische Erzeuger aggregieren → geeigneten Netzzähler wählen → gemessene Batterieleistung → Hauslast ableiten. [Details](../docs/edge-runtime.md#messwerte).
- Batterieleistung nicht aus der Hausbilanz als Messung erfinden. Bei nachweislichem Hybrid ohne Batteriemessung ist die Hauslast unbekannt; nur nachweislich batterielose Geräte erlauben physisch null.
- Sonnenstrom-Ladegrenze ist die gemessene PV-Leistung am PV-Bus; die Hauslast kann parallel Netzstrom beziehen. Fehlende PV darf Solar-only-Laden nicht freigeben.
- Der Go-Core bleibt Ausführer und Schutzinstanz. Adapter dürfen Freigaben/Grenzen nicht erweitern.
- Zertifizierung ist modell-/gerätebezogen; globales Steuerungsflag und lokale Freigaben wirken gemeinsam. Simulatorbelege sind keine Hardwarezertifizierung.
- Deye-ToU mit unbekannter HV/LV-Skalierung vollständig verweigern. Remote-Modus nutzt seine eigene Leistungsbasis.
- Readback unterscheidet `held`, `mismatch`, `unread`/`unconfirmed`; Füllwerte, Watchdog-Countdown und 16-Bit-Ringsemantik beachten. Nullantwort niemals als Registerwert 0 ausgeben.
- Ein angenommener Einmalauftrag endet mit genau einem Ergebnis. Vorschauen schreiben nichts. Ohne Abonnenten darf ein Auftrag nicht spurlos verschwinden.
- PV-Limits nur in der vom Treiber belegten Schreibfolge setzen; Fronius-Blöcke zusammenhängend per FC16 übertragen. [Herstellerdetails](nodered/FRONIUS.md).

## OCPP und OTA

- OCPP-CSMS ist lokal, nur registrierte Kennungen verbinden. Optimierte Verteilung benötigt globale und Verbraucherfreigabe.
- OCPP-Sicherheitsprofile und Ablaufzeiten müssen bei Box-Ausfall weiter begrenzen. Messungen, Protokollantworten und physische Wirkung getrennt ausweisen.
- Updater ist regulärer Compose-Dienst. Kein Geräte-Autonomie-Schalter und keine zweite Apply-Freigabe einführen.
- OTA prüft Signatur, Kompatibilität und Anti-Rollback, holt Images vor dem Stoppen, tauscht sequenziell und hält Rücknahme/Selbsttest funktionsfähig.
- Trust-Set wird beim Einrichten beziehungsweise gezielt außerhalb des normalen Updatekanals verteilt. OTA darf seine eigene Vertrauenswurzel nicht austauschen.
- Datenverzeichnis, OTA-Zustände und Rückfallbelege sind dauerhaft; Neustarts müssen laufende Vorgänge korrekt fortsetzen.

## Lokale UI

Gemeinsamen Header samt Technikzeile in `.shell-header` halten. Keine geratenen Sticky-Offsets. `test/ui-mobile.mjs` prüft mobile Geometrie; Tokens und Picker-Varianten mit dem Portal konsistent halten.

## Maintaining this file

Neue Vorfallchroniken nicht anhängen. Dauerhafte Regeln hier kurz halten, Fachdetails in [Edge-Laufzeit](../docs/edge-runtime.md) und Geräteanleitungen pflegen. `CLAUDE.md` bleibt ein Symlink.

## Ergänzende Regeln

- Details gezielt im [Themenindex](../docs/agents/README.md) suchen. Webdateien unter `core/internal/web/static/` sind eingebettet; Änderungen benötigen einen neu gebauten Core und ein Edge-Release.
- Lesen, Vorschau und Steuern teilen eine Warteschlange je Wechselrichterverbindung. Ein Readback vergleicht Bedeutung und wird entprellt.
- Fehlende Messung deaktiviert ökonomische Eingriffe; eine Compliance-Grenze fällt auf ihre sichere statische Kappe zurück.
- `flows.json` mit `nodered/build-flows.js` erzeugen; `flows-sync.test.js` prüft die eingebetteten Modulkopien.
- Ein neuer Registry-Treiberwert muss zuerst auf der Box unterstützt sein. Selbstlesende Geräte dürfen den Registry-Push anderer Komponenten nicht verhindern.
- Compose muss konfigurierbare Umgebungsvariablen tatsächlich weiterreichen. Beim Runner gehören Ports und Bind-Mounts zum Docker-Host.

## Themen-Index (der ausgelagerte Bestand)

Der [gemeinsame Themenindex](../docs/agents/README.md) erschließt die Detailregeln unter `docs/agents/`. Neue dauerhafte Details am zuständigen Thema ergänzen und dort verlinken; dieser Wegweiser bleibt kurz.
