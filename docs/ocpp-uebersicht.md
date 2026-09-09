# OCPP im gesamten Projekt

Stand: 09.09.2026. Bestandsaufnahme der implementierten OCPP-Funktionen einschließlich der OCPP-Härtung. Vorhanden bedeutet: im untersuchten Code vorhanden. Der installierte Stand einer Kundenanlage wurde dafür nicht geprüft. Neue Funktionen benötigen die Auslieferung von API/Portal und einen passenden Edge-Release.

Diese Übersicht beschreibt den implementierten Funktionsumfang und die Einstiegspunkte. Sie ist kein neuer UI-Entwurf und kein Nachweis des produktiven Release-Stands.

## Die vier Haupteinstiege

| Bereich | Aufgabe |
|---|---|
| Cockpit | Ladezustand und Energiefluss auf einen Blick |
| Steuerung | Ladeverhalten, Soforteingriffe, Vorrang und Rahmen |
| Ladevorgänge | Laufender Betrieb über alle Säulen |
| Geräteseite | Einzelne Station bedienen, einrichten und untersuchen |

## Alle Fundstellen und Kundenfunktionen

### 1. Cockpit

**Vorhanden** · Anlage → Cockpit → Kachel Laden, Energiefluss und Verbrauchsdetails

**Kundenfrage:** Lädt gerade jemand, mit welcher Leistung und an welchem Anschluss?

**Sehen:** Ladezustände, gemessene Leistung, verfügbare Budgetangaben und wartende bzw. freie Ladepunkte. Der Energiefluss unterscheidet Laden am Hausanschluss und Laden an einem eigenen Anschluss. In der Verbrauchsaufschlüsselung erscheinen erfasste Ladeanteile und vorhandene Tagesenergie.

**Tun:** Über den Kopf der Laden-Kachel die Ladevorgänge öffnen; über einen Ladepunkt dessen Geräteseite aufrufen.

**Grenzen und Besonderheiten:** Die Laden-Kachel bietet keine Start-, Stopp- oder Konfigurationsknöpfe. Nicht gemessene Werte bleiben unbekannt; der eigene Anschluss wird nicht als Hausverbrauch verrechnet.

Quellen: [AnlagenPage.tsx](../frontend/portal/src/pages/AnlagenPage.tsx) · [LadenKachel.tsx](../frontend/portal/src/components/LadenKachel.tsx) · [ladenKachel.ts](../frontend/portal/src/ladenKachel.ts) · [AdaptiveEnergyFlow.tsx](../frontend/portal/src/components/AdaptiveEnergyFlow.tsx) · [VerbrauchDetails.tsx](../frontend/portal/src/components/VerbrauchDetails.tsx)

### 2. Steuerung · Jetzt

**Vorhanden** · Anlage → Steuerung → Jetzt-Zone

**Kundenfrage:** Was soll bei diesem Ladevorgang jetzt anders laufen?

**Sehen:** Aktuelle Ladepunkte, Zustände, Gründe und bereits aktive Handeingriffe.

**Tun:** Je nach Zustand Jetzt voll laden, Laden pausieren oder Automatik fortsetzen auslösen. Die Folgen werden vor dem Eingriff erklärt.

**Grenzen und Besonderheiten:** Jetzt voll laden gibt verfügbare Leistung auch aus dem Netz frei, garantiert aber weder eine bestimmte Leistung noch 100 % Fahrzeug-Ladestand. Anschlussgrenzen und Schutzfunktionen gelten weiter. Pausieren ist kein Beenden der OCPP-Transaktion.

Quellen: [SteuerungSection.tsx](../frontend/portal/src/pages/SteuerungSection.tsx) · [JetztZone.tsx](../frontend/portal/src/components/JetztZone.tsx) · [SiteChargingBoostController.java](../services/api/src/main/java/com/voltpilot/api/web/SiteChargingBoostController.java) · [chargingboost.go](../edge-app/core/internal/chargingboost/chargingboost.go)

### 3. Steuerung · Ladeverhalten

**Vorhanden** · Anlage → Steuerung → Verbraucher → Ladepunkt → Steuerart

**Kundenfrage:** Wann und aus welcher Quelle soll diese Säule laden?

**Sehen:** Anlagen-Standard, wirksame Steuerart und Abweichungen einzelner Ladepunkte. Nicht verfügbare Möglichkeiten tragen einen Sperrgrund.

