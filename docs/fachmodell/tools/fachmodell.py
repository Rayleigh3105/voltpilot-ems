# -*- coding: utf-8 -*-
"""Fachmodell des Unternehmens-Energiemanagements — die EINE Quelle unter `docs/fachmodell/`.

Herkunft: Konzeptpaket AP-00 (Captain-Entscheide E1–E12 vom 10.09.2026), verfeinert durch die
Entscheide der Pakete AP-01 … AP-07 (alle 10.09.2026). Die AP-00-Texte in `GLOSSAR` stehen
byte-verbatim; was ein späteres Paket geschärft, ergänzt oder ERSETZT hat, steht mit Paket- und
Entscheid-Verweis in `VERFEINERUNGEN` (Schlüssel = `id` im Glossar).

`build_fachmodell.py` rendert daraus `glossar.md`, `beziehungen.md`, `zustaende.md` und
`fachmodell.svg`. Nichts von Hand nachpflegen — immer hier ändern und neu bauen.

Belege sind `datei:zeile` am Stand `origin/main` 36f3e7e8 (10.09.2026); Pfade relativ zur
Repo-Wurzel, `MIG` = services/api/src/main/resources/db/migration, `PORTAL` = frontend/portal/src,
`DATA` = die Konzept-Ablage des Programms (nicht in diesem Repo). `tools/check_belege.sh` prüft,
dass jede Datei existiert.
"""

SICHTEN = {
    "ort": ("Ort", "#2563eb"),            # Ortsbaum — Primärblau
    "org": ("Organisation", "#15803d"),   # Prozess-/Kostenstellen-Sicht — Grün
    "el": ("Elektrisch", "#ea580c"),      # elektrischer Baum — Akzent
    "erf": ("Erfassung", "#475569"),      # Box · Datenquelle · Gerät · Komponente · Messkanal — Grau
    "betrieb": ("Betrieb", "#7c3aed"),    # Betriebsmodell, Regel, Steuerart — Violett (übernommen)
    "zustand": ("Zustand", "#1e293b"),
}

