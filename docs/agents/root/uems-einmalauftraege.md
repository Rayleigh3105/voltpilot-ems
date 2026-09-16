# Einmal-Aufträge und ausführende Box (AP-06 IP-8)

`entities/EinmalAuftragZiel` ist die gemeinsame Adresse für Probe/Verbindungstest/Schalt-Test,
Register-Schreiben, Verbraucher- und Speicher-Handeingriff sowie komponentenbezogene
Mess-Selektion. Ohne Datenquelle gilt `LeadDeviceService`: auch eine Bestandsanlage mit genau
einer Box sendet weiter. Eine vorhandene Quellenzuständigkeit überstimmt eine alte `deviceId`.
Explizite Box-Wahl bleibt für noch ungebundene Prüfziele und freie Registeradressen möglich.

Der Ausführungsstand aus `data_source_handover` geht vor dem Plan: `active`/`pending` → bisheriger
Leser; `receiving` → Ziel erst nach erfolgreichem Registry-Versand; `removing`/`reconciling` →
benannter 409. Ohne Übergabestand darf nur der erste gültige Zeitraum unmittelbar adressieren;
nach einem bereits vergangenen Wechsel ist die Ausführung unbekannt. Kein Ausweichen auf eine
andere Box bei einer fehlenden/ausgebauten/fremden zuständigen Box. Das anlagenübergreifende
AP-07-Gate bleibt wie beim Registry-Push geschlossen. Eine fremde Komponente/angefragte Box ist 404.

Bei Registeraufträgen bleibt Zielidentität von LAN-Adresse getrennt: gleiche Adresse an mehreren
Boxen bleibt in der Zielliste getrennt; es gilt die ausdrückliche Box-Wahl, sonst die führende Box,
wenn sie zu diesen Zielen gehört. Ein Ableitungsfehler wird nicht mehr verschluckt. Ein bekannter,
aber fehlender Zielbesitzer wird nicht durch eine beliebige `deviceId` ersetzt.

Mess-Selektion prüft zuerst den Anlagenzaun der angefragten Box und Komponente. Danach gehören
Lesestand, Revision, Budget, Änderung und Push der ausführenden Box. Historienwege behalten ihre
explizite Box. `forPublishing` filtert auch im Reconciler alte Komponenten aus der Vollmenge der
bisherigen Box; gespeicherte Auswahl und Historie werden dabei nicht verschoben oder gelöscht.
Eine nicht versandte Auswahl nennt den Zustellfehler in `statusReason`.

Handeingriffe behalten ihren gespeicherten Wunsch bei Transportfehlern. Jede Antwort mit
`pushed=false` nennt zusätzlich `pushReason` (abgeschaltete Steuerung, fehlender Publisher oder
fehlgeschlagener Versand; Registry-Gründe werden durchgereicht). Beenden/Fortsetzen behauptet
ohne Versand keine übernehmende Automatik mehr. Annahme, Zustellung und Wirkung bleiben getrennt.

Portal: `component-test` übermittelt `deviceId` der vorhandenen Boxwahl und beim Bearbeiten
`entityId`; der Server entscheidet über deren Quellenzuständigkeit. Keine neue Fläche oder Rechte.
Prüfungen: `EinmalAuftraegeTest` (Einzelbox ohne Quelle, führende Box bei zwei Boxen, Quelle an
zweiter Box, ausstehende Übergabe je Ablauf), `UemsQuellenUebergabeTest` (echter DB-Ausführungsstand),
`RegisterWriteGatewayTest`, `MeasurementContractsTest`, `apiEinmalAuftraege.test.ts` und
`AnlegenFlow.test.tsx`. Keine Migration, kein Edge-Release.