**Tun:** Je Säule Sofort laden, Solar-Überschuss oder Günstige Stunden wählen. Bei Überschuss zwischen Pausieren und Mindestleistung bei zu wenig Sonne wählen. Ein Energieziel bis Uhrzeit kann ergänzt werden, etwa 20 kWh bis 06:00.

**Grenzen und Besonderheiten:** Solar setzt PV voraus; Günstige Stunden einen hinterlegten dynamischen Tarif. Das kWh-Ziel braucht einen passenden Leistungsmesskanal und eine aktivierbare Verbraucher-Policy; bei Sofort ist das Ziel gesperrt. Feste Zeiten ist für Ladepunkte keine eigenständige Quellenoption. Die Anlagen-Standard-Zeile ist hier eine Anzeige. Ein Ladeziel gehört zur Säule, nicht zur Fahrzeugkarte.

Quellen: [VerbraucherZone.tsx](../frontend/portal/src/components/VerbraucherZone.tsx) · [SteuerartDialog.tsx](../frontend/portal/src/components/SteuerartDialog.tsx) · [SteuerartSatz.java](../services/api/src/main/java/com/voltpilot/api/verbraucher/SteuerartSatz.java) · [SteuerartService.java](../services/api/src/main/java/com/voltpilot/api/verbraucher/SteuerartService.java) · [ocpp_bridge.go](../edge-app/core/internal/agent/ocpp_bridge.go)

### 4. Steuerung · Rangliste

**Vorhanden** · Anlage → Steuerung → Verbraucher → Rangliste aufklappen

**Kundenfrage:** Wer bekommt bei knapper Leistung zuerst Energie?

**Sehen:** Reihenfolge der verfügbaren Verbraucher, Ladepunkte bzw. Ladepunktgruppen und des Speichers.

**Tun:** Die angebotenen Einträge nach oben oder unten verschieben und speichern. Die Reihenfolge wird bis zur Box übertragen.

**Grenzen und Besonderheiten:** Nur tatsächlich rangierbare Einträge können einzeln verschoben werden; ohne eigenes Verbraucherprofil können Ladepunkte eine gemeinsame Gruppe bilden. Vorrang erhöht das physisch verfügbare Budget nicht.

Quellen: [RanglisteKarte.tsx](../frontend/portal/src/components/RanglisteKarte.tsx) · [VerbraucherZone.tsx](../frontend/portal/src/components/VerbraucherZone.tsx) · [VerbraucherService.java](../services/api/src/main/java/com/voltpilot/api/verbraucher/VerbraucherService.java) · [chargingcfg.go](../edge-app/core/internal/chargingcfg/chargingcfg.go)

### 5. Steuerung · Fahrzeuge

**Vorhanden** · Anlage → Steuerung → Verbraucher → Fahrzeuge; auch aus einem erkannten Ladevorgang

**Kundenfrage:** Soll dieses Auto anders laden als die Säule normalerweise?

**Sehen:** Bereits erkannte Ladekarten als Pseudonyme, eigene Namen, letzte Sichtung, letzter Ladepunkt und zugeordnetes Ladeverhalten.

**Tun:** Eine erkannte Karte benennen, Sofort oder Solar-Überschuss mit passendem Verhalten bei wenig Sonne zuordnen und das Profil wieder entfernen. Ohne Profil folgt die Karte der Säule.

**Grenzen und Besonderheiten:** Das Fahrzeug wird über seine verwendete Ladekarte erkannt. Dieses Profil gewährt keine Ladeberechtigung. Es enthält kein Uhrzeit-/kWh-Ziel und keine Günstige-Stunden-Option. Handeingriffe gehen dem Quellenprofil vor.

Quellen: [FahrzeugeKarte.tsx](../frontend/portal/src/components/FahrzeugeKarte.tsx) · [fahrzeugProfile.ts](../frontend/portal/src/fahrzeugProfile.ts) · [ocpp_vehicle.go](../edge-app/core/internal/agent/ocpp_vehicle.go)

### 6. Steuerung · Ladepark-Rahmen

**Vorhanden** · Anlage → Steuerung → Ladepunkte → Einstellungen; Rahmen weiter unten auf derselben Seite

**Kundenfrage:** Welche Gesamtleistung darf der Ladepark nutzen?

**Sehen:** Anschlussgrenze und gemeldete bzw. gespeicherte Rahmenwerte einschließlich Sicherheitsabstand, Mindestleistung und Rotation.