# ---------------------------------------------------------------------------------------------
# GLOSSAR — je Begriff: Definition (ein Satz), Erläuterung, Beispiel aus dem Referenzunternehmen,
# heutige Entsprechung im Code (oder „heute nicht vorhanden“), Abgrenzung zu Nachbarbegriffen.
# ---------------------------------------------------------------------------------------------
GLOSSAR = [
    {"id": "kundenbereich", "sicht": "ort", "begriff": "Kundenbereich",
     "kurz": "Der abgeschlossene Datenraum eines Vertragspartners: alles, was seine Benutzer sehen und bedienen dürfen.",
     "lang": "Der Kundenbereich ist die Grenze für Daten, Benutzer und Rechte. Nichts darin ist von außen sichtbar; die Plattform-Administration von VoltPilot kann hineinschauen, aber niemals ein Kunde in einen fremden Bereich (fremde Objekte sind „nicht gefunden“, nie „verboten“).",
     "beispiel": "Kundenbereich KB-AHRENBERG — angelegt 12.03.2024 mit der Bestandsanlage, seit 01.10.2026 mit Unternehmensstruktur.",
     "heute": "Tabelle `tenant` (MIG/V1__core_schema.sql:36-44: id, name, segment CI|B2C, plan; `betriebsart` endkunde|betreiber MIG/V20260720000000__tenant_betriebsart.sql:20); Trennung per Keycloak-Benutzerattribut `tenant_id` in EINEM Realm `voltpilot` (infra/local/keycloak/voltpilot-realm.json:2,187) und Postgres-RLS (MIG/V2__row_level_security.sql:31-36). Kundenwort heute: keines — „Mandant“ ist intern (frontend/portal/AGENTS.md:48) und heißt nur hinter dem Admin-Tor so (PORTAL/nav.ts:280-286).",
     "abgrenzung": "Nicht das Unternehmen (das ist der fachliche Inhalt des Bereichs), nicht der Standort (ein Ort im Unternehmen)."},
    {"id": "unternehmen", "sicht": "ort", "begriff": "Unternehmen",
     "kurz": "Die Organisation des Kunden mit Namen, Rechtsform und Sitz — die Wurzel des Ortsbaums und des Prozessbaums.",
     "lang": "Das Unternehmen ist das, worüber der Kunde berichtet („Unternehmensweiter Bericht“, „unternehmensweite Kennzahl“). Im ersten Umfang gibt es genau EIN Unternehmen je Kundenbereich; es entsteht automatisch aus dem Kundenbereich und trägt dessen Namen (E2). Ein Konzern mit mehreren Gesellschaften ist vorbereitet, nicht ausgebaut.",
     "beispiel": "Kunststoffwerk Ahrenberg GmbH, Sitz Ahrenberg, 180 Mitarbeitende, Zeitzone Europe/Berlin, Geschäftsjahr = Kalenderjahr.",
     "heute": "Heute nicht vorhanden. Suche `grep -rni 'company|organisation|organization' MIG` → nur Prosa (MIG/V20260838000000__site_profil.sql:29-30). Der Name lebt als `tenant.name` (MIG/V1__core_schema.sql:38); eine Registrierung legt Mandant + Keycloak-Login an (docs/agents/root/portal-api-auth-tenancy-rls-services-api.md:35).",
     "abgrenzung": "Kundenbereich = technischer Zaun; Unternehmen = fachliche Wurzel. Bei 1:1 sieht der Kunde nur das Unternehmen."},
    {"id": "standort", "sicht": "ort", "begriff": "Standort",
     "kurz": "Ein räumlich abgegrenzter Ort des Unternehmens mit Adresse, an dem Gebäude, Boxen und Netzanschlüsse liegen.",
     "lang": "Der Standort ist die Rechte-Einheit (AP-03: „Zugriff auf ausgewählte Standorte“) und die Berichts-Einheit unter dem Unternehmen (AP-12). Er trägt Adresse, Zeitzone, Nutzung und Bezugsfläche (AP-02). Ein Standort kann mehrere Netzanschlüsse, mehrere Anlagen und mehrere Boxen haben; er versorgt selbst nichts — die Versorgung ist Sache der Anlage.",
     "beispiel": "ST-1 Werk Ahrenberg (Gewerbering 7; 3 Gebäude, 2 Netzanschlüsse, 2 Anlagen, 2 Boxen) und ST-2 Werk Lindach (2 Gebäude, 1 Anschluss, 1 Anlage, 1 Box).",
     "heute": "Heute nicht vorhanden als Objekt. Das Wort „Standort“ ist im Portal das Koordinaten-Feld der Anlage (PORTAL/pages/AnlageTechnik.tsx:508, :1207); Koordinaten `site.latitude/longitude` (MIG/V20260701010000__site_geo_and_data_feeds.sql:29-30). Keine Adress- und keine Zeitzonen-Spalte (`grep -rni 'address|adresse|plz|timezone' MIG` → nur Kommentare, MIG/V20260719020000__telemetry_v2_rollup_cascade.sql:14 „timezone is future work“).",
     "abgrenzung": "Nicht die Anlage (die ist elektrisch, nicht räumlich); nicht das Gebäude (ein Teil des Standorts). Zwei Standorte sind nie ein elektrisches System. Das Feld „Standort“ in den Anlagen-Einstellungen (Koordinaten) behält seinen Namen (E9: B) — dort ist die Lage der Anlage gemeint, hier das Objekt."},
    {"id": "gebaeude", "sicht": "ort", "begriff": "Gebäude",
     "kurz": "Ein Bauwerk am Standort mit Nutzung, Fläche und Baujahr — die optionale zweite Ebene des Ortsbaums.",
     "lang": "Das Gebäude ist optional (Plan AP-02: „Optionale Gebäudeebene für Außenanlagen oder kleine Standorte“). Eine Messstelle darf direkt am Standort hängen; es wird kein Gebäude erfunden (E3). Gebäude sind Zuordnungsziele für Messstellen und Bezugsflächen, nie Versorgungsgrenzen: ein elektrisches System kann mehrere Gebäude versorgen, ein Gebäude kann aus zwei Systemen versorgt werden.",
     "beispiel": "G-1 Halle 1 (4 200 m²), G-2 Halle 2 (3 100 m²), G-3 Verwaltung (1 150 m²) am Werk Ahrenberg; G-4 Lagerhalle, G-5 Montagehalle am Werk Lindach. Der Zählerplatz NA-1 (MS-01) und der Ladepunkt auf der Außenfläche (MS-14) hängen direkt am Standort.",
     "heute": "Heute nicht vorhanden (`grep -rni 'building|gebaeude' MIG` → 0 Objekte; im Portal kommt „Gebäude“ als Kundenwort nicht vor).",
     "abgrenzung": "Nicht der Bereich (ein Teil des Gebäudes), nicht die Anlage (elektrisch)."},
    {"id": "bereich", "sicht": "ort", "begriff": "Bereich",
     "kurz": "Ein räumlicher Teil eines Gebäudes oder Standorts (Halle Nord, Etage, Technikraum, Außenfläche) — die dritte, optionale Ebene des Ortsbaums.",
     "lang": "Ein Bereich ist räumlich, nicht organisatorisch (E4): „Halle 1 Nord“ ist ein Bereich, „Abteilung Spritzguss“ ist ein Prozess. Bereiche werden nicht verschachtelt (erster Umfang). Ein Bereich kann direkt am Standort hängen, wenn es kein Gebäude gibt.",
     "beispiel": "B-1 Halle 1 Nord (Maschinenreihe SG01–SG06), B-2 Halle 1 Süd (Technikraum mit Druckluft, Kühlung und Box E-1).",
     "heute": "Heute nicht vorhanden (`grep -rni 'bereich\\b' MIG` → 0). `measurement_point.folder` (MIG/V20260709000000__measurement_point.sql:33) ist ein reiner Anzeige-Ordner ohne Bedeutung; das Einheitsmodell hatte „Areas/Floors bewusst NICHT in V1“ (DATA/vp-komponenten-einheit-h2/report.md:268) — durch den Plan vom 10.09.2026 aufgehoben (W2).",
     "abgrenzung": "Nicht Prozess, nicht Kostenstelle (beide organisatorisch, beide gebäudeübergreifend)."},
    {"id": "anlage", "sicht": "el", "begriff": "Anlage",
     "kurz": "Ein elektrisches System an genau einem Standort zusammen mit seinen Komponenten, Boxen, Messstellen und seinem Betrieb (Betriebsmodell, Tarif).",
     "lang": "Die Anlage bleibt das heutige Objekt (E1, Variante A): sie ist die Betriebseinheit, die VoltPilot beobachtet und steuert. Neu ist, dass sie unter einem Standort hängt und dass ihr Ort (Adresse) und ihr Anschluss (Netzanschluss) eigene Objekte werden. Ein reiner Messkunde hat ebenfalls eine Anlage je Netzanschluss — sie heißt dann z. B. „Werk Lindach“ und trägt nur „reine Messung“; das Portal rückt sie für ihn nicht in den Vordergrund (AP-01). Fachlich ist jede Anlage genau EIN elektrisches System (siehe dort).",
     "beispiel": "AN-1 Werk Ahrenberg – Halle 1 (Bestand seit 12.03.2024; PV 240 kWp + Speicher 200 kWh; Lastspitzenkappung läuft; versorgt Halle 1 UND Verwaltung), AN-2 Werk Ahrenberg – Halle 2 (reine Messung), AN-3 Werk Lindach (reine Messung).",
     "heute": "Tabelle `site` (MIG/V1__core_schema.sql:45-52: name, bidding_zone) plus 17 Zusatzspalten — u. a. `plant_kind` (MIG/V20260706010000__site_plant_kind.sql:17), `tarif_art`/`tarif_param_ct_kwh` (MIG/V20260708010000__site_tarif_model.sql:41-44), `max_feed_in_kw` (MIG/V20260716000000__site_max_feed_in_kw.sql:21), `component_authority` box|portal (MIG/V20260817000000__component_authority_and_definitions.sql:42-43), `profil` privat|gewerbe (MIG/V20260838000000__site_profil.sql:45) — und 19 Migrationen mit 24 Verweisen `REFERENCES site(id)` (device, asset, measurement_point, site_profile_state, site_charging_config …). Portal: `#/anlage/{siteId}/…` (PORTAL/nav.ts:504, :612-641), fünf Bereiche Cockpit · Fahrplan · Verlauf · Steuerung · Anlage (PORTAL/anlageNav.ts:16-17, :76). Topic `ems/{tenant}/{site}/{device}/…` (docs/architecture.md:90-94).",
     "abgrenzung": "Nicht der Standort (räumlich, kann mehrere Anlagen haben), nicht der Netzanschluss (der Übergabepunkt der Anlage), nicht die Box (die Hardware in der Anlage)."},
    {"id": "elsystem", "sicht": "el", "begriff": "Elektrisches System",
     "kurz": "Alles, was hinter einem Netzanschluss elektrisch zusammenhängt: Hauptzähler, Unterzähler, Erzeuger, Speicher, Verbraucher — die Bilanzgrenze der Anlage.",
     "lang": "Das elektrische System ist die fachliche Definition dessen, was eine Anlage elektrisch umfasst. Im ersten Umfang gilt: eine Anlage = ein elektrisches System = ein Netzanschluss. Ein System kann mehrere Gebäude versorgen (Referenzfall 4). Zwei Anschlüsse am selben Standort sind zwei Systeme und damit zwei Anlagen (Referenzfall 3), solange sie nicht dauerhaft gekuppelt sind (vorbereitet: 1..n Anschlüsse je System, E6). Ein Steuerungsverbund (AP-15) lebt immer INNERHALB eines elektrischen Systems, nie darüber hinaus.",
     "beispiel": "System hinter NA-1: Hauptzähler MS-01/02, PV MS-03, Speicher MS-04, Unterzähler MS-05…MS-08, Rest MS-09 — es versorgt Halle 1 und die Verwaltung.",
     "heute": "Heute nicht als Objekt, sondern implizit die Anlage mit ihrem einen maßgeblichen Netzpunkt: Rolle `grid` ist „die maßgebliche Messung, nie eine Summe“ (docs/contracts/v2/topology-read-model.md:14-21), 0–1 Netz je Anlage, 409 beim zweiten (docs/agents/root/multi-source-anlage-phase-1-n-erzeuger-p.md:24-29); Energiefluss aus Rollen pv|storage|grid|consumer|charging (docs/contracts/v2/edge-entity.schema.json:348-353).",
     "abgrenzung": "Nicht der Ortsbaum (AP-02: „Elektrische Versorgung wird nicht aus dem Ortsbaum abgeleitet“), nicht die Box (mehrere Boxen können in einem System lesen)."},
    {"id": "netzanschluss", "sicht": "el", "begriff": "Netzanschluss",
     "kurz": "Der Übergabepunkt zum öffentlichen Netz mit Marktlokation, Netzbetreiber, Anschlussleistung und Tarif.",
     "lang": "Der Netzanschluss ist ein eigenes Objekt am Standort (E6). Er trägt, was heute auf der Anlage liegt: vereinbarte Leistung, Einspeisegrenze, Leistungspreis, Arbeitspreis, Vergütung. Sein Hauptzähler ist eine Messstelle mit der elektrischen Stellung „Hauptzähler“. Im ersten Umfang gehört ein Netzanschluss zu genau einer Anlage.",
     "beispiel": "NA-1 Hauptanschluss Halle 1 (Marktlokation 47110000001, 630 kVA, vereinbart 550 kW, RLM, 22,4 ct/kWh, 96 €/kW·a), NA-2 Anschluss Halle 2 (250 kVA, 200 kW), NA-3 Anschluss Lindach (160 kVA, 120 kW).",
     "heute": "Heute nicht als Objekt; seine Eigenschaften liegen auf `site`: `max_feed_in_kw` (MIG/V20260716000000__site_max_feed_in_kw.sql:21), `leistungspreis_eur_kw`/`abrechnung_leistung` (MIG/V20260716020000__peak_shaving_master_data.sql:44-50), `tarif_art`/`tarif_param_ct_kwh` (MIG/V20260708010000__site_tarif_model.sql:41-44), `anzulegender_wert_ct_kwh` (MIG/V20260707020000__anzulegender_wert_and_monthly_market_value.sql:44), `netzladen_erlaubt` (MIG/V20260707000000__site_netzladen_erlaubt.sql:21). Portal-Erklärtext „Name, Standort, Veräußerungsform und Netzanschluss“ (PORTAL/pages/AnlageTechnik.tsx:486) und Feld „Maximale Einspeiseleistung am Netzanschlusspunkt“ (PORTAL/pages/AnlageTechnik.tsx:547). Der Netzzähler ist die Komponente mit Rolle `grid`.",
     "abgrenzung": "Nicht das elektrische System (das hängt dahinter), nicht der Hauptzähler (eine Messstelle AM Anschluss)."},
    {"id": "box", "sicht": "erf", "begriff": "Box (Edge)",
     "kurz": "Die VoltPilot-Hardware beim Kunden, die Datenquellen liest, Werte puffert und Pläne unter eigenen Wächtern ausführt.",
     "lang": "Eine Box hat genau eine Heimat-Anlage (E7, unverändert: sie ist die Topic-Adresse) und liest die Datenquellen, für die sie zuständig ist (AP-06, zeitgültig). Mehrere Boxen an einem Standort sind normal; mehrere Boxen in EINER Anlage sind der Fall für AP-06/AP-15. Zwei Boxen sind noch kein Steuerungsverbund.",
     "beispiel": "E-1 Box Halle 1 (Bestand, liest Wechselrichter, Netzzähler, vier Unterzähler; steuert den Wechselrichter), E-2 Box Halle 2 (liest WAGO C-1 und den Ladepunkt), E-3 Box Lindach.",
     "heute": "Tabelle `device` (MIG/V1__core_schema.sql:54-62: external_ref, kind, status unclaimed|claimed ohne CHECK — einzige Schreibstelle services/api/src/main/java/com/voltpilot/api/repo/DeviceRepository.java:72), `device_enrollment` (MIG/V20260702040000__device_enrollment.sql:27-37), `device_edge_version` (MIG/V20260803000000__device_edge_version.sql:24-30), `lan_host`/`lan_seen_at` (MIG/V20260832000000__device_lan_address.sql:30-32). „Online“ = MAX(telemetry.received_at) im 5-Minuten-Fenster (services/api/src/main/java/com/voltpilot/api/repo/OverviewRepository.java:29-31). Umzug: `device_site_assignment.effective_at` (MIG/V20260843000000__component_edit_contract.sql:54-67). Kundenwort „VoltPilot-Box“ (PORTAL/komponenten.ts:268, :311-313), Box-Seite `#/anlage/{siteId}/box` (PORTAL/nav.ts:881).",
     "abgrenzung": "Nicht das Gerät (das hängt hinter der Box), nicht die Datenquelle (der Weg zum Gerät)."},
    {"id": "datenquelle", "sicht": "erf", "begriff": "Datenquelle",
     "kurz": "Ein von einer Box erreichbarer Erfassungsweg — Adresse plus Protokoll — hinter dem ein oder mehrere Geräte antworten.",
     "lang": "Die Datenquelle ist der technische Zugang (Modbus TCP Host/Port/Geräte-ID, MQTT-Themen, HTTP-Auskunft, OCPP-Station). Sie gehört zeitgültig zu genau einer zuständigen Box (AP-06). Ein Controller mit mehreren Karten oder ein Gateway mit mehreren Zählern ist EINE Datenquelle mit mehreren Geräten. „Datenquelle“ ist ein Fachwort für Einrichtende, kein Wort der Auswertungsflächen.",
     "beispiel": "DQ-3: Modbus TCP 192.168.10.31, Geräte-IDs 1–4 — vier Unterzähler hinter einer Adresse, zuständig Box E-1. DQ-5: OCPP-Station AHR-LP-01, die sich selbst zur Box E-2 verbindet.",
     "heute": "Kein Objekt. Transport-Wahrheit je Komponente in `measurement_point.communication/family/connection_json` (MIG/V20260709000000__measurement_point.sql:38-43), historisiert in `component_definition.connection_json` (MIG/V20260817000000__component_authority_and_definitions.sql:82-93); „Der Lesepfad reist im Flow“ (docs/contracts/v2/edge-entity-config.md:192-194); Lesetypen `vp.modbus.read`, `vp.mqtt.read`, `vp.http.read` sind Flow-Knoten (services/api/src/main/resources/flowcatalog/catalog.json:769,904,1046). Ist-Rückmeldung je Quelle `device_source_status.health` ok|stale|never (MIG/V20260721000000__device_source_status.sql:24-41). Zuständige Box = `measurement_point.device_id` bzw. `entity_registry_state.device_id` je Anlage (MIG/V20260709000000:48; MIG/V20260719030000__entity_sync_state.sql:24-27). Im Portal ist „Datenquelle“ heute nur die MaStR-Herkunft (PORTAL/components/MastrDrawer.tsx:276).",
     "abgrenzung": "Nicht das Gerät (was antwortet), nicht der Messkanal (was gelesen wird), nicht die Box (wer liest)."},
    {"id": "geraet", "sicht": "erf", "begriff": "Gerät (physisches Messgerät, Controller, Energiekarte)",
     "kurz": "Das physische Kästchen hinter der Box — Wechselrichter, Zähler, Ladestation oder ein Controller mit Energiekarten — mit Hersteller, Typ und Seriennummer.",
     "lang": "„Gerät“ folgt dem entschiedenen Naming Set A (Komponente · Gerät · VoltPilot-Box). Ein Gerät kann mehrere Komponenten speisen. Ein physisches Messgerät ist ein Gerät in seiner messenden Rolle; ein Zählerwechsel ist ein neues Gerät an derselben Komponente und derselben Messstelle (AP-04). Ein Controller (z. B. WAGO) ist ein Gerät, das Energiekarten trägt; jede Energiekarte speist eine Komponente (E12; Hardware-Details AP-05).",
     "beispiel": "GR-1 Hybrid-Wechselrichter (speist K-1 Wechselrichter und K-2 Speicher), GR-4 Unterzähler Spritzguss (Z-5a, ab 18.11.2026 Z-5b), GR-7 WAGO-Controller C-1 mit EK-1…EK-4.",
     "heute": "Naming Set A entschieden (DATA/vp-komponenten-einheit-h2/report.md:923-924, :758-762; „EIN Gerät speist MEHRERE Komponenten“ :766-767); Portal „Gerät = a physical box the edge reports BEHIND the VoltPilot-Box“ (PORTAL/komponenten.ts:234-249); Vertrag `driver` brand/model/family/communication/connection (docs/contracts/v2/edge-entity.schema.json:296, :365-367); `edge_source_id` (MIG/V20260720010000__u2_geraete_adoption.sql:27). Controller/Energiekarte heute nicht vorhanden — nächstes: `modbus-generic` (services/api/src/main/resources/entitytypes/catalog.json:352) und Selbstbau-Tür (services/api/src/main/java/com/voltpilot/api/components/SelfBuildDefinition.java:54).",
     "abgrenzung": "Nicht die Komponente (das EMS-Objekt), nicht die Datenquelle (der Weg)."},
    {"id": "komponente", "sicht": "erf", "begriff": "Komponente",
     "kurz": "Das EMS-Objekt in einer Anlage, das misst und/oder gesteuert wird — mit Rolle im Energiefluss, Messkanälen und Freigabe-Zustand.",
     "lang": "Unverändert aus dem Einheitsmodell: die Komponente ist die Zeile, die der Kunde als „Wechselrichter“, „Speicher“, „Zähler Halle 2“ oder „Ladepunkt“ sieht. Sie gehört zu genau einer Anlage (elektrisches System) und wird von genau einem Gerät gespeist. Ihre Messkanäle sind die Quellen der logischen Messstellen. Steuern ist eine getrennte Freigabe je Komponente („Steuern freigeben“).",
     "beispiel": "K-1 Wechselrichter, K-2 Speicher, K-3 Netzzähler Halle 1, K-8.1…K-8.4 Zähler je Energiekarte, K-9 Ladepunkt (bis 30.11.2026 „Nur messen“).",
     "heute": "`measurement_point` mit `entity_type` = v2-Entität (MIG/V20260718000000__v2_entity_registry.sql:4-5, :22-24), Basis MIG/V20260709000000__measurement_point.sql:27-60 (role, label, brand, model, communication, connection_json, unit, device_id, control, capacity_kwp); `source_kind` builtin|certified|custom|composed (MIG/V20260815000000__component_template.sql:208-221). Kundenwort „Komponente“ statt „Entität“/„Anlagenteil“ (PORTAL/copy.test.ts:77,80). Freigabe-Stufen „Nur messen / Von VoltPilot freigegeben / Geprüfte Vorlage / Von Ihnen freigegeben“ (PORTAL/schaltFreigabe.ts:401-434). Kein Status-/Aktiv-/Archiv-Feld (17× `ALTER TABLE measurement_point`, keines fügt eines hinzu).",
     "abgrenzung": "Nicht das Gerät (physisch), nicht die Messstelle (fachlich, überlebt die Komponente)."},
    {"id": "messkanal", "sicht": "erf", "begriff": "Messkanal",
     "kurz": "Eine einzelne gelesene Größe einer Komponente — benannt nach dem Messpunkt-Katalog, mit Einheit, Wertart und Qualität je Wert.",
     "lang": "Der Messkanal ist die technische Reihe: „Zähler EK-2, Wirkenergie Bezug“. Er entsteht mit der Komponente und stirbt mit ihr; ein neues Gerät hat neue Kanäle. Er ist NIE das, worüber der Kunde berichtet — das ist die Messstelle, der er als führende Quelle dient.",
     "beispiel": "K-3 · Wirkenergie Bezug (Zählerstand, kWh), K-1 · PV-Leistung (Momentanwert, kW), K-9 · Energie je Ladevorgang.",
     "heute": "Kein Objekt, ein String: `channel` in `telemetry_v2(time, tenant_id, site_id, device_id, entity_id, channel, value)` (MIG/V20260718010000__telemetry_v2.sql:27-36) bzw. `point_key` in `device_measurement_sample` mit `quality` good|uncertain|invalid|stale|device_error und `aggregation_kind` gauge|counter|state|event|bitfield|text|none (MIG/V20260848000000__additional_measurement_pipeline.sql:27-55). Katalog mit 2 341 Punkten, Felder point_key/unit/aggregation_kind/… (catalog/measurement-points/README.md:17-28). Einheit nur `measurement_point.unit` Default kW (MIG/V20260709000000:45); Richtung nur als Vorzeichen-Konvention (docs/contracts/v2/mqtt-telemetry-2.0.schema.json:8). Kundenwort „Messwert“, nie „Messpunkt“ (PORTAL/copy.test.ts:78); Auswahl heißt „Beobachtete Register/Messwerte“ (PORTAL/beobachteteRegister.ts:45-60).",
     "abgrenzung": "Nicht die Messstelle (fachliche Identität), nicht die Messgröße (das Attribut)."},
    {"id": "messstelle", "sicht": "zustand", "begriff": "Logische Messstelle",
     "kurz": "Die fachliche Identität einer Messung mit eigenem Kennzeichen, die Gerät, Kanal, Box und Erfassungsweg überlebt — und in allen drei Sichten (Ort, Organisation, elektrisch) zugeordnet ist.",
     "lang": "Die Messstelle ist das zentrale Objekt des Unternehmens-Energiemanagements. Sie hat Kennzeichen (E10), Namen, Messgröße mit Medium (E11), Richtung und Wertart. Sie ist gemessen (führende Quelle = ein Messkanal, zeitgültig; Vergleichsquellen AP-04) oder berechnet (Summe, Differenz, fester Anteil — AP-10). Ihre Zuordnungen zu Ort, Anlage/elektrischer Stellung, Prozess und Kostenstellen sind zeitgültig und bleiben nachvollziehbar. Bis 100 je Kundenbereich im ersten Umfang.",
     "beispiel": "MS-06 „Spritzguss SG01–SG06“: Ort B-1, elektrisch AN-1 Unterzähler von MS-01, Prozess Spritzguss, Kostenstelle 4100, führende Quelle K-5 (Z-5a bis 18.11.2026, danach Z-5b); Oktober 2026: 55 100 kWh.",
     "heute": "Heute nicht vorhanden. Die Identität einer Reihe ist heute (tenant, site, device, entity_id, channel) bzw. (tenant, site, device, point_key) — ein Zählerwechsel ist heute eine neue Reihe. Nächstes: `device_measurement_selection.entity_id` bindet einen Punkt an eine Komponente (MIG/V20260855000000__measurement_selection_per_component.sql:16,44-45), Geräteumzug lässt Historie am alten Ort (MIG/V20260850000000__measurement_history_device_move.sql).",
     "abgrenzung": "Nicht der Messkanal (technisch), nicht die Komponente (Gerätesicht). Ein Zählerwechsel ändert die Quelle, nie die Messstelle."},
    {"id": "messgroesse", "sicht": "zustand", "begriff": "Messgröße, Medium, Einheit, Richtung, Wertart",
     "kurz": "Die Attribute, die sagen, WAS eine Messstelle misst: Medium (Strom, Gas, Wärme, Wasser, Druckluft), Größe (Wirkenergie, Leistung, Volumen), Einheit, Richtung (Bezug, Abgabe, Erzeugung, Laden/Entladen) und Wertart (Zählerstand, Intervallmenge, Momentanwert).",
     "lang": "Das Medium ist ein geschlossenes Vokabular an der Messstelle; im ersten Umfang ist nur „Strom“ wählbar, die anderen sind vorbereitet, nicht ausgebaut (E11). Hier hängt der Haken: Verbrauchsbildung (AP-08) und Katalog kennen nur Strom; ein Gas-Wert bekommt einen Platz, aber keine Auswertung. „Einheit“ ist die physikalische Einheit (kWh, kW, m³) — nicht zu verwechseln mit dem „Einheitsmodell“, dem Namen des vereinheitlichten Komponenten-Modells.",
     "beispiel": "MS-01: Strom · Wirkenergie · kWh · Bezug · Zählerstand + 15-min-Menge. MS-21: Gas · Volumen · m³ · Bezug · Zählerstand monatlich (vorbereitet).",
     "heute": "Medium heute nicht vorhanden (`grep -rniE 'medium|\\bgas\\b|waerme|wasser' MIG` → nur Prosa; Katalog 0 Treffer gas/wasser/wärme, catalog/measurement-points/README.md). Wertart ≈ `aggregation_kind` (catalog/measurement-points/schema/catalog.schema.json:138); Einheit `unit` (MIG/V20260709000000:45); Richtung per Vorzeichen (docs/contracts/v2/mqtt-telemetry-2.0.schema.json:8) und in der Topologie als `direction in|out` (docs/contracts/v2/topology-read-model.md:23-26).",
     "abgrenzung": "Attribute der Messstelle, keine eigenen Objekte."},
    {"id": "prozess", "sicht": "org", "begriff": "Prozess",
     "kurz": "Eine betriebliche Tätigkeit, die Energie einsetzt (Spritzguss, Druckluft, Logistik) — organisatorisch, gebäude- und standortübergreifend.",
     "lang": "Prozesse bilden die zweite Sicht auf dieselben Messstellen. Ein Prozess kann Messstellen in mehreren Gebäuden, Anlagen und Standorten haben. Prozesse dürfen einen übergeordneten Prozess haben (Prozessbaum, eine Ebene). Sie sind der Anker für „wesentliche Energieeinsätze“ (AP-16) und Prozesskennzahlen (AP-11).",
     "beispiel": "P-1 Spritzguss läuft in Halle 1 (MS-06, AN-1) und Halle 2 (MS-11, AN-2); P-2 Montage in Halle 2 und Werk Lindach; P-3 Druckluft ist Querschnitt (70 % Spritzguss, 30 % Montage).",
     "heute": "Heute nicht vorhanden (`grep -rniE '\\bprocess\\b|prozess' MIG` → nur MIG/V20260842000000__flow_claim.sql:8 Prosa).",
     "abgrenzung": "Nicht der Bereich (räumlich), nicht die Kostenstelle (buchhalterisch, mit Prozentaufteilung)."},
    {"id": "kostenstelle", "sicht": "org", "begriff": "Kostenstelle",
     "kurz": "Eine Verrechnungseinheit des Kunden (Nummer + Name), der Energiemengen ganz oder zu festen Anteilen zugeordnet werden.",
     "lang": "Kostenstellen sind flach und kommen aus der Buchhaltung des Kunden. Eine Messstelle kann auf mehrere Kostenstellen mit festen Prozentanteilen verteilt werden (Summe 100 %, Rechnung in AP-10). Die Zuordnung ist zeitgültig: ein neuer Kostenstellenplan verändert keinen alten Bericht.",
     "beispiel": "4100 Spritzguss, 4200 Montage, 4300 Logistik, 9000 Infrastruktur (ab 01.01.2027 aufgeteilt in 9010/9020), 9100 Verwaltung. MS-07 Druckluft: 70 % → 4100, 30 % → 4200.",
     "heute": "Heute nicht vorhanden (`grep -rni 'kostenstelle|cost_center' MIG` → 0).",
     "abgrenzung": "Nicht der Prozess (Tätigkeit), nicht der Bereich (Raum). Prozess und Kostenstelle sind zwei getrennte Achsen (E5)."},
    {"id": "betriebsmodell", "sicht": "betrieb", "begriff": "Betriebsmodell (übernommen)",
     "kurz": "Die vom Kunden gewählte Betriebsweise einer Anlage (Lastspitzenkappung, Marktoptimierung, Atypische Netznutzung); es läuft immer nur eines je Anlage.",
     "lang": "Unverändert übernommen aus Steuerung Stufe 5 und dem Anwendungs-Zielbild: das Betriebsmodell hängt an der Anlage, nie am Standort. „Anwendung“ bleibt das interne Katalogwort; `site.profil` (privat|gewerbe) ist nur Voreinstellung und Tonalität. Für einen reinen Messkunden ist kein Betriebsmodell gewählt — das ist ein vollwertiger Zustand („reine Messung“).",
     "beispiel": "AN-1: Lastspitzenkappung, läuft seit 02.05.2024. AN-2, AN-3: keines (reine Messung). Der Ladepark-Rahmen an NA-2 ab 01.12.2026 ist Schutz, kein Betriebsmodell.",
     "heute": "`site_profile_state(site_id, profile, state an|aus)` (MIG/V20260723000000__site_profile_state.sql:26-36); Katalog services/api/src/main/java/com/voltpilot/api/profile/AnwendungKatalog.java:55-64; Portal „Betriebsmodelle“ als Radiogruppe (PORTAL/components/Betriebsmodelle.tsx:85), „läuft seit …“ (PORTAL/betriebsmodelle.ts:110-137), Grundzustand „Eigenverbrauchs-Fahrplan“ (:274-278); Kundenwort-Regel (PORTAL/copy.test.ts:103-113). Entscheidungen DATA/vp-steuerung-konzept-b3/report.md:146, DATA/vp-portal-zielbild-anwendungen/report.md:324.",
     "abgrenzung": "Nicht die Regel (Ausnahme obendrauf), nicht die Steuerart (Grundverhalten je Verbraucher), nicht der Zustand „steuert“ (Beobachtung)."},
    {"id": "regel", "sicht": "betrieb", "begriff": "Regel und Steuerart (übernommen)",
     "kurz": "Regel = Wenn/Dann-Ausnahme, die immer gewinnt; Steuerart = Grundverhalten je Verbraucher (Quelle + optionales Ziel).",
     "lang": "Beide bleiben, wie in Verbrauchsmanagement v1 entschieden. Für AP-00 relevant ist nur ihre Stellung: sie hängen an Komponenten einer Anlage, nie an Messstellen, Gebäuden oder Prozessen. Ein Messkunde hat keine — und braucht keine, um Messstellen zu pflegen.",
     "beispiel": "Ab 01.12.2026: Ladepunkt K-9 mit Steuerart „Netzschonend laden“ unter dem Ladepark-Rahmen an NA-2 (Referenzfall 5).",
     "heute": "`flow_definition.lifecycle` draft|simulated|active|retired (MIG/V20260719000000__flow_definition.sql:31), `consumer_policy.lifecycle` draft|active|retired (MIG/V20260810000000__consumer_profile_and_policy.sql:94); Kundenwort „Regel“ (PORTAL/copy.test.ts:97); Steuerart = Quelle + Ziel (DATA/vp-verbrauchsmgmt-konzept-v1/captain-scoping.md:24).",
     "abgrenzung": "Nicht das Betriebsmodell (Betriebsweise der Anlage)."},
    {"id": "bezugsgroesse", "sicht": "org", "begriff": "Bezugsgröße (nur Begriff, Ausbau AP-09)",
     "kurz": "Eine nicht-energetische Größe mit Geltungsbereich (Unternehmen, Standort, Gebäude, Prozess), auf die Energie bezogen wird: Produktionsmenge, Betriebszeit, Fläche.",
     "lang": "AP-00 legt nur fest, dass Bezugsgrößen an Objekte des Fachmodells gebunden sind (Geltungsbereich) und zeitabhängig (Menge je Monat) oder Stammdatum (Fläche, zeitgültig) sein können. Eingabe, CSV und Kanalbindung sind AP-09.",
     "beispiel": "BZ-1 Produktionsmenge Spritzguss 312 400 kg im Oktober 2026 (Prozess P-1); BZ-4 Bezugsfläche Halle 1 4 200 m² (Gebäude G-1).",
     "heute": "Heute nicht vorhanden; nächstes: `asset.pv_capacity_kwp` u. a. als Stammdaten (MIG/V20260702010000__asset_registry_link.sql:27-38).",
     "abgrenzung": "Nicht die Messstelle (misst Energie), nicht die Kennzahl (AP-11: Verhältnis aus beidem)."},
    {"id": "benutzer", "sicht": "ort", "begriff": "Benutzer und Rolle (nur Begriff, Rechte-Matrix AP-03)",
     "kurz": "Ein Benutzer gehört zu genau einem Kundenbereich und hat Rollen entweder unternehmensweit oder je Standort.",
     "lang": "AP-00 legt nur den Geltungsbereich fest: Rollen wirken auf das Unternehmen oder auf ausgewählte Standorte (entschieden); der Standort ist deshalb ein Objekt des Fachmodells, nicht nur eine Anzeigegruppe. Feinere Rechte je Gebäude oder Messstelle gibt es im ersten Umfang nicht (AP-03).",
     "beispiel": "Ines Kaltenbach: Energiemanagerin unternehmensweit. Peter Hollerbach: Bearbeiter nur für ST-2. Elektro Brunner: Installateur mit zeitlich begrenztem Zugriff (AP-03).",
     "heute": "Benutzer nur in Keycloak (keine DB-Tabelle: `grep -rn 'CREATE TABLE.*user' MIG` → 0); Realm-Rollen operator, admin (legacy), site-admin (Realm-Rolle OHNE Anlagenbezug), platform-admin, edge-release-publisher (infra/local/keycloak/voltpilot-realm.json:29-45); keine Benutzer↔Anlagen-Zuordnung (`grep -rn 'user_site|site_member|site_access' MIG` → 0); keine Installateur-Rolle (PORTAL/rollen.ts:33); Benutzerverwaltung nur durch Plattform-Admin (services/api/src/main/java/com/voltpilot/api/web/AdminController.java:238-323).",
     "abgrenzung": "Nicht der Kundenbereich (der Zaun), nicht das Unternehmen (die Wurzel)."},
    {"id": "zuordnung", "sicht": "zustand", "begriff": "Zuordnung (zeitgültig)",
     "kurz": "Jede Beziehung, die sich im Leben eines Objekts ändern kann, hat ein „gültig ab“ und ein „gültig bis“ — und wird nie überschrieben, sondern beendet und neu begonnen.",
     "lang": "Zeitgültig sind: Messstelle → Ort, Messstelle → Anlage/elektrische Stellung, Messstelle → Prozess, Messstelle → Kostenstelle (mit Anteil), Messstelle → führende Quelle, Box → Datenquelle (Zuständigkeit), Anlage → Standort, Netzanschluss → Anlage, Komponente → Steuer-Freigabe, Anlage → laufendes Betriebsmodell, Benutzer → Standortrecht. Nicht zeitgültig (Änderung = neues Objekt): Komponente → Gerät, Datenquelle → Gerät, Messstelle → Messgröße. Gebäude/Bereich dürfen selten umgeordnet werden (zeitgültig, AP-02). Ein Bericht liest immer die Zuordnungen seines Zeitraums.",
     "beispiel": "MS-08 Kühlung: Ort B-2 bis 28.02.2027, ab 01.03.2027 B-3; elektrisch AN-1 bis 28.02.2027, ab 01.03.2027 AN-2; Quelle K-7 bis 28.02.2027, ab 01.03.2027 K-8.7.",
     "heute": "Keine `valid_from`/`valid_to` im Modell (`grep -rn 'valid_from|valid_to|effective_from' MIG` → 0). Vorhanden sind Journale: `component_change_event.effective_at` (MIG/V20260843000000__component_edit_contract.sql:8-21), `device_site_assignment.effective_at` (:54-67), Fassungs-Historie `component_definition` (MIG/V20260817000000__component_authority_and_definitions.sql:74-109).",
     "abgrenzung": "Ein Journal sagt, WANN sich etwas geändert hat; eine zeitgültige Zuordnung sagt, WAS in einem Zeitraum galt. Berichte brauchen das Zweite."},
    {"id": "zustaende", "sicht": "zustand", "begriff": "Zustände: aktiv · eingerichtet · liefert Daten · steuert",
     "kurz": "Zwei Zustandsfamilien: der Lebenszyklus, den der Kunde setzt (Entwurf → eingerichtet → aktiv → archiviert, dazu angehalten), und die Beobachtung, die nie jemand setzt (liefert Daten, steuert).",
     "lang": "„eingerichtet“ = alle Pflichtangaben vorhanden und die technische Prüfung bestanden. „aktiv“ = nimmt am Betrieb teil (Auswertung, Bericht, Steuerung). „liefert Daten“ = innerhalb der erwarteten Kadenz kam ein Wert an; sonst „liefert keine Daten seit …“ oder „wartet auf erste Daten“. „steuert“ = Freigabe erteilt UND ein Betriebsmodell oder eine Regel läuft UND die Box bestätigt die Ausführung; sonst „steuert nicht“ mit Grund. Die vier Wörter bedeuten bei jedem Objekt dasselbe; welche davon ein Objekt haben kann, sagt die Zustandstabelle (E8).",
     "beispiel": "AN-1: aktiv · eingerichtet · liefert Daten · steuert. AN-2 am 20.10.2026: aktiv · eingerichtet · liefert Daten · steuert nicht (nichts freigegeben). MS-21 Gas: eingerichtet · aktiv · liefert keine Daten (keine Quelle).",
     "heute": "Kein gemeinsames Vokabular; heute je Tabelle eigene Wörter: `device.status` unclaimed|claimed (MIG/V1__core_schema.sql:60), `site_profile_state.state` an|aus (MIG/V20260723000000:26-36), `device_measurement_selection.apply_status` pending_edge|applied|rejected|first_sample (MIG/V20260841000000__device_measurement_selection.sql:38-39), `component_activation_outbox.status` pending|applied|refused (MIG/V20260843000000:92), Steuer-Scharfschaltung = Existenz einer Zeile `device_control_activation` (MIG/V20260814000000__inverter_control_certification.sql:99-111). „liefert Daten“ ist überall eine Ableitung mit hartem 5-Minuten-Fenster (services/api/src/main/java/com/voltpilot/api/repo/OverviewRepository.java:31; services/api/src/main/java/com/voltpilot/api/repo/AdminFleetRepository.java:50). Kein Aktiv-Status für Anlage und Komponente. Kundenwörter heute: „Liefert Daten / Meldet sich gerade nicht / Wartet auf die ersten Daten“ (PORTAL/komponenten.ts:754-766), „Verbunden“ (PORTAL/komponenten.ts:865-877), „Wird von VoltPilot gesteuert“ (PORTAL/komponenten.ts:307), „läuft seit“ (PORTAL/betriebsmodelle.ts:110-137).",
     "abgrenzung": "„eingerichtet“ ist kein Betrieb; „aktiv“ ist keine Beobachtung; „liefert Daten“ sagt nichts über Steuerung; „steuert“ setzt „liefert Daten“ voraus."},
]

