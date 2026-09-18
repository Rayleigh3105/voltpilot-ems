# WAGO-Kartenangaben (AP-05 IP-9)

`WagoComponentTemplateSeeder` legt beim Start genau eine Cloud-Vorlage an:
`certified:wago:pm494_pm495_registerbild_v1`, `device_type=meter`,
`certification_status=in_certification`. Das historische Herkunftswort `kind=certified`
ist kein Pilotnachweis. Der Datensatz nennt weder geprüfte Hardware noch Faktoren;
Kanäle, Schreibwege und Freigabedatum bleiben NULL. Ein erneuter Start verändert
keine vorhandene Fassung, Rücknahme oder spätere Pilotfreigabe. Die Vorlage nutzt die vorhandene Anbindungsart `modbus_tcp`.
Das Profil `registerbild_v1` ist ein Cloud-Vorgriff, keine freigegebene
Laufzeitfähigkeit. Maßgeblich: [Registerbild-Vertrag](../../docs/contracts/v2/wago-registerbild.md).

## Vorhandene Fakten weiterverwenden

- Seriennummer: `geraet.seriennummer`, Kartenseriennummer: `geraet_teil.seriennummer`.
- Physische Karte: `geraet_teil` und zeitgültige `geraet_komponente`-Zuordnung.
- Wandler primär/sekundär, Anwendungsart `dokumentiert`/`angewendet` und Faktor:
  bestehende `quelle_einstellung` und `GET/POST /api/v1/geraete/{id}/einstellungen`.
  Fehlende Erhebung wird nicht in Faktor 1 oder einen anderen Ersatzwert verwandelt.

## Ergänzende API

`GET/PUT /api/v1/sites/{siteId}/components/{entityId}/wago` liefert bzw. dokumentiert
`anwenderskalierung` (true/false/NULL) und `register35` (rohes UInt16, NULL unbekannt).
PUT braucht `expectedRevision` und eine portalverwaltete Anlage. `slot` kommt ausschließlich aus der gegenwärtigen
physischen Karten-Zuordnung, nie aus Port, Adresse oder Verbindung. Fehlt diese,
antwortet PUT mit 409. Register 35 wird für die 750-494 nicht als 495-Faktor gedeutet.

Jede Änderung erhöht die vorhandene Komponentenfassung; der Insert-Trigger nimmt
`slot`, `wago_anwenderskalierung`, `wago_register_35` in `component_definition` mit.
Der bestehende Fassungs-GET nennt sie, der bestehende Rollback stellt sie wieder her.
Eine inzwischen andere physische Steckplatz-Zuordnung sperrt den Rollback mit 409.
Der Dokumentationsweg ändert weder Verbindung noch Messwerte. Die neue Revision
wird über die vorhandene Aktivierungs-Outbox zugestellt; die neuen Kartenfelder
gehen nicht in die Registry und benötigen keine neue Box-Laufzeit.

`GET/PUT /api/v1/geraete/{id}/wago` liest bzw. schreibt `seriennummer`, `firmware` und
`anwendung` als Gerätestammdaten. PUT ersetzt die drei Angaben; NULL/leerer Text löscht
die Angabe. Die Seriennummer verwendet die vorhandene Spalte. Firmware und Anwendung
sind nullable Textfelder, keine Behauptung über den tatsächlich ausgelesenen Stand.

Beide Schreibwege benötigen `geraet.einrichten`; fremde Anlagen/Geräte bleiben 404.
Die neuen Spalten erben die vorhandene Mandanten-RLS. Komponentenfassungen und Geräte bekommen
zusätzlich den Standortzaun; neue Gerät-Spalten haben eigene UPDATE-Grants.

## Nachweise und Grenze

`WagoKartenfassungMigrationTest` prüft Bestandsschutz, NULL, Grants/RLS und Rollback.
`ComponentTemplateApiTest` prüft den Vorlagenstatus und fehlende Faktoren;
`GeraetApiTest` prüft Dokumentation, Fassungen, Eingabegrenzen und fremde Anlagen.
Keine Box-Freigabe, kein Pilotnachweis und kein Wechsel von `RUNTIME_VERSION`.