**Tun:** Als Kunde die Anschlussgrenze in kW ändern und die Folgen bestätigen. Die Plattformverwaltung hat zusätzlich einen Editor für höchste Gebäudelast, Sicherheitsabstand, Mindestleistung pro Fahrzeug und Wechselintervall.

**Grenzen und Besonderheiten:** Die technischen Rahmenfelder sind nicht allgemein für Kunden editierbar. Das Lastmanagement erscheint hier als Schutzrahmen und nicht mehr als frei wählbares Betriebsmodell.

Quellen: [LadeparkRahmenKarte.tsx](../frontend/portal/src/components/LadeparkRahmenKarte.tsx) · [SteuerungSection.tsx](../frontend/portal/src/pages/SteuerungSection.tsx) · [AdminChargingFrameController.java](../services/api/src/main/java/com/voltpilot/api/web/AdminChargingFrameController.java)

### 7. Ladevorgänge

**Vorhanden** · Mit Speicher: Anlage → Fahrplan → Reiter Ladevorgänge. Im reinen Ladepark: eigener Navigationspunkt Ladevorgänge. Mobil heißt der Einstieg Laden.

**Kundenfrage:** Was passiert über alle Säulen hinweg gerade?

**Sehen:** Gesamtes Ladebudget, laufende Vorgänge, gemessene und zugeteilte Leistung, Startzeit, Priorität und Wartegründe; SoC nur bei entsprechender Meldung. Außerdem Säulenübersicht und Erläuterung des Ausfall-Schutzes.

**Tun:** Jetzt voll laden anfordern, einen bestehenden Handeingriff zurücknehmen, eine erkannte Karte benennen, zur Geräteseite wechseln oder weitere Säulen anbinden.

**Grenzen und Besonderheiten:** Der Einstieg zum neuen Pausieren liegt in Steuerung → Jetzt. Diese Seite ist primär die laufende Vorgangsübersicht; abgeschlossene OCPP-Transaktionen stehen auf der Geräteseite. Bei mehreren oder nicht eindeutig zugeordneten Boxen ist ein direkter Geräte-Link nicht immer verfügbar.

Quellen: [LadevorgaengeSection.tsx](../frontend/portal/src/pages/LadevorgaengeSection.tsx) · [anlageNav.ts](../frontend/portal/src/anlageNav.ts) · [SiteChargerController.java](../services/api/src/main/java/com/voltpilot/api/web/SiteChargerController.java)

### 8. Geräteseite · Betrieb und Details

**Vorhanden; mit OCPP-Härtung erweitert** · Anlage → Komponenten → Ladesäule → Geräteseite; ebenfalls erreichbar aus Cockpit, Ladevorgängen und Box-Geräteliste

**Kundenfrage:** Was macht genau diese Station und was kann ich dort bedienen?

**Sehen:** Jetzt, Befehle, Steuerung & Grenzen, Anschlüsse, Messwerte, Verbindung, Software und Diagnose. Aktiver Vorgang, letzte abgeschlossene Vorgänge, Steckerzustände, Modell/Firmware, Messwerte, Konfiguration, OCPP-Journal und Datenlücken.

**Tun:** Die Säule umbenennen; als berechtigter Operator zustandsabhängig Laden starten, Laden stoppen und Stecker entriegeln anfordern. Anlagenadministratoren erhalten zusätzliche Betriebs- und Konfigurationsbefehle. Der Aktionsverlauf unterscheidet Versand, Antwort und beobachtete Wirkung.

**Grenzen und Besonderheiten:** Die Aktionen hängen von Rolle, Stationseigenschaften und aktuellem Zustand ab. Ein OCPP-Accepted allein beweist keine Wirkung. Die lokale Vorschau nutzt Testberechtigungen und zeigt deshalb mehr Aktionen als ein normaler Operator sehen würde.

Quellen: [GeraetSeiteSection.tsx](../frontend/portal/src/pages/GeraetSeiteSection.tsx) · [OcppWallboxPage.tsx](../frontend/portal/src/pages/OcppWallboxPage.tsx) · [ocppWallbox.ts](../frontend/portal/src/ocppWallbox.ts) · [OcppActionPolicy.java](../services/api/src/main/java/com/voltpilot/api/ocpp/OcppActionPolicy.java)

### 9. Geräteseite · OCPP einrichten und prüfen