# ---------------------------------------------------------------------------------------------
# BEZIEHUNGEN — (von, Kardinalität, nach, zeitgültig, Bemerkung, Herkunft)
# „Herkunft“ ist AP-00, wo der Stand vom 10.09.2026 unverändert gilt, und sonst das Paket samt
# Entscheid, der die Zeile verfeinert oder ersetzt hat.
# ---------------------------------------------------------------------------------------------
BEZIEHUNGEN = [
    ("Kundenbereich", "1 : 1", "Unternehmen", "nein", "erster Umfang; 1 : n für Konzerne vorbereitet (E2)", "AP-00 E2"),
    ("Unternehmen", "1 : 0..n", "Standort", "nein", "Standorte werden archiviert, nicht gelöscht — Löschen nur ohne jede Historie", "AP-00 · AP-02 E1/E12"),
    ("Standort", "1 : 0..n", "Gebäude", "ja", "Gebäudeebene optional (E3); Umordnen ist selten, aber möglich — alte Berichte bleiben; „gültig ab“ ist ein Tag, wirksam 00:00 Uhr in der Zeitzone des Standorts", "AP-00 E3 · AP-02 E9"),
    ("Gebäude oder Standort", "1 : 0..n", "Bereich", "ja", "räumlich, nicht verschachtelt (E4); optional — nur wo Messstellen feiner als das Gebäude verortet werden; beim Verschieben ziehen Bereiche mit, Messstellen bleiben an ihrem Knoten", "AP-00 E4 · AP-02 E7/E11"),
    ("Standort", "1 : 0..n", "Netzanschluss", "ja", "Anschluss kann hinzukommen oder wegfallen", "AP-00 E6"),
    ("Netzanschluss", "1 : 1", "Anlage (elektrisches System)", "ja", "erster Umfang; gekoppelte Systeme mit 1..n Anschlüssen vorbereitet (E6)", "AP-00 E6"),
    ("Standort", "1 : 0..n", "Anlage", "ja", "Bestandsanlage wird ab Datum zugeordnet; Umzug ist die Ausnahme. Die Funktionen „Messen & Auswerten“ und „Steuern & Optimieren“ gelten JE STANDORT — jede Anlage nimmt einzeln teil", "AP-00 · AP-01 E6 = C"),
    ("Anlage", "1 : 0..n", "Gebäude (versorgt)", "ja", "abgeleitet aus den Orten der Messstellen des Systems — keine Pflege von Hand", "AP-00"),
    ("Anlage", "1 : 0..n", "Box", "ja", "Heimat-Anlage der Box = Topic-Adresse (E7)", "AP-00 E7"),
    ("Anlage", "1 : 0..1", "führende Box", "ja", "gespeicherter, sichtbarer Fakt — nie geraten: Vorgabe ist die Box des primären Speichers, sonst die einzige Box; bei zwei Boxen ohne Speicher wählt der Kundenadministrator sie ausdrücklich. Die führende Box bildet die Anlagen-Summe und empfängt den Fahrplan", "AP-06 E3 (neu)"),
    ("Box", "1 : 0..n", "Datenquelle (zuständig)", "ja", "die Zuständigkeit hängt an der DATENQUELLE, nicht am Gerät und nicht an der Komponente: alle Geräte hinter einem Erfassungsweg liest dieselbe Box, ein Wechsel nimmt alle mit", "AP-00 · AP-06 E2"),
    ("Datenquelle", "1 : 1..n", "Gerät", "nein", "Gerätewechsel = neues Gerät. Die Datenquelle ist seit AP-06 ein EIGENES Objekt (Kennzeichen DQ-x, Anlage, Protokoll, Adresse, Netzlage, Lesetakt) — Komponenten verweisen additiv darauf", "AP-00 · AP-06 E1 (neu)"),
    ("Gerät", "1 : 1..n", "Komponente", "nein", "ein Wechselrichter speist Erzeuger + Speicher; eine Energiekarte speist einen Zähler (E12). Identität einer Karte = (Gerät, Steckplatz)", "AP-00 E12 · AP-05 E4"),
    ("Anlage", "1 : 0..n", "Komponente", "ja", "Umzug einer Komponente in ein anderes System ist die Ausnahme", "AP-00"),
    ("Komponente", "1 : 1..n", "Messkanal", "nein", "aus dem Messpunkt-Katalog", "AP-00"),
    ("Komponente + Messkanal", "1 : 1", "Messreihe", "nein", "⚠ ERSETZT AP-00 §6.4 „die Reihe bleibt am Gerät geschlüsselt“: die Reihe ist an der KOMPONENTE geschlüsselt; Gerät samt Einbau, lesende Box, Einstellungs-Fassung und Katalogstand reisen als Herkunft JE WERT mit; eine Gerätegrenze ist ein Ereignis", "AP-07 E2 (ersetzt, AP-07 W1)"),
    ("Messstelle", "1 : 1", "Hauptgröße", "nein", "⚠ ERSETZT AP-00 §4.2 „Messstelle 1 : 1 Messgröße“: die 1 : 1-Regel gilt für die HAUPTGRÖSSE — identitätsstiftend, nie änderbar", "AP-04 E1 (ersetzt, AP-04 W1)"),
    ("Messstelle", "1 : 0..n", "Nebengröße", "nein", "desselben Messortes, jede mit eigener führender Quelle; Nebengrößen tragen nie Bilanz oder Bericht. Bei einer Energiekarte ist der Zählerstand die Hauptgröße, die Wirkleistung eine Nebengröße", "AP-04 E1 (neu) · AP-05 E3"),
    ("Messkanal", "0..1 : 0..1", "Messstelle (führende Quelle)", "ja", "je Zeitpunkt höchstens eine führende Quelle je Größe; Vergleichsquellen 0..n mit Zweck (Plausibilität · Ersatz bei Ausfall · Abrechnungszähler), beide Werte werden nebeneinander gezeigt — ohne Bewertung, ohne Ersatz. Wandlerfaktor und Einstellungen hängen an der QUELLE, die Messstelle bleibt hardwarefrei", "AP-00 · AP-04 E1/E3/E4 · AP-05 E4"),
    ("Messstelle", "n : 1", "Ort (Standort | Gebäude | Bereich)", "ja", "genau ein Ort je Zeitpunkt; direkt am Standort erlaubt (E3)", "AP-00 E3"),
    ("Messstelle", "n : 0..1", "Anlage + elektrische Stellung (Hauptzähler | Unterzähler von … | Erzeuger | Speicher | Abzweig)", "ja", "berechnete und nicht-elektrische Messstellen ohne Stellung. „Unterzähler von …“ bezieht sich auf die übergeordnete MESSSTELLE derselben Anlage, nicht auf eine Komponente", "AP-00 · AP-04 E12"),
    ("Messstelle", "n : 0..n", "Prozess", "ja", "eine Messstelle kann mehreren Prozessen dienen (Ausnahme), ein Prozess vielen Messstellen (Regel)", "AP-00 E5"),
    ("Messstelle", "n : 0..n", "Kostenstelle (mit festem Anteil, Summe 100 %)", "ja", "Rechenregel in AP-10", "AP-00 E5"),
    ("Messstelle (berechnet)", "1 : 1..n", "Messstelle (Eingang)", "ja", "Identität ja, Formel in AP-10; bis dahin bietet der Dialog „berechnet“ nicht an", "AP-00 · AP-04 E9"),
    ("Anlage", "1 : 0..1", "laufendes Betriebsmodell", "ja", "„läuft seit“; keines = reine Messung oder Eigenverbrauchs-Fahrplan. Eine Anlage ohne aktive Teilnahme ist im Ruhe-Zustand ohne Enddatum — alles bleibt gespeichert, nur Fahrplan, Regeln und Steuerarten wirken nicht", "AP-00 · AP-01 E7/E8"),
    ("Komponente", "1 : 0..1", "Steuer-Freigabe", "ja", "freigegeben am / zurückgenommen am", "AP-00"),
    ("Benutzer", "n : 1", "Kundenbereich", "nein", "Ausnahme: das Partner-Konto eines Unterstützers hat keinen Heimat-Kundenbereich und sieht nur gewährte Unterstützungen", "AP-00 · AP-03 E7"),
    ("Benutzer", "n : 0..n", "Rolle × Standort (Zuweisung, befristbar)", "ja", "Rollen: Kundenadministrator und Energiemanager unternehmensweit; Bearbeiter, Bedienberechtigt und Leser je Standort; Unterstützer (Installateur | VoltPilot) befristet. Standort-Zuweisung ist eine ausdrückliche Liste — neue Standorte müssen zugewiesen werden", "AP-00 · AP-03 E1/E3/E5/E11"),
    ("Bezugsgröße", "n : 1", "Geltungsbereich (Unternehmen | Standort | Gebäude | Prozess)", "ja", "AP-09; Bezugsfläche als Intervall je Standort, Gebäude, Bereich", "AP-00 · AP-02 E3"),
]

