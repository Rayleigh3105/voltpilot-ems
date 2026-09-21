# UEMS-Vorschlagsliste Bestand: Komponenten zu Datenquellen je Box, Übernahme erst nach Bestätigung

Neu am 11.09.2026 (AP-06 IP-4, Backend). Portal seit 21.09.2026: Schritt 2 des Messen-Assistenten
(`frontend/portal/src/datenquelleVorschlag.ts` + `components/DatenquelleVorschlagListe.tsx`, selbsttragend
je Anlage — der Übernahme-Assistent für Bestandskunden soll sie wiederverwenden). `GET /api/v1/sites/{siteId}/data-sources/vorschlag` und
`POST …/vorschlag/uebernehmen` am `DatenquelleController`, Arbeit in
`uems/DatenquelleVorschlagService.java`, Fakten aus `uems/DatenquelleBestandRepository.java`,
Transport → Protokoll in `uems/BestandAnschluss.java`, die Regel `DatenquelleRegeln.vorschlagsliste`
+ TS-Zwilling `frontend/portal/src/uemsDatenquelle.ts` (Vektoren: Familie `bestand` in
`docs/contracts/v2/data-source-vectors.json`, Vertrag `data-source-assignment.md` §8, §11 Nr. 9–11).
Migration `V20260911270000` (Protokoll-Eintrag `aus_bestand_uebernommen`, `data_source.kadenz_s` NULL =
nicht erhoben, Protokoll-Vokabular + `solarman_v5`). Beweis: `uems/DatenquelleVorschlagApiTest` (Halle 1 → genau DQ-1…DQ-3, A12
Push-Gleichheit, A9, Übernahme, Idempotenz, 409er, Demo-Anlagen, 404), `BestandAnschlussTest`,
`DatenquelleRegelnVectorsTest` (prüft jeden Vorschlag aus Referenz-Komponenten gegen DQ-x der
Referenz), `DatenquelleSchnittstelleVertragTest`; der ganze Portal-Weg des Messkunden:
`metrics/PortalwegMesskundeAbnahmeTest` (spielt nur Routen, die `api.ts` ruft, und prüft das).

## ⚠ Die Fallen

- **Das GET schreibt nichts, auch nicht den Zähler.** Das Kennzeichen im Vorschlag ist die Vorschau
  (nächste Nummer, belegte übersprungen); vergeben wird es beim Speichern von
  `uems_datenquelle_kennzeichen()` in der Reihenfolge der Liste — wer nur einen späteren Vorschlag
  bestätigt, bekommt die nächste freie Nummer, nicht die gezeigte.
- **Die Box einer Komponente ist nicht `device_id`.** `measurement_point.device_id` tragen nur
  komponierte Zeilen; Vorlagen-, Katalog- und übernommene Zeilen liest die FÜHRENDE Box (dorthin
  geht der Registry-Push), Ladestationen die Box aus `device_charge_point`. Führt keine Box
  (`keine_wahl`), ist das ehrlich `keine_box`.
- **Geschwister = die Gruppierung der Geräte-Ableitung.** `anker` ist das Nicht-Geschwister-Mitglied
  des laufenden Geräts (`geraet_komponente`) — dieselbe Regel wie `uems_geraet_ableiten_fuer`, keine
  zweite.
- **Die Transport-Tabelle ist VOLLSTÄNDIG** (nach AP-06 Soll-Regel 8, Konzept vom Captain am 10.09.2026
  abgenommen): `BestandAnschlussTest`
  hält `BestandAnschluss.TRANSPORTE` gleich mit `builtin.json`, `ComponentTemplateDefinition.COMMUNICATIONS`,
  Selbstbau/Batterie-Anschluss UND den Treiber-Konstanten der Box (liest `edge-app/core/internal/inverter/
  inverter.go` + `componentapply.go`). Ein neuer Treiber an der Box macht den Test rot, bis er eine Zeile
  hier und in §8 hat. `protokoll_unbekannt` ist nur die Rückwand für fremde Wörter.
- **Deye = `solarman_v5`, eigenes Protokoll-Wort** (nie `modbus_tcp`): Adresse `host:port/seriennummer`
  (`DatenquelleAdresse`, Port fehlend 8899, ohne Logger-Seriennummer keine Adresse), `mb_slave_id` als
  Geräte-ID. Fehlender Port/Geräte-ID = Vorgabe des Treibers (0 wie „fehlt“, außer im Selbstbau).
  `mqtt_local` mit mehreren Themen hat keine Adresse; ein fehlender Takt bleibt NULL.
- **Reihenbeginn** = erste Speisung der Komponente, frühestens ab Ankunft der Box in ihrer Anlage
  (nächste volle Minute) — der EINZIGE rückwirkende Zeitraum und Protokoll-Eintrag (`gilt_ab`).
- **Bestätigt wird nur, was gezeigt wurde** (Box, Protokoll, Adresse, Komponenten): sonst 409
  `vorschlag_geaendert`; eine inzwischen versorgte Komponente (auch über ihr Gerät) 409
  `komponente_hat_quelle`; eine an der Box schon vergebene Adresse 409 `adresse_an_box_vergeben`
  (die Liste zeigt sie vorher mit `grund`). Zwei Bestätigungen derselben Anlage serialisiert
  `pg_advisory_xact_lock`; die zweite zählt `unveraendert`.
- **„Gerät dort hinzufügen“ (seit 21.09.2026):** hat eine gesperrte Zeile genau EINE vorhandene Quelle
  derselben Anlage mit demselben Weg und nicht beendeter Zuständigkeit an ihrer Box (Geräte-IDs ⊆,
  Steuerquelle passend), nennt das GET sie als `ziel`; die Bestätigung MIT `datenquelle_id` hängt die
  Komponenten daran (`angehaengt`, Protokoll `aus_bestand_uebernommen` + `angehaengt: true`, gilt ab
  jetzt). Das ist der Weg nach „Datenquelle anlegen“ von Hand — vorher 409, 0 Komponenten. Ohne
  `datenquelle_id` bleibt es 409; `DatenquelleRegeln` und die Vektoren sind unverändert.
- **Eine Zuweisung „ab jetzt“ beginnt an der nächsten vollen Minute** — wer „liest die Box JETZT“ prüft,
  verliert eine frische Handquelle für bis zu 60 s; das Ziel verlangt darum nur „nicht beendet“.
- **Push-Gleichheit bei EINER Box, Push je Box bei mehreren (seit IP-6).** Flow-Aktivierung und
  `LeadDeviceService` lesen weder `data_source_id` noch die neuen Tabellen; der Registry-Push liest sie
  seit IP-6 (`uems-registry-push-je-box.md`): bei einer Box bleibt er nach der Bestätigung gleich
  (`bisZurBestaetigungAendertSichNichtsUndDanachDieselbenPushes`), bei A9 bekommt die Lese-Box ihren
  eigenen Push mit genau ihrer Quelle. Die Übernahme selbst löst keinen Push aus (IP-7).