**NEU · OCPP-Härtung** · Geräteseite → Steuerung & Grenzen → OCPP einrichten und prüfen

**Kundenfrage:** Ist die Regelung eingerichtet, übernommen und an diesem Stecker nachgewiesen?

**Sehen:** Einzelne Nachweise für Verbindung, Fähigkeiten, Schutzprofile, Leistungsmessung, Transaktion, Freigabe, Rücklesung und Konfigurationsübernahme. Gespeicherte Einstellungen und Meldungen der Box bleiben getrennt.

**Tun:** Mit Anlagenverwaltungsrechten die OCPP-Regelung freigeben/abschalten, pro Stecker eine befristete Ladegrenze setzen, AC-Anschlussdaten und Phasenbudgets pflegen, Kartenfreigaben verwalten sowie die beaufsichtigte Prüfung Begrenzen → Pause → Weiterladen auslösen.

**Grenzen und Besonderheiten:** Freigabe und Kartenzugangsmodus gelten für die OCPP-Säulen der Anlage, obwohl die Oberfläche auf einer einzelnen Geräteseite sitzt. Grenze und Prüfung betreffen den ausgewählten Stecker. Eine manuelle Grenze gilt höchstens 24 Stunden; 0 kW pausiert. Phasenanteile sind konservativ und fest, es gibt keine automatische Phasenumschaltung. Kartenentzug verhindert neue Vorgänge und beendet keine laufenden. Die Prüfung ist kein allgemeines Herstellerzertifikat.

Quellen: [OcppControlPanel.tsx](../frontend/portal/src/components/OcppControlPanel.tsx) · [ocppControl.ts](../frontend/portal/src/ocppControl.ts) · [SiteOcppControlController.java](../services/api/src/main/java/com/voltpilot/api/web/SiteOcppControlController.java) · [control_policy.go](../edge-app/core/internal/csms/control_policy.go) · [control_status.go](../edge-app/core/internal/csms/control_status.go) · [ocpp-control.md](../docs/ocpp-control.md)

### 10. Komponenten · Säule anbinden

**Vorhanden** · Anlage → Komponenten → Gerät hinzufügen → Ladesäule (OCPP); derselbe Assistent unter Ladevorgänge → Weitere Säule anbinden

**Kundenfrage:** Wie kommt meine Säule in VoltPilot?

**Sehen:** Geführte Einrichtung mit Kennung, Namen, Anschlusszuordnung und der konkreten Adresse der Box zum Kopieren. Der Assistent wartet auf die tatsächliche Meldung der Säule.

**Tun:** Eine Säule zulassen, Namen vergeben, Hausanschluss oder eigenen Anschluss zuordnen, Verbindungsadresse kopieren, Verbindungsstatus prüfen und eine Zulassung wieder entfernen.

**Grenzen und Besonderheiten:** Die OCPP-Serveradresse wird in der Herstelleroberfläche der Säule eingetragen. Das ist keine automatische Einrichtung jeder beliebigen Wallbox. Entfernen einer Zulassung ist kein sicherer Fernstopp eines laufenden Ladevorgangs.

Quellen: [LadesaeuleAnbinden.tsx](../frontend/portal/src/components/LadesaeuleAnbinden.tsx) · [AnlegenFlow.tsx](../frontend/portal/src/components/AnlegenFlow.tsx) · [AnlagenModellSection.tsx](../frontend/portal/src/pages/AnlagenModellSection.tsx) · [SiteChargingConfigController.java](../services/api/src/main/java/com/voltpilot/api/web/SiteChargingConfigController.java)

### 11. Verlauf · Messwerte und Auswertungen

**Vorhanden** · Anlage → Verlauf → Messwerte → Explorer/Vergleich; zusätzlich Messwerte auf der Geräteseite

**Kundenfrage:** Wie hat sich der gemessene Verbrauch entwickelt?

**Sehen:** OCPP-Säulen werden als messende Komponenten geführt. Leistung und Energie können über die vorhandenen Komponenten-Messkanäle in Zeitreihen und Vergleichen erscheinen; auf der Geräteseite liegen zusätzlich die gemeldeten OCPP-Messwerte.

**Tun:** Vorhandene Messreihen und Zeiträume auswählen, vergleichen und die angebotene Messwertaufzeichnung auf der Geräteseite verwalten. Registrierte Messkanäle sind auch für die allgemeinen eigenen Auswertungen nutzbar.