# ---------------------------------------------------------------------------------------------
# ZUSTÄNDE — Definitionen und Matrix je Objekt
# ---------------------------------------------------------------------------------------------
ZUSTAND_DEFINITIONEN = [
    ("Entwurf", "Lebenszyklus", "Objekt angelegt, Pflichtangaben unvollständig oder Prüfung nicht bestanden. Zählt in keiner Auswertung.", "„Noch nicht eingerichtet — es fehlt: …“"),
    ("eingerichtet", "Lebenszyklus", "Alle Pflichtangaben vorhanden und die technische Prüfung bestanden (Verbindungstest, Quelle gebunden, Anschluss zugeordnet).", "„Eingerichtet am 01.10.2026“"),
    ("aktiv", "Lebenszyklus", "Nimmt am Betrieb teil: erscheint in Auswertungen, Berichten, Steuerung. Wird mit der Einrichtung automatisch aktiv, außer bei Funktionen, die der Kunde ausdrücklich startet (Betriebsmodell, Steuerung).", "kein Abzeichen — der Normalzustand"),
    ("angehalten", "Lebenszyklus", "Vom Kunden vorübergehend aus dem Betrieb genommen; Daten und Zuordnungen bleiben; Wiederaufnahme ohne Neu-Einrichtung.", "„Angehalten seit 03.11.2026 — Fortsetzen“"),
    ("archiviert", "Lebenszyklus", "Endgültig beendet; Daten und Historie bleiben lesbar und in alten Berichten unverändert; keine neuen Werte, keine neuen Zuordnungen.", "„Archiviert am …“, ausgegraut, in Berichten des alten Zeitraums weiterhin vorhanden"),
    ("liefert Daten", "Beobachtung", "Innerhalb der erwarteten Kadenz plus Toleranz kam ein Wert mit Qualität „gut“ an. Nie von Hand gesetzt.", "„Liefert Daten“ · „Liefert keine Daten seit 14:00 Uhr“ · „Wartet auf erste Daten“"),
    ("steuert", "Beobachtung", "Steuer-Freigabe erteilt UND ein Betriebsmodell oder eine Regel läuft UND die Box bestätigt die Ausführung. Nie von Hand gesetzt.", "„Wird von VoltPilot gesteuert“ · „Steuert nicht — nicht freigegeben“ · „Steuert nicht — Box meldet sich nicht“"),
]

# Spalten: Objekt · Entwurf · eingerichtet · aktiv/angehalten/archiviert · liefert Daten · steuert · was der Kunde sieht
ZUSTAND_MATRIX = [
    ("Kundenbereich", "—", "immer (mit Registrierung)", "aktiv | archiviert (Offboarding)", "—", "—", "nichts — der Bereich ist unsichtbar; der Kunde sieht sein Unternehmen"),
    ("Unternehmen", "—", "immer (automatisch)", "aktiv", "abgeleitet: „x von y Messstellen liefern Daten“", "abgeleitet: „x von y Anlagen steuern“", "Kopfzeile: Unternehmensname, Zahl der Standorte, Datenlage"),
    ("Standort", "ja (Name fehlt)", "Name + Adresse + Zeitzone", "aktiv | archiviert (nur ohne aktive Anlagen)", "abgeleitet über seine Messstellen", "abgeleitet über seine Anlagen", "Standortkarte: „2 Anlagen · 1 steuert · 14 von 14 Messstellen liefern Daten“"),
    ("Gebäude / Bereich", "ja", "Name (+ Fläche für Kennzahlen)", "aktiv | archiviert", "abgeleitet über zugeordnete Messstellen", "—", "Zeile im Ortsbaum mit Monatsverbrauch und Datenlage"),
    ("Netzanschluss", "ja", "Marktlokation + vereinbarte Leistung + Anlage", "aktiv | archiviert (gekündigt)", "abgeleitet über den Hauptzähler", "—", "„Hauptanschluss Halle 1 · 550 kW vereinbart · Hauptzähler liefert Daten“"),
    ("Anlage", "ja (kein Anschluss)", "Standort + Netzanschluss + ≥ 1 Komponente oder Messstelle", "aktiv | angehalten (Anlage in Ruhe) | archiviert (Betriebsmodell muss aus sein)", "abgeleitet: alle Boxen verbunden UND Hauptzähler liefert", "genau dann, wenn ≥ 1 Komponente steuert", "heutiges Cockpit; neu: Zeile unter dem Standort mit „reine Messung“ oder „Lastspitzenkappung läuft seit …“"),
    ("Box", "ja (registriert, nicht angemeldet)", "angemeldet (Zertifikat ausgestellt) + Heimat-Anlage", "aktiv | archiviert (ausgebaut)", "„Verbunden“ = Heartbeat in der Kadenz", "führt gerade Kommandos einer freigegebenen Komponente aus", "Box-Seite: „Verbunden · liest 3 Datenquellen · steuert 1 Komponente“"),
    ("Datenquelle", "ja (Adresse fehlt)", "Verbindungstest bestanden + zuständige Box", "aktiv | angehalten (Box liest nicht) | archiviert", "letzte erfolgreiche Lesung in der Kadenz", "—", "nur auf Einrichtungsflächen: „Modbus 192.168.10.31 · zuständig Box Halle 1 · zuletzt gelesen 10:15“"),
    ("Gerät", "ja (nicht identifiziert)", "Hersteller/Typ erkannt oder eingegeben", "aktiv | archiviert (ausgebaut, z. B. alter Zähler)", "abgeleitet über seine Komponenten", "—", "Geräteseite wie heute; ein ausgebauter Zähler bleibt als „ausgebaut am 18.11.2026“ lesbar"),
    ("Komponente", "ja", "Verbindungstest bestanden + Rolle + Anlage (heute: Anlege-Weg)", "aktiv | angehalten | archiviert", "„Liefert Daten / Meldet sich gerade nicht / Wartet auf erste Daten“ (heutige Wörter bleiben)", "„Wird von VoltPilot gesteuert“ — nur mit Freigabe UND laufendem Betriebsmodell/Regel", "Komponentenkarte wie heute, ergänzt um „speist Messstellen MS-05, MS-06“"),
    ("Messkanal", "—", "mit der Komponente", "mit der Komponente", "je Wert: Qualität gut/unsicher/ungültig/veraltet/Gerätefehler", "—", "„Beobachtete Messwerte“ wie heute"),
    ("Messstelle (gemessen)", "ja (Kennzeichen/Messgröße fehlt)", "Kennzeichen + Messgröße + Ort; Quelle darf fehlen", "aktiv | angehalten | archiviert", "über die führende Quelle; ohne Quelle: „keine Datenquelle“", "— (eine Messstelle steuert nie)", "Messstellenliste: „MS-06 Spritzguss SG01–SG06 · 148,6 kW · liefert Daten“"),
    ("Messstelle (berechnet)", "ja (Formel unvollständig)", "Formel + alle Eingänge eingerichtet", "aktiv | archiviert", "„vollständig“ nur, wenn alle Eingänge liefern; sonst „unvollständig (fehlt: MS-12)“", "—", "„berechnet aus 3 Messstellen · unvollständig seit 14:00“"),
    ("Prozess / Kostenstelle", "ja", "Name (+ Nummer)", "aktiv | archiviert (Kostenstellenplan-Wechsel)", "abgeleitet über zugeordnete Messstellen", "—", "Zeile in der Prozess-/Kostenstellensicht mit Monatswert"),
    ("Betriebsmodell (übernommen)", "—", "Voraussetzungen der Anlage erfüllt", "läuft | gewählt, wartet — Grund | aus", "—", "„läuft seit …“ = steuert", "Radiogruppe wie heute"),
]