**Grenzen und Besonderheiten:** Nur tatsächlich erfasste und zugeordnete Kanäle sind auswertbar. Fahrzeug-SoC wird bewusst nicht zur aggregierten Stations-Telemetrie gemacht. Eine Messwertauswertung ist keine fertige Ladekarten-Abrechnung.

Quellen: [MesswerteSection.tsx](../frontend/portal/src/pages/MesswerteSection.tsx) · [VerlaufExplorer.tsx](../frontend/portal/src/components/VerlaufExplorer.tsx) · [SiteMeasurementComparison.tsx](../frontend/portal/src/components/SiteMeasurementComparison.tsx) · [ocpp_entities.go](../edge-app/core/internal/agent/ocpp_entities.go) · [ChargerComponentComposer.java](../services/api/src/main/java/com/voltpilot/api/chargers/ChargerComponentComposer.java)

### 12. Verlauf · Befehle

**Vorhanden** · Anlage → Verlauf → Befehle; auch über Befehle an Ihre Geräte ansehen in Steuerung

**Kundenfrage:** Welche Ladegrenze hat VoltPilot hinterlegt?

**Sehen:** Den aufgezeichneten Strom OCPP-Ladeprofil mit zugeteilter Leistung, bestätigtem bzw. unbekanntem Zustand und gemeldeten Gründen. Zeitraum und Geräte-/Komponentenbezug lassen sich eingrenzen.

**Tun:** Den Verlauf filtern und nachsehen, wann sich die gemeldete Steuerung änderte.

**Grenzen und Besonderheiten:** Der allgemeine Verlauf verdichtet Herzschlag-Beobachtungen zu Zeitabschnitten. Das vollständige Journal einzelner OCPP-Fernaktionen und Protokollnachrichten liegt separat auf der Geräteseite. Die beiden Ansichten sind kein identischer Verlauf.

Quellen: [BefehleSection.tsx](../frontend/portal/src/pages/BefehleSection.tsx) · [CommandLogWriter.java](../services/api/src/main/java/com/voltpilot/api/command/CommandLogWriter.java) · [SiteCommandHistoryController.java](../services/api/src/main/java/com/voltpilot/api/web/SiteCommandHistoryController.java)

### 13. Steuerung · Regeln und Planung

**Vorhanden** · Steuerung → Steuerart/Regeln; intern Verbraucher-Policy, Optimierer und lokale Regel-Ausführung

**Kundenfrage:** Wie erreicht ein geplanter oder regelbasierter Wunsch die OCPP-Säule?

**Sehen:** Die Säule ist eine steuerbare Komponente. Geplante Quellen/Ziele und geeignete Regeln können über die vorhandene Verbraucherstrecke wirksam werden; Wartegründe unterscheiden Plan und Regel.

**Tun:** Die angebotenen Steuerarten/Ziele und geeigneten Automationen für eine korrekt angebundene, aktivierbare Komponente verwenden.

**Grenzen und Besonderheiten:** Kein separater OCPP-Fahrplaneditor: Die Anbindung läuft über die allgemeine Verbraucherplanung. Die Box übersetzt ein gültiges Regel-/Planurteil in ein Leistungslimit. Ohne Komponentenbindung greift diese Brücke nicht. Es wird keine beliebige OCPP-Protokollaktion zum Automationsbaustein.

Quellen: [SteuerungSection.tsx](../frontend/portal/src/pages/SteuerungSection.tsx) · [SteuerartService.java](../services/api/src/main/java/com/voltpilot/api/verbraucher/SteuerartService.java) · [ocpp_bridge.go](../edge-app/core/internal/agent/ocpp_bridge.go)

### 14. Box-Seite und lokale Box-Oberfläche

**Vorhanden** · Portal: Anlage → Box → Geräteliste. Lokal im Kunden-LAN: Box-Adresse:8484 → Betrieb bzw. Einrichten → Ladepunkte

**Kundenfrage:** Was läuft vor Ort, auch wenn die Cloud nicht erreichbar ist?

**Sehen:** Im Portal die zugeordneten Geräte und den Einstieg zur Säule. Lokal Ladebudget, Vorgänge, Gründe, Quelle und bekannte Säulen.

**Tun:** Lokal einen angebotenen Boost auslösen bzw. zurücknehmen. In der Einrichtung Säulen mit Kennung, Name, Nennleistung und Steckeranzahl anlegen/entfernen sowie Budget, Reserve, Sicherheitsabstand, Rotation und Quellenverhalten einstellen.