ZUSTAND_UEBERGAENGE = [
    ("Entwurf → eingerichtet", "Kunde vervollständigt Pflichtangaben; technische Prüfung (Verbindungstest, Quelle gebunden) bestanden.", "Assistent sagt, was fehlt; kein Objekt wird ohne Prüfung eingerichtet."),
    ("eingerichtet → aktiv", "Automatisch für Struktur- und Messobjekte; ausdrücklicher Start für Betriebsmodelle und Steuerung („nach technischen Prüfungen starten“).", "Das Hinzufügen einer Funktion löst keine Steuerung aus (AP-01-Grenze): „Steuern freigeben“ bleibt ein eigener Schritt."),
    ("aktiv → angehalten → aktiv", "Kunde hält an (Anlage in Ruhe, Messstelle stillgelegt für Umbau) und setzt fort.", "Zuordnungen und Daten bleiben; die Lücke bleibt sichtbar, nie aufgefüllt."),
    ("aktiv → archiviert", "Kunde beendet; bei einer Anlage muss das Betriebsmodell aus sein, bei einem Standort dürfen keine aktiven Anlagen bleiben.", "Alte Berichte bleiben unverändert; das Objekt bleibt lesbar; ein Wiederbeleben ist ein neues Objekt (Ausnahme: Standort/Gebäude dürfen reaktiviert werden)."),
    ("liefert Daten ↔ liefert keine Daten", "Beobachtung je Kadenz; Toleranz = 3 × Kadenz (AP-07 E9), mindestens 5 Minuten (heutiges Fenster), höchstens 1 Tag (Zähler mit Tageswerten).", "Text nennt immer den Zeitpunkt: „seit 14:00 Uhr“; Schweigen ist nie ein bewiesener Fehlschlag."),
    ("steuert ↔ steuert nicht", "Beobachtung: Freigabe UND laufendes Betriebsmodell/Regel UND Box-Bestätigung; fehlt eines, „steuert nicht — Grund“.", "Der Grund ist einer der bekannten Wächter-/Wartegründe (Steuerung Stufe 5), nie geraten."),
]
WIDERSPRUECHE = [
    {"id": "W1", "titel": "„Eine Edge je Anlage liest alle Punkte“ vs. mehrere Boxen",
     "alt": "Multi-Source-Konzept: „Devices/certs/claim … unchanged (all points read through the one edge)“ (DATA/vp-multisource-edge-design/report.md:245); höchstens EINE `control=true`-Quelle je Anlage (:228-232).",
     "neu": "Plan „Bereits entschieden“: gemeinsame Optimierung mehrerer Edges innerhalb eines verbundenen elektrischen Systems (AP-15); Referenzfall 3 mit zwei Edges an einem Standort.",
     "aufloesung": "Kein Widerspruch für Referenzfall 3: zwei Boxen an einem Standort liegen in zwei Anlagen. Mehrere Boxen in EINER Anlage sind ab AP-06 zugelassen (Lesen) und ab AP-15 (Steuern); bis dahin gilt der alte Satz je Anlage weiter. Das Fachmodell trägt die Beziehung Anlage 1 : 0..n Box bereits jetzt."},
    {"id": "W2", "titel": "„Areas/Floors bewusst NICHT in V1“ vs. Ortsbaum",
     "alt": "Einheitsmodell: „Areas/Floors — bewusst NICHT in V1: die Anlage ist der Scope; ‚Bereiche' sind ein Später-Kandidat“ (DATA/vp-komponenten-einheit-h2/report.md:268).",
     "neu": "Plan vom 10.09.2026: Standorte, Gebäude, Bereiche werden Objekte (AP-02).",
     "aufloesung": "Der alte Satz war eine Abgrenzung für das Komponenten-Modell, kein Verbot; der Plan hebt ihn auf. Die Komponente bleibt anlagengebunden — der Ortsbaum ordnet Messstellen zu, nicht Komponenten."},
    {"id": "W3", "titel": "Realm-Rolle `site-admin` heißt wie ein künftiges Standortrecht",
     "alt": "Keycloak-Rolle `site-admin` ist eine mandantenweite Realm-Rolle ohne Anlagen- oder Standortbezug (infra/local/keycloak/voltpilot-realm.json:37; geprüft in services/api/src/main/java/com/voltpilot/api/web/SiteOcppControlController.java:51).",
     "neu": "AP-03: standortbezogene Leser, Bearbeiter, Bedienberechtigte.",
     "aufloesung": "Kein fachlicher Widerspruch, aber eine Namensfalle: AP-03 muss die Rolle umbenennen oder ausdrücklich als „Bedienberechtigt (mandantenweit)“ führen. AP-00 merkt es nur an."},
    {"id": "W4", "titel": "„Standort“ ist heute ein Feld der Anlage",
     "alt": "Portal-Feld „Standort“ = Koordinaten + Gebotszone (PORTAL/pages/AnlageTechnik.tsx:508, :1207).",
     "neu": "Standort wird ein Objekt mit Adresse, Zeitzone, Gebäuden.",
     "aufloesung": "E9, entschieden am 10.09.2026: Option B — beide Bedeutungen bleiben; die Unterscheidung leistet der Kontext der Fläche (heute schon „Standort auf der Karte“, PORTAL/pages/AnlageTechnik.tsx:1207). AP-01/AP-02 formulieren jede Fläche so, dass klar ist, ob die Lage einer Anlage oder das Objekt Standort gemeint ist."},
]

# ---------------------------------------------------------------------------------------------
# NACHBARPAKETE — was AP-00 festlegt, was dort bleibt
# ---------------------------------------------------------------------------------------------
NACHBARN = [
    ("AP-01 Portalaufbau", "die Objekte und Zustände, die die Navigation zeigt (Unternehmen → Standort → Anlage; sichtbar/begonnen/aktiv = Entwurf/eingerichtet/aktiv)", "wie Einstieg, Assistenten und Startansichten aussehen"),
    ("AP-02 Ortsstruktur", "Standort, Gebäude, Bereich als Objekte, ihre Kardinalitäten und dass Zuordnungen zeitgültig sind", "Anlegen, Bearbeiten, Verschieben, Archivieren, Stammdatenfelder, Historiendarstellung"),
    ("AP-03 Rechte", "Geltungsbereiche „Unternehmen“ und „Standort“ als Objekte; Benutzer gehört zu einem Kundenbereich", "die Rechte-Matrix, Rollen, Unterstützerzugriff, Entzug"),
    ("AP-04 Messstellenregister", "Messstelle, Messkanal, Gerät, Datenquelle, führende Quelle als Begriffe; Zuordnungen zu Ort, Prozess, System; Zählerwechsel ändert die Quelle, nie die Messstelle", "Anlegen, Wandlerfaktoren, Vergleichsquellen, Austauschabläufe, Zuständigkeitswechsel"),
    ("AP-05 WAGO", "Controller = Gerät, Energiekarte speist eine Komponente (E12), Datenquelle = Erfassungsweg", "welche Hardware, welche Register, welche Skalierung"),
    ("AP-06 Mehrere Edges", "Box hat eine Heimat-Anlage; Zuständigkeit je Datenquelle ist zeitgültig (E7)", "Konfigurationszustellung, Rückmeldung je Box, Ausfallsichtbarkeit, VLANs"),
    ("AP-07 Messdatenstrecke", "die Reihe bleibt am Gerät geschlüsselt; die Messstelle liegt darüber", "Herkunft je Stufe, Nachlieferung, Speicherklassen"),
    ("AP-08 Verbrauchsbildung", "Wertart (Zählerstand, Intervallmenge, Momentanwert) und Richtung als Attribute der Messstelle", "Rechenregeln, Zählerrücksprung, Ersatzwerte"),
    ("AP-09 Bezugsgrößen", "Bezugsgröße hat einen Geltungsbereich aus dem Fachmodell", "Eingabe, CSV, Kanalbindung"),
    ("AP-10 Bilanzen", "elektrische Stellung (Hauptzähler, Unterzähler von …), Kostenstellen-Anteile, berechnete Messstellen als Begriffe", "Rechenregeln für Summen, Differenzen, Anteile, Bilanzdifferenz"),
    ("AP-11 Kennzahlen", "Messstellen und Bezugsgrößen als Eingänge; Geltungsbereiche", "Formeln, Vorlagen, Editor"),
    ("AP-12 Berichte", "Berichte lesen zeitgültige Zuordnungen ihres Zeitraums", "Vorlagen, Freigabe, Revision"),
    ("AP-13 Oberflächen", "die drei Sichten (Ort, Organisation, elektrisch) auf dieselben Messstellen", "Layout, Drilldown, leere Zustände"),
    ("AP-14 Bestandsübernahme", "das Zielbild je Bestandsanlage (Standort + Netzanschluss entstehen, Anlage bleibt)", "Vorschau, Rücknahme, Pilot, Freigabe"),
    ("AP-15 Verbund", "Verbund = mehrere Boxen INNERHALB eines elektrischen Systems (einer Anlage), nie über Systeme hinweg", "Planer, Aufteilung, Ausfallmatrix"),
]

ENTSCHEIDUNGSLOG = [
    ('10.09.2026', 'E1', 'Option A — Anlage bleibt als Betriebseinheit unter einem Standort. Wortlaut: „Entscheidung E1: Option A“ (Lavish-Review, Kasten E1)'),
    ('10.09.2026', 'E2', 'Option A — 1 : 1, Konzern vorbereitet. Wortlaut: „Entscheidung E2: Option A“ (Lavish-Review, Kasten E2)'),
    ('10.09.2026', 'E3', 'Option A — Messstelle darf direkt am Standort hängen; kein implizites Gebäude. Wortlaut: „Entscheidung E3: Option A“ (Lavish-Review, Kasten E3)'),
    ('10.09.2026', 'E4', 'Option A — räumlich (Teil eines Gebäudes oder Standorts). Wortlaut: „Entscheidung E4: Option A“ (Lavish-Review, Kasten E4)'),
    ('10.09.2026', 'E5', 'Option A — zwei Achsen: Prozessbaum (eine Ebene Verschachtelung) und flache Kostenstellen mit Prozentanteilen. Wortlaut: „Entscheidung E5: Option A“ (Lavish-Review, Kasten E5)'),
    ('10.09.2026', 'E6', 'Option A — eigenes Objekt am Standort, im ersten Umfang genau eines je Anlage; 1..n je System vorbereitet. Wortlaut: „Entscheidung E6: Option A“ (Lavish-Review, Kasten E6)'),
    ('10.09.2026', 'E7', 'Option A — Heimat bleibt die Anlage; Zuständigkeit je Datenquelle ist eine eigene, zeitgültige Beziehung. Wortlaut: „Entscheidung E7: Option A“ (Lavish-Review, Kasten E7)'),
    ('10.09.2026', 'E8', 'Option A — Lebenszyklus (Entwurf · eingerichtet · aktiv · angehalten · archiviert) + Beobachtung (liefert Daten · steuert). Wortlaut: „Entscheidung E8: Option A“ (Lavish-Review, Kasten E8)'),
    ('10.09.2026', 'E9', 'Option B — beides bleibt: Feld der Anlage und Objekt heißen „Standort“; Paket IP-5 entfällt. Wortlaut: „Entscheidung E9: Option B“ (Lavish-Review, Kasten E9)'),
    ('10.09.2026', 'E10', 'Option A — automatisch vergeben (MS-0001 …), vom Kunden änderbar, eindeutig je Kundenbereich. Wortlaut: „Entscheidung E10: Option A“ (Lavish-Review, Kasten E10)'),
    ('10.09.2026', 'E11', 'Option A — geschlossenes Vokabular am Attribut „Medium“ (Strom · Gas · Wärme · Kälte · Wasser · Druckluft); nur „Strom“ wählbar. Wortlaut: „Entscheidung E11: Option A“ (Lavish-Review, Kasten E11)'),
    ('10.09.2026', 'E12', 'Option A — eine Komponente je Energiekarte (Zähler), der Controller ist das Gerät. Wortlaut: „Entscheidung E12: Option A“ (Lavish-Review, Kasten E12)'),
]

# ---------------------------------------------------------------------------------------------
# VERFEINERUNGEN — was die Pakete AP-01 … AP-07 (alle am 10.09.2026 entschieden) an einem
# AP-00-Begriff geschärft, ergänzt oder ERSETZT haben. Schlüssel = `id` im GLOSSAR.
# Der AP-00-Text darüber bleibt byte-verbatim; hier steht, was heute zusätzlich gilt.
# ---------------------------------------------------------------------------------------------
VERFEINERUNGEN = {
    "unternehmen": [
        ("AP-02 E2", "Neben dem Kundenbereich entsteht ein eigenes Objekt „Unternehmen“ (Name, Kurzname, Zeitzone-Vorgabe, Sitz, Rechtsform); 1 : n für Konzerne bleibt vorbereitet."),
        ("AP-03 E10", "Die Unternehmensebene erscheint erst ab zwei zugänglichen Standorten und dann als Teilansicht („Teilansicht: n von m Standorten“); unternehmensweite Kennzahlen, Berichte und Exporte bleiben unsichtbar, solange nicht alle Standorte zugänglich sind."),
    ],
    "standort": [
        ("AP-01 E6 = C", "Die Funktionen „Messen & Auswerten“ und „Steuern & Optimieren“ gelten JE STANDORT; jede Anlage des Standorts nimmt EINZELN teil. Freigabe, Grenze, Betriebsweise, Ruhe und Start bleiben an der Anlage, der Standort trägt den Lebenszyklus der Funktion (AP-01 W7)."),
        ("AP-02 E9", "„gültig ab“ ist ein TAG, wirksam 00:00 Uhr in der Zeitzone des Standorts — die Zeitzone ist damit ein Pflicht-Stammdatum des Standorts."),
        ("AP-02 E1/E12", "Archivieren ist der Normalweg, Löschen nur für Objekte OHNE jede Historie. Archiviert wird nur ohne aktive Messstellen und Anlagen; leere Kinder werden mitarchiviert."),
        ("AP-02 E8/E10", "Kurzzeichen (ST-1, G-1, B-1) werden automatisch vergeben, sind änderbar, je Kundenbereich eindeutig und werden nie wiederverwendet. Ein automatisch angelegter Standort bleibt Entwurf, bis die Adresse steht — sichtbar nur auf Standort-Flächen, er blockiert nichts."),
        ("AP-03 E3/E5", "Der Standort ist die Einheit des Bedienrechts (alle Anlagen des Standorts) und wird ausdrücklich zugewiesen — eine Schnellwahl füllt die Liste, neue Standorte müssen einzeln zugewiesen werden."),
    ],
    "gebaeude": [
        ("AP-02 E3", "Die Bezugsfläche ist zeitgültig: Intervalle mit „gültig ab“ je Standort, Gebäude und Bereich."),
        ("AP-02 E4", "Nutzung ist ein geschlossenes Vokabular mit Mehrfachauswahl; die erste Auswahl ist die Hauptnutzung, „Sonstiges“ trägt eine Notiz."),
        ("AP-02 E11", "Beim Verschieben ziehen Bereiche mit; Messstellen bleiben an ihrem Knoten; Anlagen und Netzanschlüsse ziehen nie automatisch mit."),
    ],
    "bereich": [
        ("AP-02 E7", "Der Bereich ist optional — er wird nur dort angelegt, wo Messstellen feiner als das Gebäude verortet werden."),
    ],
    "anlage": [
        ("AP-01 E7/E8", "Eine Anlage ohne aktive Teilnahme liegt im Ruhe-Zustand OHNE Enddatum; alles bleibt gespeichert, nur Fahrplan, Regeln und Steuerarten wirken nicht. „Steuerung starten“ hebt die Ruhe auf."),
        ("AP-01 Geld-Regel", "Eine reine Messanlage zeigt auf KEINER Ebene Geld: Kontoauszug, Vorteil-Zählung und Marktpreis-Kacheln gehören zu „Steuern & Optimieren“ und zu Anlagen mit Erzeuger oder Speicher."),
        ("AP-02 E5", "Die Zuordnung Anlage → Standort ist zeitgültig und wohnt in einer eigenen Beziehung, nicht in einer Spalte an der Anlage. Ein Bestandskunde mit EINER Anlage bekommt den Standort automatisch, ab mehreren Anlagen als Vorschau-Zuordnung."),
        ("AP-06 E3", "Hat eine Anlage mehrere Boxen, ist EINE davon die „führende Box“ — ein gespeicherter, sichtbarer Fakt (Vorgabe: Box des primären Speichers, sonst die einzige; bei zwei Boxen ohne Speicher wählt der Kundenadministrator sie ausdrücklich). Sie bildet die Anlagen-Summe und empfängt den Fahrplan."),
    ],
    "netzanschluss": [
        ("AP-01 E10", "Die vereinbarte Leistung des Anschlusses ist der Prüfstein: Grenzen werden gegen ihn plausibilisiert."),
    ],
    "box": [
        ("AP-06 E2", "Die Zuständigkeit hängt an der DATENQUELLE, nicht am Gerät und nicht an der Komponente: alle Geräte hinter einem Erfassungsweg liest dieselbe Box, ein Wechsel nimmt alle mit."),
        ("AP-06 E4", "Registry-Push und Mess-Plan werden je Box aus ihren Zuständigkeiten zum Zeitpunkt zusammengesetzt — je Box eine DISJUNKTE Menge; ein Wechsel sind zwei Pushes (erst die alte Box ohne die Quelle, dann die neue mit ihr)."),
        ("AP-06 E5/E12", "Der Herzschlag trägt additive Blöcke `data_sources[]` (Zustand je Quelle) und `supports[]` (Fähigkeiten); bis eine Box das meldet, gilt eine Cloud-Tabelle „Version → Fähigkeiten“."),
        ("AP-06 E6", "Das Lese-Budget bleibt je BOX (physischer Deckel); jede Datenquelle zeigt ihren Anteil, Anlage und Standort die Summe."),
        ("AP-06 E7/E11", "„Box tauschen“ überträgt ab dem Zeitpunkt Heimat-Anlage, Rolle, alle Zuständigkeiten, Mess-Selektionen, Freigaben und OTA-Zuordnung auf die Nachfolgerin. Eine Box = ein Netz: eine Quelle in einem anderen Netz braucht eine Box in diesem Netz."),
        ("AP-04 E11", "Ein Wechsel der zuständigen Box ist eine reine Zuständigkeitssache — Messstelle und Quellenbindung bleiben unberührt; ab dem Zeitpunkt nennt die Herkunft je Wert die neue Box."),
    ],
    "datenquelle": [
        ("AP-06 E1", "⚠ Die Datenquelle wird ein EIGENES Objekt (Kennzeichen DQ-x, Anlage, Protokoll, Adresse, Netzlage, Lesetakt, Verlauf); Komponenten verweisen additiv darauf. Der Bestand wird als Vorschlagsliste (Box + Protokoll + Adresse) gruppiert und vom Kunden bestätigt."),
        ("AP-06 E10", "Zwei Boxen dürfen dasselbe Gerät nur als gekennzeichnete Vergleichsquelle lesen, nach ausdrücklicher Bestätigung — und nie bei Protokollen oder Vorlagen, die nur einen Leser vertragen."),
        ("AP-06 E1/E2/E5/E12", "Identität, Zuständigkeitszeiträume (halboffen auf die Minute, nie überlappend, nie rückwirkend, beendet statt überschrieben), Doppel-Lesen, Fehlerklassen je Quelle und die Tabelle „Software-Stand → Fähigkeiten“ sind Vertrag: `docs/contracts/v2/data-source-assignment.md` mit `data-source-vectors.json` und `edge-capabilities.json` (AP-06 IP-1, Zwillinge `uems/DatenquelleRegeln` ⟷ `uemsDatenquelle.ts`)."),
        ("AP-04 E4 · AP-05 E5", "Wandlerfaktor und Einstellungen hängen an der QUELLE (Gerät bzw. Gerät + Kanal), zeitgültig als Fassung; die Messstelle bleibt hardwarefrei."),
    ],
    "geraet": [
        ("AP-05 E4", "Die Identität einer Energiekarte ist (Gerät, Steckplatz); eine Karten-Seriennummer ist optionaler Freitext, ein Steckplatzwechsel eine ausdrückliche Zuordnung."),
        ("AP-05 E6", "Kartenwechsel und Zählerrücksetzung sind Gerätegrenzen OHNE Gerätewechsel — ein Ereignis an der Komponente mit Zeitpunkt und optionalem Endstand."),
        ("AP-04 E10", "Ein Controller-Wechsel ist EIN Vorgang am Gerät: Karten gelten als übernommen, je Karte abwählbar; alle Komponenten wechseln auf das neue Gerät, alle Messstellen binden automatisch an die neuen Kanäle."),
    ],
    "komponente": [
        ("AP-07 E2", "⚠ Die Messreihe ist an der KOMPONENTE geschlüsselt (Mandant + Komponente + Messkanal) — das ERSETZT AP-00 §6.4 „die Reihe bleibt am Gerät geschlüsselt“. Gerät samt Einbau, lesende Box, Einstellungs-Fassung und Katalogstand reisen als Herkunft je WERT mit."),
        ("AP-07 E8", "Kein Unclaim, Box-Tausch oder Komponenten-Löschen vernichtet Messreihen oder Ereignisse: die Box wird „ausgebaut“, die Reihen bleiben mit ihrer Herkunft. Löschen ist nur der ausdrückliche Purge."),
    ],
    "messkanal": [
        ("AP-07 E1", "Die Strecke der Zusätzlichen Messwerte wird die EINE Messwert-Strecke, additiv erweitert um Komponente, Herkunft und Fassung; die Kern-Telemetrie bleibt der Betriebs-Pfad (Cockpit, Fahrplan, Regelung) und trägt keine Messstellen-Reihe."),
        ("AP-07 E6/E7", "Jeder Messkanal jeder Komponente bekommt Viertelstunden- und Tageswerte für zehn Jahre (Retention 3 653 Tage) — eine Regel, kein Sonderfall."),
        ("AP-07 E9", "Die Kadenz ist ein Feld der Quellenbindung, zeitgültig; sie reist als Soll zur Box und wird je Viertelstundenwert als „erwartet“ gespeichert. Eine Lücke beginnt ab 2 × Kadenz ohne guten Wert."),
        ("AP-07 E3/E13", "Derselbe Wert ist Reihe + Messzeit — die Sequenz ist nur noch Kennzeichen: dasselbe Paket zweimal ist EIN Wert, ein abweichender Wert zur selben Messzeit wird abgewiesen und als `duplicate_conflict` festgehalten, der erste bleibt. Eine Messzeit mehr als 5 Minuten in der Zukunft oder älter als 90 Tage wird abgewiesen; ein Uhrsprung wird gemeldet, der Wert bleibt. Die 15 Angaben je Wert und diese Ableitung stehen als Vertrag mit Vektoren in `docs/contracts/v2/messwert-herkunft.md` (AP-07 IP-1)."),
        ("AP-05 E9", "Standardsatz für eine Energiekarte: 13 Kanäle bei 60 s; die Wirkleistung gesamt bildet die Box als Summe, die Hauptzuleitung darf 10 s."),
    ],
    "messstelle": [
        ("AP-04 E1", "⚠ Eine Messstelle hat genau EINE Hauptgröße (identitätsstiftend, nie änderbar) und 0..n Nebengrößen desselben Messortes, jede mit eigener führender Quelle — das ERSETZT AP-00 §4.2 „Messstelle 1 : 1 Messgröße“ (AP-04 W1). Nebengrößen tragen nie Bilanz oder Bericht."),
        ("AP-04 E3", "Vergleichsquellen werden mit Zweck gekennzeichnet (Plausibilität · Ersatz bei Ausfall · Abrechnungszähler) und beide Werte nebeneinander gezeigt — ohne Bewertung, ohne Ersatz."),
        ("AP-04 E7", "Das Kennzeichen ist vierstellig fortlaufend („MS-0001“) je Kundenbereich, änderbar auf 2–16 Zeichen (Großbuchstaben, Ziffern, „-“, „.“, „/“); archivierte Kennzeichen bleiben belegt."),
        ("AP-04 E8", "Eine Messstelle OHNE Quelle ist erlaubt und eingerichtet (Kennzeichen + Name + Hauptgröße + Ort); ihre Beobachtung ist „keine Datenquelle“, und in Bilanz und Bericht steht sie als „ohne Werte“ — nie als 0."),
        ("AP-04 E12", "Die elektrische Stellung „Unterzähler von …“ bezieht sich auf die übergeordnete MESSSTELLE derselben Anlage (zeitgültig, Tag), nicht auf eine Komponente."),
        ("AP-04 E2", "Ein Quellenwechsel trägt einen Zeitpunkt auf die Minute (Zeitzone des Standorts, Vorgabe „jetzt“); Vergangenheit ist erlaubt und als „rückwirkend“ markiert, Zukunft heißt „angekündigt“. Lücke und Überlappung werden angezeigt, nie aufgefüllt."),
        ("AP-04 E6", "Bestandskomponenten werden als Vorschlagsliste je Standort übernommen („Alle übernehmen“ erst nach Sichtung); Bestandskunden ohne „Messen & Auswerten“ bekommen keine Messstellen."),
        ("AP-05 E3", "Bei einer Energiekarte ist der Zählerstand der Karte die Hauptgröße und die Wirkleistung eine Nebengröße; eine auf der Box integrierte Energie darf nur als gekennzeichnete Vergleichsgröße auftreten."),
        ("AP-04 IP-1", "Die Regeln der Messstelle sind ein Vertrag mit geteilten Vektoren: `docs/contracts/v2/messstelle.md` (Schema `messstelle.schema.json`, Vektoren `messstelle-vectors.json`). Ein Kennzeichen geht nie an eine ANDERE Messstelle — auch das frühere einer umbenannten bleibt belegt; „genau ein Hauptzähler je Anlage“ heißt: je Anlage und Richtung einer, alle am selben Zähler (MS-01 Bezug und MS-02 Abgabe an K-3); eine neue Quelle beendet die laufende genau zu ihrem Beginn, eine Lücke bleibt als Abschnitt ohne Quelle sichtbar; eine berechnete Messstelle braucht keinen Ort. Zwillinge: `services/api .../uems/MessstelleRegeln` und `frontend/portal/src/uemsMessstelle.ts` — noch ruft niemand an."),
    ],
    "messgroesse": [
        ("AP-04 E1", "Medium, Größe, Einheit, Richtung und Wertart sind Attribute der HAUPTGRÖSSE; jede Nebengröße trägt denselben Satz für sich."),
        ("AP-07 E12", "Die Wertart bestimmt die Cloud beim Schreiben aus Katalog bzw. Vorlage zur Messzeit und speichert sie je Rohwert und je Viertelstundenwert. Ein Punkt OHNE Wertart ist nicht an eine Messstelle bindbar."),
    ],
    "benutzer": [
        ("AP-03 E1", "Die Rollen sind entschieden: Kundenadministrator und Energiemanager (unternehmensweit) · Bearbeiter, Bedienberechtigt und Leser (je Standort) · Unterstützer (Installateur | VoltPilot, befristet)."),
        ("AP-03 E2/E4", "Benutzer, Rollen und Unterstützung sind allein Sache des Kundenadministrators. Bedienberechtigt umfasst den Betrieb IM RAHMEN (Betriebsmodell, Regeln, Steuerarten, Rangliste, Ladekarten); Freigeben, Grenze und Starten/Beenden bleiben beim Kundenadministrator."),
        ("AP-03 E6/E7/E8/E9", "Eine Unterstützung hat ein Pflicht-Enddatum (Vorgabe 30 Tage, höchstens 12 Monate). Der Installateur hat ein Partner-Konto ohne Heimat-Kundenbereich. VoltPilot kommt nur mit Gewährung hinein — plus 24-h-Notfall-Zugriff mit Pflicht-Grund, Banner, E-Mail und Protokoll. Der Umfang je Gewährung: Ansehen · Einrichten · Einrichten und Bedienen."),
        ("AP-03 E11/E12", "Die Wahrheit über Rechte ist eine Zuweisungstabelle im API (Benutzer × Rolle × Standort × Gültigkeit, unter RLS) plus `/me`; Keycloak bleibt Identität. Jeder heutige Kundenbenutzer wird Kundenadministrator."),
        ("AP-03 W3/E13", "Die Realm-Rolle `site-admin` wird abgeschafft: OCPP-Stufen hängen künftig an der Zuweisung; bestehende Träger werden Kundenadministrator."),
        ("AP-03 IP-1", "Die Rechte-Matrix ist Daten: 48 Kundenaktionen × 7 Rollen mit stabiler Kennung je Zeile (`docs/contracts/v2/rechte-matrix.json`, die Tabelle `rechte-matrix.md` wird daraus erzeugt), dazu als Nachträge die Rechte-Abschnitte der später konzipierten Pakete AP-04, AP-06 und AP-07 (Zeilen mit `nachtrag`, z. B. `datenquelle.zustaendigkeit`). Ob ein Benutzer eine Aktion an einem Standort darf, welche Standorte er sieht, die Teilansicht, die OCPP-Stufe aus der Zuweisung, Unterstützung und Entzug sind Vertrag: `docs/contracts/v2/rechte-vectors.json` (Zwillinge `uems/RechteAbleitung` ⟷ `rechte.ts`) — erst der Geltungsbereich (404), dann die Aktion (403 mit der nötigen Rolle)."),
    ],
    "zuordnung": [
        ("AP-02 E9", "Die zeitliche Auflösung einer Gültigkeit ist der TAG: „gültig ab“ wirkt 00:00 Uhr in der Zeitzone des Standorts. Ausnahme: die Quellenbindung einer Messstelle trägt einen Zeitpunkt auf die Minute (AP-04 E2)."),
        ("AP-02 E2", "Rückwirkende Verschiebungen und Zuordnungen sind erlaubt — aber immer sichtbar: Kennzeichen „rückwirkend“, Folgen-Karte, Revision in AP-12."),
        ("AP-02 IP-1", "Die Mechanik der Gültigkeit ist ein Vertrag mit geteilten Vektoren: `docs/contracts/v2/ortsbaum-vectors.json` (Schema `ortsbaum.schema.json`). „gültig bis“ ist der LETZTE gültige Tag — ein Wechsel ab 01.03.2027 beendet das Alte am 28.02.2027; rückwirkend ist ein Eintrag, dessen „gültig ab“ vor dem Eintragstag am Standort liegt; der Standort einer Messstelle ist die Wurzel ihres Ortes an diesem Tag. Zwillinge: `services/api .../uems/OrtsbaumAbleitung` und `frontend/portal/src/uemsOrtsbaum.ts` — noch ruft niemand an."),
        ("AP-07 E4", "Der Writer prüft je Wert die lesende Box gegen die zeitgültige Zuständigkeit der Datenquelle ZUR MESSZEIT: zuständig → führend, bestätigte Vergleichsquelle → `vergleich`, sonst → gespeichert als `spiegel`, nie in Rollups."),
    ],
    "zustaende": [
        ("AP-01 E8", "Die drei Wörter des Plans werden auf dieses Vokabular abgebildet: sichtbar = kein Objekt (Angebot auf der Karte), begonnen = Entwurf (bei „Steuern“ auch eingerichtet, noch nicht gestartet), aktiv = aktiv."),
        ("AP-01 E7/E8", "„angehalten“ heißt bei einer Anlage: Ruhe OHNE Enddatum; alles bleibt gespeichert, nur Fahrplan, Regeln und Steuerarten wirken nicht."),
        ("AP-01 E9", "Beim Fortsetzen läuft die Prüfliste erneut, dann zeigt eine Folgen-Karte, was passiert — und dann genügt ein Klick."),
        ("AP-01 E6 = C/W7", "Der Funktions-Zustand gilt je STANDORT und ist der HÖCHSTE Zustand seiner Teilnahmen (Rang: kein Objekt < archiviert < Entwurf < eingerichtet < angehalten < aktiv — angehalten, solange keine Anlage aktiv teilnimmt). Je Anlage entscheidet vor dem Start und beim Fortsetzen DIESELBE Prüfliste (Box, Freigabe, Verbindungstest, Grenze, Hauptzähler, Betriebsweise), und „Entwurf“ nennt, was fehlt. Die Ableitung ist Vertrag: `docs/contracts/v2/funktion-zustand-vectors.json` (AP-01 IP-1, Zwillinge `uems/FunktionZustandAbleitung` ⟷ `uemsFunktion.ts`)."),
        ("AP-07 E9", "„liefert Daten“ ist geschärft: letzter guter Wert jünger als 3 × Kadenz nach Eingangszeit, mindestens 5 Minuten und höchstens 1 Tag; eine Lücke der Reihe beginnt schon ab 2 × Kadenz. Die Kadenz ist ein zeitgültiges Feld der Quellenbindung, kein fester 5-Minuten-Deckel."),
        ("AP-04 E8", "Eine Messstelle ohne Quelle hat die Beobachtung „keine Datenquelle“ — sie ist eingerichtet und aktiv, zeigt aber nie eine 0."),
        ("AP-07 E11", "Ereignisse (Lücke, Nachlieferung, Gerätegrenze, Zeitfehler, Konflikt) reisen über einen additiven Vertrag `…/v2/events` in eine Ereignis-Tabelle je Mandant, append-only und NIE gelöscht — sie sind der Beweis hinter jeder Zustandsaussage. Das geschlossene Vokabular (23 Arten mit Urheber, Bezug, Zeitregel und Kundensatz; ein offenes Ereignis wird fortgeschrieben, nie geändert), der Umschlag Box → Cloud (2.1) und das Redpanda-Ereignis `events.raw` stehen als Vertrag mit Vektoren in `docs/contracts/v2/events-vocabulary.md` (AP-07 IP-3)."),
    ],
    "betriebsmodell": [
        ("AP-01 E11", "„Marktoptimierung“ bleibt das Kundenwort und eine Option der Radiogruppe Betriebsmodell — nicht „Arbitrage“."),
        ("AP-03 E15", "Wird ein Bedienrecht entzogen, bleiben gesetzte Handeingriffe bis zum Ablauf oder bis ein Berechtigter sie beendet; die Zone „Jetzt“ nennt Urheber und „Bedienrecht beendet am …“."),
    ],
}