**Grenzen und Besonderheiten:** Der Zugriff ist eine eigene Oberfläche im Kunden-LAN. Dort existieren weiterhin ältere gemeinsame Einstellungen für Quellenwahl und Speicher-Vorrang, während das Portal Steuerart und Rangliste verwendet. Laden pausieren wird lokal nicht neu angeboten. Die neue Portal-Prüfoberfläche wurde hier nicht nachgebaut; beim Zusammenspiel gelten die jeweiligen gespeicherten Cloud-/Box-Konfigurationen.

Quellen: [BoxSeiteSection.tsx](../frontend/portal/src/pages/BoxSeiteSection.tsx) · [index.html](../edge-app/core/internal/web/static/index.html) · [einrichten.html](../edge-app/core/internal/web/static/einrichten.html) · [ocpp.js](../edge-app/core/internal/web/static/ocpp.js)

## Berechtigungen

| Rolle | Umfang |
|---|---|
| Kunde mit Anlagenzugriff | Bestehende Anlagenfunktionen wie Ladeübersicht, Steuerart, Rangliste und Boost folgen der jeweiligen Anlagenberechtigung; die älteren Charging-Endpunkte haben keinen zusätzlichen OCPP-Operator-Rollenzaun. |
| Operator | Im Command Gateway: Laden starten, stoppen und entriegeln. Die neue OCPP-Einrichtung kann gelesen werden. |
| Anlagenadministrator / bisherige admin-Rolle | Zusätzlich reservieren/aufheben, Verfügbarkeit ändern, sanft neu starten, angewandten Plan lesen, Konfiguration lesen und erlaubte Werte ändern, Nachrichten anfordern, Cache/Liste verwalten. Außerdem neue OCPP-Einrichtung bearbeiten. |
| Plattformverwaltung | Zusätzlich harter Neustart, Diagnoseupload, Firmware-Aktion und der registrierte Hersteller-Healthcheck. Technische Ladepark-Rahmenwerte bearbeiten. Das ist nicht der normale Kundenumfang. |

Stationsfähigkeiten, Zustand und serverseitige Validierung schränken jede erlaubte Aktion zusätzlich ein. Rohes SetChargingProfile/ClearChargingProfile und eingebettete Profile beim Fernstart sind mit der OCPP-Härtung gesperrt. Im verwalteten Kartenzugang sind SendLocalList und Änderungen der verwalteten Autorisierungsschlüssel ebenfalls gesperrt.

## Begriffe, die unterschiedliche Handlungen meinen

- Laden starten fordert eine neue Transaktion an. Jetzt voll laden ändert die Behandlung eines vorhandenen Vorgangs.
- Pausieren bzw. 0-kW-Grenze hält die Leistungsabgabe an. Laden stoppen beendet die Transaktion. Regelung abschalten ist ebenfalls kein RemoteStop.
- Fahrzeugprofil bestimmt die Quelle. Kartenfreigabe entscheidet, ob eine neue Ladung zugelassen wird. Ladeziel und Rangliste sind weitere, getrennte Einstellungen.
- Gespeichert, von der Box übernommen, von der Station beantwortet und durch Messung bestätigt sind unterschiedliche Zustände. Die neuen Nachweise machen das ausdrücklich sichtbar.

## Unterbau im Repository

| Bereich | Pfade | Verantwortung |
|---|---|---|
| Portal | frontend/portal/src/pages/OcppWallboxPage.tsx; components/OcppControlPanel.tsx; pages/LadevorgaengeSection.tsx; pages/SteuerungSection.tsx | Anzeigen, Eingaben und Navigation; verteilt selbst keine Leistung. |
| API / Stammdaten | services/api/src/main/java/com/voltpilot/api/chargers; verbraucher; fahrzeuge; ocpp; web/SiteOcpp*.java | Ladepunkte, Quellen, Rangliste, Fahrzeuge, Berechtigungen, Befehle, Konfiguration und Protokoll-Lesemodelle; Mandantentrennung über RLS. |
| Transport / Daten | docs/contracts/mqtt-charging-config.schema.json; mqtt-charging-boost.schema.json; mqtt-ocpp-command.schema.json; mqtt-ocpp-events.schema.json | Einstellungen und Befehle gelangen zur Box; Zustände, Messwerte und Ereignisse zurück zur Cloud. Allgemeine Komponenten-Zeitreihen laufen durch die vorhandene Telemetriestrecke. |
| Lokales Central System | edge-app/core/internal/csms; internal/agent/ocpp*.go; internal/ocppcontrol | Die Box spricht OCPP 1.6 JSON mit den Säulen, verwaltet Transaktionen, Autorisierung, Profile und Befehlswirkungen. Standardadresse: ws://<Box>:8887/ocpp/<Kennung>. |
| Leistungsverteilung | edge-app/core/internal/lastmgmt; internal/agent/ocpp_bridge.go; internal/chargingcfg; internal/chargingboost | Lokale Verteilung nach Budget, Schutz, Quelle, Vorrang und Rotation; Plan/Regel/Handeingriff werden berücksichtigt. Cloud-Ausfall und Ausfall der Box sind unterschiedliche Fälle. |
| Optimierung | services/optimization; services/api/src/main/java/com/voltpilot/api/consumers; internal/agent/ocpp_bridge.go | Allgemeine Verbraucherplanung, keine zweite cloudseitige OCPP-Zentrale. Die lokale Box setzt den erlaubten Wunsch unter ihren Grenzen um. |
| Tests / Nachweise | edge-app/test/e2e-ocpp.sh; edge-app/core/internal/ocppsim; frontend/portal/e2e/ocpp-wallbox.spec.ts; docs/contracts/v2/ocpp-*-vectors.json | Simulator, echte Websocket-Teststrecke, Komponenten- und API-Prüfungen, Browserabläufe und gemeinsame Java/Go-Vektoren. |
| Dokumentation / Audit | docs/ocpp-control.md; docs/ocpp-uebersicht.md; lokale, nicht versionierte Arbeitsmaterialien: .lavish/ocpp-bewertung-20260909 und OCPP-Audit.html | Einrichtungsbeschreibung, diese Bestandsaufnahme sowie der vorhandene Audit mit Testnachweisen und Screenshots. |

## Bereits vorhanden und neu ergänzt

Mit der OCPP-Härtung hinzugekommen sind die explizite OCPP-Freigabe, befristete Steckergrenzen, AC-/Phasenangaben, verwaltete Kartenfreigabe und die beaufsichtigte Regelprüfung auf der Geräteseite. Im Unterbau wurden Profil-Eigentümerschaft, Messwertalter und Wiederanlauf laufender Transaktionen abgesichert. Cockpit, Steuerart, Rangliste, Fahrzeugprofile, Ladevorgänge, Anbindung und die grundsätzliche Fernbedienung waren bereits vorhanden. Eine Vereinfachung der gesamten Portal-UX wurde noch nicht umgesetzt.

## Einordnung der Bedienung

Die Funktionen decken Überwachung, Ladeverhalten, Lastmanagement, Fernbedienung und Einrichtung ab. Aus Kundensicht überschneiden sich jedoch mehrere Einstiege. Besonders auffällig: anlagenweite neue Einstellungen auf einer einzelnen Geräteseite; ein Geräte-Link mit der Beschriftung Ladeeinstellungen, der zu Ladevorgänge führt; und zwei verschiedene Befehlsverläufe. Die gewünschte Trennung nach Alltag und Einrichtung ist somit noch nicht durchgängig erreicht.

## Aussagegrenzen dieser Bestandsaufnahme

Der untersuchte Stationspfad ist OCPP 1.6 JSON. Aus dieser Implementierung folgt keine pauschale Kompatibilität mit jeder Ladesäule, keine automatische Phasenumschaltung und keine fertige Roaming-, Zahlungs- oder eichrechtliche Abrechnungslösung. SoC hängt von den Meldungen des Fahrzeugs bzw. der Station ab. Hardware-Nachweise je Modell/Firmware und der tatsächlich installierte Release-Stand bleiben gesondert zu prüfen. Für diese Bestandsaufnahme wurden Quellpfade gelesen; es wurde keine Kundenanlage bedient oder neu deployed.

Die eingebettete Portal-Aufnahme in der HTML-Fassung stammt aus der lokalen React-Vorschau mit Demo-Daten und erweiterten Testberechtigungen. Sie ist kein Screenshot einer Kundenanlage. Die Funktionsliste wurde anhand der oben verlinkten Produktionsquellen erstellt, nicht aus den Berechtigungen der Vorschau abgeleitet.