# ---------------------------------------------------------------------------------------------
# ENTSCHEIDUNGSLOG DER NACHBARPAKETE — nur die Entscheide, die einen AP-00-Begriff berühren.
# Vollständige Logs: `data/vp-uems-ap0*/report.md`, jeweils Anhang A.
# ---------------------------------------------------------------------------------------------
ENTSCHEIDUNGSLOG_NACHBARN = [
    ('10.09.2026', 'AP-01 E6', 'Option C — beide Funktionen gelten je Standort; die Anlage nimmt einzeln teil (W7: Freigabe, Grenze, Betriebsweise, Ruhe und Start bleiben je Anlage)'),
    ('10.09.2026', 'AP-01 E7/E8', 'Option A — Ruhe-Eintrag ohne Enddatum; alles bleibt gespeichert, nur Fahrplan/Regeln/Steuerarten wirken nicht'),
    ('10.09.2026', 'AP-01 Geld-Regel', 'Captain-Vorgabe — eine reine Messanlage zeigt auf keiner Ebene Geld'),
    ('10.09.2026', 'AP-02 E1/E12', 'Option A — Archivieren ist der Normalweg; Löschen nur ohne jede Historie; Archivieren nur ohne aktive Messstellen und Anlagen'),
    ('10.09.2026', 'AP-02 E9', 'Option A — „gültig ab“ ist ein Tag, wirksam 00:00 Uhr in der Zeitzone des Standorts'),
    ('10.09.2026', 'AP-03 E1', 'Option A — fünf Kundenrollen + Unterstützer: Kundenadministrator · Energiemanager · Bearbeiter · Bedienberechtigt · Leser · Unterstützer'),
    ('10.09.2026', 'AP-04 E1', 'Option A — eine Hauptgröße + 0..n Nebengrößen (ERSETZT AP-00 „Messstelle 1 : 1 Messgröße“, AP-04 W1)'),
    ('10.09.2026', 'AP-04 E12', 'Option A — „Unterzähler von …“ bezieht sich auf die übergeordnete Messstelle derselben Anlage'),
    ('10.09.2026', 'AP-05 E3/E4', 'Option A — Kartenzählerstand ist die Hauptgröße, Wirkleistung Nebengröße; Einstellungen an der Quelle, Kartenidentität = (Gerät, Steckplatz)'),
    ('10.09.2026', 'AP-06 E1/E2/E3', 'Option A — Datenquelle als eigenes Objekt; Zuständigkeit je Datenquelle; „führende Box“ je Anlage als gespeicherter Fakt'),
    ('10.09.2026', 'AP-07 E2', 'Option A — Reihe = Komponente + Messkanal; Gerät, Box und Fassung als Herkunft je Wert (ERSETZT AP-00 §6.4, AP-07 W1)'),
    ('10.09.2026', 'AP-07 E11', 'Option A — Ereignis-Vertrag `…/v2/events` + Ereignis-Tabelle je Mandant, append-only, nie gelöscht'),
]
