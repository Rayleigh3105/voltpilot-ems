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
     "heute": "Tabelle `site` (MIG/V1__core_schema.sql:45-52: name, bidding_zone) plus 17 Zusatzspalten — u. a. `plant_kind` (MIG/V20260706010000__site_plant_kind.sql:17), `tarif_art`/`tarif_param_ct_kwh` (MIG/V20260708010000__site_tarif_model.sql:41-44), `max_feed_in_kw` (MIG/V20260716000000__site_max_feed_in_kw.sql:21), `component_authority` box|portal (MIG/V20260817000000__component_authority_and_definitions.sql:42-43), `profil` privat|gewerbe (MIG/V20260838000000__site_profil.sql:45) — und 19 Migrationen mit 24 Verweisen `REFERENCES site(id)` (device, asset, measurement_point, site_profile_state, site_charging_config …). Portal: `#/anlage/{siteId}/…` (PORTAL/nav.ts:504, :612-641), fünf Bereiche Cockpit · Fahrplan · Verlauf · Steuerung · Anlage (PORTAL/ebenenNav.ts:16-17, :245). Topic `ems/{tenant}/{site}/{device}/…` (docs/architecture.md:90-94).",
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
     "heute": "Kein Objekt. Transport-Wahrheit je Komponente in `measurement_point.communication/family/connection_json` (MIG/V20260709000000__measurement_point.sql:38-43), historisiert in `component_definition.connection_json` (MIG/V20260817000000__component_authority_and_definitions.sql:82-93); „Sein Leseplan reist im Flow“ (docs/agents/edge/ein-selbstbau-geraet-darf-den-registry-p.md:18-20); Lesetypen `vp.modbus.read`, `vp.mqtt.read`, `vp.http.read` sind Flow-Knoten (services/api/src/main/resources/flowcatalog/catalog.json:769,904,1046). Ist-Rückmeldung je Quelle `device_source_status.health` ok|stale|never (MIG/V20260721000000__device_source_status.sql:24-41). Zuständige Box = `measurement_point.device_id` bzw. `entity_registry_state.device_id` je Anlage (MIG/V20260709000000:48; MIG/V20260719030000__entity_sync_state.sql:24-27). Im Portal ist „Datenquelle“ heute nur die MaStR-Herkunft (PORTAL/components/MastrDrawer.tsx:276).",
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
     "lang": "Prozesse bilden die zweite Sicht auf dieselben Messstellen. Ein Prozess kann Messstellen in mehreren Gebäuden, Anlagen und Standorten haben. Prozesse dürfen einen übergeordneten Prozess haben (Prozessbaum, eine Ebene). Sie sind der Anker für „wesentliche Energieeinsätze“ (AP-16) und Prozesskennzahlen (AP-11) — über den Energieeinsatz (AP-16 E1 = A: genau ein Prozess × ein Träger, mit Verantwortlichem, Einflussgrößen, Messbedarf und Einstufungs-Fassungen; der Prozess selbst bleibt unverändert).",
     "beispiel": "P-1 Spritzguss läuft in Halle 1 (MS-06, AN-1) und Halle 2 (MS-11, AN-2); P-2 Montage in Halle 2 und Werk Lindach; P-3 Druckluft ist Querschnitt (70 % Spritzguss, 30 % Montage — über die Kostenstellen-Verteilung, AP-16 W2: die Zuordnung Messstelle → Prozess bleibt ohne Anteil, die Bewertung zählt MS-07 einmal in P-3).",
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
# NACHTRAEGE spaeterer Pakete (Schluessel `nachtrag`): AP-00 hat 23 Begriffe festgelegt; ein
# spaeteres Paket darf einen FEHLENDEN Begriff ergaenzen, nie einen bestehenden umschreiben.
# Dasselbe Muster wie die `nachtrag`-Zeilen der Rechte-Matrix (`rechte-matrix.json`).
# ---------------------------------------------------------------------------------------------
GLOSSAR += [
    {"id": "ablesung", "sicht": "erf", "begriff": "Ablesung", "nachtrag": "AP-09 §6.2 (W7)",
     "kurz": "Ein von Hand erfasster Zählerstand zu einem Zeitpunkt — der Messwert einer Messstelle, die keine Datenquelle hat.",
     "lang": "Eine Ablesung ist ein STAND, keine Menge: sie sagt, was der Zähler zu dieser Minute anzeigte. Sie trägt ihren Zeitpunkt auf die Minute mit Zone, ihren Urheber und ihre Fassung. Zwei Ablesungen derselben Reihe schließen einen Ablesezeitraum — erst daraus entsteht eine Menge. Dieselbe Ablesung noch einmal ist eine Wiederholung; derselbe Zeitpunkt mit einem anderen Stand ist ein Konflikt und braucht eine Berichtigung, nie ein stilles Überschreiben.",
     "beispiel": "MS-21 Gas Heizung Verwaltung: 48 211 m³ am 01.10.2026 07:15 und 49 451 m³ am 02.11.2026 07:40, abgelesen von Jonas Wendlinger.",
     "heute": "Heute nicht vorhanden (`grep -rni 'ablesung|meter_reading' MIG` → 0). Die Regeln stehen als Vertrag in `docs/contracts/v2/bezugsdaten.md` (AP-09 IP-1); der Speicherweg kommt mit AP-09 IP-8.",
     "abgrenzung": "Nicht der Messwert einer Datenquelle (der kommt von einer VoltPilot-Box), nicht die Menge (die entsteht erst aus zwei Ablesungen)."},
    {"id": "ablesezeitraum", "sicht": "erf", "begriff": "Ablesezeitraum", "nachtrag": "AP-09 §6.2 (W7)",
     "kurz": "Die Strecke zwischen zwei Ablesungen derselben Reihe — der Zeitraum, für den ihre Differenz gilt.",
     "lang": "Der Ablesezeitraum ist die einzige Periode, für die eine abgelesene Menge gilt. Er wird NIE auf Tage oder Viertelstunden verteilt: ein Tag darin hat „keine Werte“, nicht 0. Berührt er zwei Kalendermonate, trägt die schließende Ablesung ein Kennzeichen „gilt für <Monat>“ — vorbelegt ist der Monat mit dem größten zeitlichen Anteil, änderbar durch den Kunden. Ab drei berührten Monaten gibt es keine Vorbelegung.",
     "beispiel": "01.10.2026 07:15 bis 02.11.2026 07:40 = 32 Tage 1 h 25 min, 1 240 m³; Anteil Oktober 95,9 % → „gilt für Oktober 2026“.",
     "heute": "Heute nicht vorhanden. Die Zuordnungsregel steht als Vektor in `docs/contracts/v2/bezugsdaten-vectors.json` (Fall B8).",
     "abgrenzung": "Nicht die Periode einer Bezugsgröße (die ist ein Kalendertag, eine Woche, ein Monat oder ein Jahr), nicht das Zeitraster einer Verdichtung."},
    {"id": "fassung", "sicht": "erf", "begriff": "Fassung", "nachtrag": "AP-09 §6.2 (W7)",
     "kurz": "Ein Stand eines erfassten Werts mit Urheber, Zeitpunkt und Begründung — jede Änderung ist eine neue Fassung, keine überschreibt eine alte.",
     "lang": "Ein gespeicherter Wert wird nie geändert und nie gelöscht. Der Erstwert ist Fassung 1 und braucht keine Begründung; jede Änderung ist eine Berichtigung = Fassung n + 1 mit Begründung, und Fassung n bleibt lesbar. Hat das Unternehmen das Vier-Augen-Prinzip eingeschaltet, ist die neue Fassung ein Vorschlag, bis eine ZWEITE Person freigibt — der Urheber kann sich nie selbst freigeben. Eine Rücknahme ist ebenfalls nur die nächste Fassung: ohne Betrag, wenn sie einen Erstwert trifft, und mit dem Betrag der Vorfassung, wenn sie eine Berichtigung trifft.",
     "beispiel": "BZ-2 Gutteile Montage, Oktober 2026: Fassung 1 = 4 820 Stück (Tippfehler), Fassung 2 = 48 200 Stück mit der Begründung „Tippfehler — eine Null fehlte“.",
     "heute": "Das Muster gibt es schon bei den zeitgültigen Einstellungen je Quelle (Tabelle `quelle_einstellung`, AP-04); für erfasste WERTE ist es neu. Die Regeln stehen in `docs/contracts/v2/bezugsdaten.md` (AP-09 IP-1).",
     "abgrenzung": "Nicht die Version einer Kennzahl (AP-11 bildet sie neu, wenn eine Fassung sich ändert), nicht die Zeitgültigkeit eines Stammdatums: „gültig ab“ sagt, WANN ein Wert gilt — die Fassung sagt, WER ihn wann erfasst hat."},
    {"id": "herkunft", "sicht": "erf", "begriff": "Herkunft", "nachtrag": "AP-09 §6.2 (W7)",
     "kurz": "Woher ein Wert kommt: eingegeben, importiert, aus einem Messkanal abgeleitet oder aus einem Stammdatum gelesen — je Wert, nicht je Tabelle.",
     "lang": "Jeder Wert nennt seine Art, seinen Urheber, seinen Erfassungszeitpunkt, seine Fassung und seinen Status. Ein importierter Wert nennt zusätzlich Datei, Zeile und den gelieferten Text samt Einheit; ein abgeleiteter nennt Komponente, Messkanal und die Regel. Die Herkunft reist unverändert in Kennzahlen und Berichte — eine Zahl ohne Herkunft ist im Unternehmens-Energiemanagement keine Zahl.",
     "beispiel": "BZ-1 Produktionsmenge Spritzguss, Oktober 2026 = 312 400 kg · Import I-2026-0001, Zeile 2 · Ines Kaltenbach, 03.11.2026 09:12.",
     "heute": "Für Messwerte entschieden und als Vertrag gebaut (`docs/contracts/v2/messwert-herkunft.md`, AP-07 IP-1). Für Bezugsdaten gilt ein EIGENER Vertrag (`docs/contracts/v2/bezugsdaten.md`, AP-09 E3) — der Messwert-Vertrag wird dafür nicht erweitert.",
     "abgrenzung": "Nicht das Änderungsprotokoll (das sagt, was jemand an einem OBJEKT geändert hat), nicht die Datenquelle (die ist der technische Weg einer VoltPilot-Box)."},
    {"id": "import", "sicht": "erf", "begriff": "Import", "nachtrag": "AP-09 §6.2 (W7)",
     "kurz": "Ein bestätigter Vorgang, der aus einer hochgeladenen Datei Werte macht — in vier Schritten: Datei, Zuordnung, Vorschau, Übernahme.",
     "lang": "Die Vorschau schreibt nichts: sie sagt je Zeile ihr Urteil und ihre Befunde und je Datei die Zähler, und sie darf beliebig oft laufen. Erst die Übernahme schreibt, in einem Stück; bricht sie ab, ist nichts geschrieben. Dieselbe Datei ein zweites Mal verdoppelt keine Menge. Ein Import kann zurückgenommen werden — dann bekommt jeder Wert, den er geschrieben hat, eine Folge-Fassung; gelöscht wird nichts.",
     "beispiel": "I-2026-0001 übernimmt eine Zeile (BZ-1 Oktober 2026 = 312 400 kg); I-2026-0002 ist dieselbe Datei und schreibt 0 Änderungen.",
     "heute": "Heute nicht vorhanden. Die Urteile je Zeile, die Zähler je Datei und die Rücknahme stehen als Vektoren in `docs/contracts/v2/bezugsdaten-vectors.json` (AP-09 IP-1); der Weg selbst kommt mit AP-09 IP-11 … IP-13.",
     "abgrenzung": "Nicht die Datenannahme (die nimmt Messwerte einer VoltPilot-Box entgegen), nicht die Bestandsübernahme (die legt Objekte an, keine Werte)."},
    {"id": "zuordnungsvorlage", "sicht": "erf", "begriff": "Zuordnungs-Vorlage", "nachtrag": "AP-09 §6.2 (W7)",
     "kurz": "Die gespeicherte Deutung einer Datei-Art: welche Spalte was bedeutet, in welchem Zahlen- und Datumsformat, und welcher Text auf welche Bezugsgröße zeigt.",
     "lang": "Eine Vorlage gehört dem Kundenbereich, nicht einem Benutzer: jeder, der importieren darf, sieht und nutzt sie. Sie hält Trennzeichen, Kodierung, Zahlen- und Datumsformat, die Perioden-Deutung, die Zeitzone, die Einheiten-Synonyme und die Tabelle „Spaltenwert → Bezugsgröße“. Sie wird versioniert: eine Änderung ist eine neue Fassung, und ein früherer Import nennt weiter die Fassung, mit der er gelesen wurde.",
     "beispiel": "„ERP-Export Spritzguss“: Spalte 1 Periode (Monat, JJJJ-MM), Spalte 2 Bezug („Spritzguss gesamt“ → BZ-1), Spalte 3 Wert (Dezimalkomma, Tausenderpunkt), Spalte 4 Einheit.",
     "heute": "Heute nicht vorhanden. Das Muster gibt es schon bei den Geräte-Vorlagen der Komponenten (Tabelle `component_template`, Einheitsmodell Stufe 0a).",
     "abgrenzung": "Nicht die Geräte-Vorlage (die beschreibt ein Gerät und seine Register), nicht der Bericht (der beschreibt eine Ausgabe)."},
    {"id": "befund", "sicht": "erf", "begriff": "Befund", "nachtrag": "AP-09 §6.2 (W7)",
     "kurz": "Ein benannter Grund, warum eine Zeile nicht übernommen wird — oder ein Hinweis, der sie begleitet.",
     "lang": "Befunde sind ein geschlossenes Vokabular mit einem Kundensatz je Eintrag. Drei von ihnen sind Hinweise und verhindern nichts (die Datei ist bekannt, die Einheit wurde umgerechnet, der Wert ist auffällig); alle anderen halten die Zeile oder die Datei an. Ein Befund wird GENANNT, nicht aufgelöst: eine unbekannte Einheit wird nie geraten, ein mehrdeutiger Zeitpunkt nie gewählt, ein Zeitraum nie geteilt.",
     "beispiel": "„Unbekannte Einheit »lbs« — erlaubt sind kg, t.“ · „25.10.2026 02:30 gibt es an diesem Tag zweimal (Zeitumstellung). Geben Sie die Zone an.“",
     "heute": "Das Muster gibt es schon bei den Ablehnungsgründen der Schreibwege (`MessstelleAbgelehnt`, `DatenquelleAbgelehnt`); das Vokabular der Bezugsdaten steht in `docs/contracts/v2/bezugsdaten.schema.json`.",
     "abgrenzung": "Nicht das Ereignis (das beschreibt, was an einer Messreihe geschehen ist), nicht die Fehlermeldung einer Route (die sagt, warum eine ANFRAGE abgelehnt wurde)."},
    {"id": "energiebilanz", "sicht": "el", "begriff": "Energiebilanz", "nachtrag": "AP-10 §4.1 (E9)",
     "kurz": "Was in ein elektrisches System hineinfließt, was es verlässt und was an Unterzählern gemessen ist — für einen Zeitraum.",
     "lang": "Die Bilanzgrenze ist die Anlage, nie ein Gebäude und nie ein Standort: nur hinter einem Netzanschluss hängt alles elektrisch zusammen. Zufluss ist, was hereinkommt (Netzbezug, Erzeugung, Speicher-Entladen); Abfluss ist, was das System verlässt, ohne verbraucht zu werden (Netzabgabe, Speicher-Laden); zugeordnet ist, was an Unterzählern gemessen wurde. Was eine Messstelle in der Bilanz tut, wird aus ihrer STELLUNG abgeleitet und nie gewählt. Standort und Unternehmen summieren ihre Systeme mit „x von y“ und haben keinen eigenen Rest.",
     "beispiel": "Werk Lindach am 18.10.2026: Hauptzähler 100 kWh, Unterzähler 60 und 30 kWh — Gesamtverbrauch 100 kWh, zugeordnet 90 kWh.",
     "heute": "Heute nicht vorhanden. Die Regeln stehen als Vertrag in `docs/contracts/v2/bilanz.md` samt Vektoren (`bilanz-vectors.json`, AP-10 IP-1); Lesemodell und Fläche kommen mit AP-10 IP-9/IP-14.",
     "abgrenzung": "Nicht die Erlösbilanz (die rechnet Geld, nicht Energie), nicht der Fahrplan (der plant, statt zu bilanzieren), nicht die Verdichtung (die bildet Mengen, nicht Rollen)."},
    {"id": "bilanzdifferenz", "sicht": "el", "begriff": "Bilanzdifferenz", "nachtrag": "AP-10 §4.3 (E1, E3)",
     "kurz": "Zufluss minus Abfluss minus zugeordnet — der Teil des Verbrauchs, der keiner Messstelle zugeordnet ist.",
     "lang": "Die Bilanzdifferenz ist eine DIFFERENZ und sonst nichts. Sie heißt dem Kunden gegenüber „nicht zugeordnet“ und wird nie einem Gerät, einem Gebäude, einem Prozess oder einer Ursache zugeschrieben — kein Verlust, kein Schwund. Ihre Richtung ist fest Wirkenergie · Bezug: 100 minus 60 minus 30 ergibt 10 kWh Bezug, nicht „richtungslos“. Sie darf negativ sein; dann heißt der Satz „Messwerte passen nicht zusammen (−x kWh)“, und es wird nichts geklemmt und nichts gedeutet. Fehlt EIN Eingang, gibt es keine Differenz („keine Werte“) — eine verkleinerte Differenz wäre zu hoch.",
     "beispiel": "Werk Lindach am 18.10.2026: 100 − 60 − 30 = 10 kWh sind keiner Messstelle zugeordnet.",
     "heute": "Heute nicht vorhanden; die Box rechnet mit `house = pv + grid − battery` ein namenloses Äquivalent ohne Unterzähler. Der benannte Fall steht in `docs/contracts/v2/bilanz-vectors.json` (F1–F7).",
     "abgrenzung": "Nicht ein Messfehler (den behauptet niemand), nicht der Hausverbrauch des Cockpits (der ist die Box-Rechnung ohne Unterzähler), nicht ein Ersatzwert."},
    {"id": "verteilung", "sicht": "org", "begriff": "Feste Verteilung", "nachtrag": "AP-10 §4.6 (E11, E12)",
     "kurz": "Eine zeitgültige Beziehung Messstelle → Kostenstelle mit Anteil; alle Zeilen eines Tages ergeben genau 100 %.",
     "lang": "Eine Verteilung teilt MENGEN, nie Stammdaten, und sie wirkt je Tag auf die Tagesmenge — kein Stichtag, kein Mittel, keine Interpolation. Sie wird als Satz geschrieben (alle Ziele eines Tages in einer Anfrage), sonst wären die 100 % nicht prüfbar. Ohne Zeile an einem Tag ist die Messstelle „nicht verteilt“; das ist ein Zustand, kein Fehler. Sie endet mit ihrem Ziel und wandert nie still auf einen Nachfolger. Es gibt keine dynamischen Schlüssel: kein Anteil aus Messwerten, Flächen, Stückzahlen oder Betriebsstunden.",
     "beispiel": "Druckluft MS-07 im Oktober 2026: 70 % an 4100 Spritzguss (11 130 kWh), 30 % an 4200 Montage (4 770 kWh).",
     "heute": "Heute nicht vorhanden (`kostenstellen_anteile` steht bisher nur im Referenzunternehmen). Die Regeln stehen als Vertrag in `docs/contracts/v2/verteilung.md` samt Vektoren; Tabelle und Dialog kommen mit AP-10 IP-8/IP-15.",
     "abgrenzung": "Nicht die Prozess-Zuordnung (die hat keinen Anteil), nicht die Formel einer berechneten Messstelle (die summiert, statt zu teilen), nicht eine Umlage nach Schlüssel."},
    {"id": "berechnete_messstelle", "sicht": "zustand", "begriff": "Berechnete Messstelle", "nachtrag": "AP-10 §4.1 (E1, E5)",
     "kurz": "Eine Messstelle, deren Wert aus anderen Werten entsteht — mit genau einem Formel-Typ und einer tagesgenau gültigen Fassung.",
     "lang": "Drei Typen: die gewichtete Summe (Terme mit Vorzeichen und Faktor), der Rest (die Bilanzdifferenz eines Hauptzählers, je Tag aus der Stellung abgeleitet) und der Saldo (Bezug minus Abgabe derselben Grenze). Der Typ entscheidet die Richtung des Ergebnisses; sie wird nie aus Vorzeichen abgeleitet. Ein berechneter Wert trägt dieselben vier Angaben wie ein gemessener — Zustand, Abdeckung, Kennzeichen, Version — und zusätzlich seine Herkunft mit jedem Eingang. Die Formel ist zeitgültig in Tagesfassungen; Fassung n + 1 beendet Fassung n am Vortag, nichts wird überschrieben.",
     "beispiel": "MS-19 „Netzbezug gesamt Unternehmen“ = MS-01 + MS-10 + MS-16 = 174 400 kWh im Oktober 2026 (3 von 3 Systemen).",
     "heute": "Gebaut ist die gewichtete Summe (`messstelle_formel_term`, `docs/contracts/v2/messstelle-formel.md`). Die Typen `rest` und `saldo` und die Fassungen stehen als Vertrag in `bilanz.md` und in `messstelle-formel.md` §0/§6; den Code ziehen AP-10 IP-3/IP-4 nach.",
     "abgrenzung": "Nicht die Kennzahl (die teilt durch eine Bezugsgröße, AP-11), nicht der Messkanal (der wird gelesen, nicht gerechnet), nicht der Ersatzwert (der steht für einen fehlenden Messwert)."},
    {"id": "kennzahl", "sicht": "org", "begriff": "Kennzahl", "nachtrag": "AP-11 §4.1 (E1, E2, E5)",
     "kurz": "Ein eigenes Objekt, das Mengen teilt: Menge je Bezugsgröße, Teil am Ganzen oder Summe durch Summe über Kennzahlen — mit Zustand, Richtung, Fassung und Version.",
     "lang": "Eine Kennzahl hat ein Kennzeichen (KZ-0001), genau einen Geltungsbereich, einen Verantwortlichen und einen Zweck. Ihre Berechnung lebt in tagesgültigen Fassungen, ihr Wert je Periode in Versionen. Sie summiert nie selbst (Summen sind Gesamtwerte) und mittelt nie Quotienten: eine Unternehmenszahl aus Gebäuden ist Summe durch Summe. Eine Zahl gibt es nur mit Menge UND Bezugsgröße und einer Bezugsgröße ungleich 0; ist ein Eingang unvollständig, steht die Richtung dabei (mindestens, höchstens).",
     "beispiel": "KZ-0001 Halle 2 im Oktober 2026: 6 100 kWh ÷ 41 000 Stück = 0,15 kWh je Stück; KZ-0003 Unternehmen: (6 100 + 3 600) ÷ (41 000 + 7 200) = 0,20 kWh je Stück.",
     "heute": "Gebaut mit AP-11 IP-1 bis IP-16 (Stand 23.09.2026, Nachtrag AP-17 W9). Vertrag `docs/contracts/v2/kennzahl.md` samt Vektoren (`kennzahl-vectors.json` K1–K23, Zwillinge `uems/KennzahlRegeln` ⟷ `uemsKennzahl.ts`); Tabellen `kennzahl`, `kennzahl_fassung` (Berechnung als tagesgültige Fassungen), `kennzahl_eingang` und `kennzahl_wert` (Werte als Versionen, nur anhängend) (MIG/V20260915003000__uems_kennzahl.sql:190, :307, :409, :478); Routen `/api/v1/kennzahlen` für Anlegen, Fassungen, Vorschau, Werte und Versionen (services/api/src/main/java/com/voltpilot/api/web/KennzahlController.java:57); Rechenlauf `uems/KennzahlLauf` im Stundentakt und Kaskade `uems/KennzahlKaskade` hinter `voltpilot.uems.kennzahlen.enabled`; Portal „Unternehmen › Kennzahlen“ (PORTAL/nav.ts:251) und am Standort. Einstieg: `docs/agents/root/uems-kennzahlen-abschluss.md`. Der Aggregat-Schritt der Eigenen Auswertung ist nicht dieses Objekt (AP-11 W7).",
     "abgrenzung": "Nicht die Messstelle (die misst oder summiert, sie teilt nicht), nicht der Gesamtwert (eine berechnete Messstelle), nicht die Bezugsgröße (der Nenner), nicht ein Mittelwert."},
    {"id": "kennzahlvorlage", "sicht": "org", "begriff": "Kennzahlvorlage", "nachtrag": "AP-11 §4.12 (E9)",
     "kurz": "Ein Katalog-Eintrag, der das Anlegen einer Kennzahl vorbelegt: Rechenform, Name, Zweck und die Erwartung an Menge und Bezugsgröße.",
     "lang": "Eine Vorlage ist nie selbst eine Kennzahl und hat keine Fassungen. Aus ihr entsteht eine Kennzahl mit neuem Kennzeichen und Fassung 1; Eingänge und Geltungsbereich werden immer neu gebunden. Wer eine bestehende Kennzahl kopiert, übernimmt Form, Name und Zweck ebenso — und bindet ebenso neu.",
     "beispiel": "Aus „Stromeinsatz je Stück — {Geltungsbereich}“ legt Peter Hollerbach KZ-0002 für die Montagehalle Lindach an.",
     "heute": "Gebaut mit AP-11 IP-10 (Stand 23.09.2026, Nachtrag AP-17 W9/W11): zehn VoltPilot-Vorlagen in `services/api/src/main/resources/kennzahlen/kennzahl-vorlagen.json` (byte-gleiche Kopie PORTAL/kennzahlen/kennzahl-vorlagen.json), Form `docs/contracts/v2/kennzahl-vorlagen.schema.json`, Route `GET /api/v1/kennzahl-vorlagen` (services/api/src/main/java/com/voltpilot/api/web/KennzahlVorlagenController.java:20); die acht aus AP-11 §4.12 und seit AP-17 W11 „Stromeinsatz je Gradtag“ und „Stromeinsatz je Betriebsstunde aus Leistung“. Die Regel für Vorlage und Kopie steht in `docs/contracts/v2/kennzahl-vectors.json` (K20).",
     "abgrenzung": "Nicht die Zuordnungs-Vorlage eines Imports (die deutet eine Datei), nicht eine Kundenvorlage mit eigenen Fassungen (E9, nicht gewählt)."},
    {"id": "bericht", "sicht": "org", "begriff": "Bericht", "nachtrag": "AP-12 §4.1 (E1, E8, E9)",
     "kurz": "Ein eigenes Objekt aus Berichtsvorlage, Geltung (Standort oder Unternehmen) und Zeitraum (Monat oder Jahr) — mit genau einem Entwurf und null bis n freigegebenen Berichtsständen.",
     "lang": "Ein Bericht zitiert nur die Welt der Messstellen: Messstellen, Kostenstellen-Energie, Bezugsgrößen und Kennzahlen, jede Zahl mit Zustand, Version und Herkunft. Sein Entwurf bildet sich neu, wenn sich eine Quelle ändert; ein Berichtsstand bleibt, wie er freigegeben wurde. Je Vorlage, Geltung und Zeitraum gibt es genau einen Bericht.",
     "beispiel": "BR-2026-0001, Monatsbericht Werk Ahrenberg Oktober 2026: Berichtsstand Nr. 1 am 10.11.2026, Nr. 2 (Revision) am 16.11.2026.",
     "heute": "Gebaut mit AP-12 IP-1 ff. (Stand 24.09.2026, Nachtrag AP-18 W13). Vertrag `docs/contracts/v2/bericht.md` samt Vektoren (`bericht-vectors.json`, Zwillinge `uems/BerichtRegeln` ⟷ `uemsBericht.ts`); Tabellen `bericht` und `bericht_entwurf` (MIG/V20260915050000__uems_bericht.sql:162, :223); Routen `/api/v1/berichte` für Anlegen, Entwurf, Freigabe, Stände, PDF/CSV und Archivieren (services/api/src/main/java/com/voltpilot/api/web/BerichtController.java:83); Fläche PORTAL/pages/BerichtePage.tsx:1 und PORTAL/pages/BerichtSeite.tsx:1. Der Geräte-Export ohne Stand bleibt daneben.",
     "abgrenzung": "Nicht der Export (der zitiert nichts und hat keinen Stand), nicht die Erlöse-Karte (keine Berichtsquelle, E3), nicht der freie Zeitraum des Lese-Modells."},
    {"id": "berichtsvorlage", "sicht": "org", "begriff": "Berichtsvorlage", "nachtrag": "AP-12 §4.5 (E9)",
     "kurz": "Ein Katalog-Eintrag von VoltPilot mit Fassungsnummer, der Geltung, Zeitraum, Vergleichszeiträume und die festen Abschnitte eines Berichts festlegt.",
     "lang": "Es gibt vier Vorlagen: Monats- und Jahresbericht je Standort und je Unternehmen. Der Kunde wählt Vorlage, Geltung, Zeitraum und abgewählte Kennzahlen — sonst nichts. Eine neue Fassung einer Vorlage ändert keinen Berichtsstand; der nächste Entwurf nennt die neue Fassung.",
     "beispiel": "Monatsbericht Standort, Fassung 1: Kopf · Zusammenfassung · Verbrauch je Messstelle · Tagesverlauf · Kennzahlen · Qualität · Quellenverzeichnis.",
     "heute": "Gebaut mit AP-12 IP-1/IP-5 (Stand 24.09.2026, Nachtrag AP-18 W13). Der Katalog steht in `docs/contracts/v2/bericht-vorlagen.json` (heute sechs Vorlagen: die vier aus AP-12, dazu die energetische Bewertung aus AP-16 und seit AP-17 IP-21a der Leistungsvergleich) und wird byte-gleich als API-Ressource `berichte/bericht-vorlagen.json` über `GET /api/v1/bericht-vorlagen` ausgeliefert (services/api/src/main/java/com/voltpilot/api/web/BerichtVorlagenController.java:44).",
     "abgrenzung": "Nicht die Kennzahlvorlage (die legt eine Kennzahl an), nicht ein freier Berichtsdesigner (E9, nicht gewählt)."},
    {"id": "berichtsstand", "sicht": "org", "begriff": "Berichtsstand", "nachtrag": "AP-12 §4.3 (E1, E2, E5)",
     "kurz": "Der freigegebene, unveränderliche Inhalt eines Berichts zu einem Datenstand: eine Kopie mit Prüfsumme, Nummer, Person und Freigabe-Zeitpunkt.",
     "lang": "Er entsteht nur, wenn eine Person mit Recht den Entwurf freigibt — der Zeitraum ist zu Ende, jeder Wert endgültig und der Entwurf aktuell. Er wird nie geändert und nie gelöscht und hält jede Zahl mit ihrem Nachweis selbst fest, auch wenn die Messdaten ihre Aufbewahrung überschritten haben. Ändert sich eine Quelle später, bekommt er einen Anstoß; der nächste Stand ersetzt ihn, er bleibt lesbar.",
     "beispiel": "BR-2026-0001 Nr. 1 nennt MS-12 mit 6 100 kWh in Version 1 — auch 2036, wenn die Zeilen der Speicherklasse gelöscht sind.",
     "heute": "Gebaut mit AP-12 IP-4 (Stand 24.09.2026, Nachtrag AP-18 W13). Die Form steht in `docs/contracts/v2/bericht.schema.json` (Abzug, Stand); Tabelle `bericht_stand` mit Prüfsumme, Nummer und Datenstand ≤ Freigabe (MIG/V20260915050000__uems_bericht.sql:252); Freigabe und Abruf über `POST …/freigeben` und `GET …/staende/{nr}` (services/api/src/main/java/com/voltpilot/api/web/BerichtController.java:195, :214).",
     "abgrenzung": "Nicht die Version eines Werts (die gehört der Zahl), nicht der Entwurf (der bildet sich neu), nicht eine Datei (PDF und CSV werden aus ihm erzeugt)."},
    {"id": "revision", "sicht": "org", "begriff": "Revision", "nachtrag": "AP-12 §4.9 (E6, E7)",
     "kurz": "Ein neuer Berichtsstand, der den gültigen ersetzt — immer die Freigabe einer Person nach einem Anstoß, nie automatisch.",
     "lang": "Eine Korrektur, ein Ersatzwert oder eine rückwirkende Änderung der Struktur trifft einen freigegebenen Berichtsstand, wenn sie eine seiner Quellen in seinem Zeitraum ändert. Der Stand bleibt unverändert und zeigt „Revision nötig“; der Entwurf nennt jede Abweichung. Ein Anstoß kann mit Begründung verworfen werden.",
     "beispiel": "Die Korrektur K-2026-0007 stößt Nr. 1 an („Revision nötig — Korrektur K-2026-0007“); Ines Kaltenbach gibt am 16.11.2026 Nr. 2 frei, drei Abweichungen.",
     "heute": "Gebaut mit AP-12 IP-4/IP-8 (Stand 24.09.2026, Nachtrag AP-18 W13). Die Regeln stehen in `docs/contracts/v2/bericht.md` (Betroffenheit, Anstoß, Abweichung); Anstoß-Tabelle `bericht_revision_anstoss` (MIG/V20260915050000__uems_bericht.sql:341), Kaskaden-Naht `uems/BerichtKaskade` (services/api/src/main/java/com/voltpilot/api/uems/BerichtKaskade.java:61), Verwerfen mit Begründung über `POST …/anstoesse/{id}/verwerfen` (services/api/src/main/java/com/voltpilot/api/web/BerichtController.java:260).",
     "abgrenzung": "Nicht die Korrektur eines Werts (die macht eine neue Version einer Zahl), nicht das Zurücknehmen einer Freigabe (gibt es nicht)."},
    {"id": "datenstand", "sicht": "org", "begriff": "Datenstand", "nachtrag": "AP-12 §4.6 (E4)",
     "kurz": "Der Zeitpunkt, zu dem ein Berichtsentwurf oder Berichtsstand aus den Daten gebildet wurde — alle einbezogenen Werte sind älter.",
     "lang": "Der Datenstand ist eine Aussage über die Daten, die Freigabe eine über eine Person; beide stehen im Kopf eines Berichts. Ändert sich eine Quelle nach dem Datenstand, ist der Entwurf veraltet und bildet sich neu; eine Freigabe mit einem veralteten Datenstand wird abgelehnt. An einer Anlage sagt dasselbe Wort, wie aktuell ihre Daten sind — dieselbe Bedeutung an einem anderen Gegenstand.",
     "beispiel": "Berichtsstand Nr. 2: Datenstand 12.11.2026 10:05 (MEZ), freigegeben 16.11.2026 14:20 von Ines Kaltenbach.",
     "heute": "Für Berichte gebaut mit AP-12 IP-4 (Stand 24.09.2026, Nachtrag AP-18 W13). Die Regeln stehen in `docs/contracts/v2/bericht.md` (Datenstand, D1–D5); Spalte `datenstand` an Entwurf und Stand (MIG/V20260915050000__uems_bericht.sql:229, :259).",
     "abgrenzung": "Nicht der Freigabe-Zeitpunkt, nicht „endgültig ab“ eines Werts, nicht die Berechnungszeit einer einzelnen Zahl."},
    {"id": "quellenverzeichnis", "sicht": "org", "begriff": "Quellenverzeichnis", "nachtrag": "AP-12 §4.4 (E3, E6)",
     "kurz": "Die Liste aller Objekte, aus denen ein Bericht seine Zahlen hat — unmittelbar, mittelbar oder als Vergleich, je mit ihrem Zeitraum.",
     "lang": "Das Quellenverzeichnis entscheidet, welche Änderung einen Bericht trifft: Zeitraum mal Quellen, nie der Standort oder ein Name. Mittelbare Quellen (die Eingänge berechneter Messstellen, Kostenstellen und Kennzahlen) stehen mit darin, damit eine Korrektur auch den Unternehmensbericht erreicht.",
     "beispiel": "BR-2026-0001: 19 Einträge von BZ-4 bis MS-15, darunter KZ-0001 und KZ-0005.",
     "heute": "Gebaut mit AP-12 IP-4 (Stand 24.09.2026, Nachtrag AP-18 W13). Die Form einer Zeile steht in `docs/contracts/v2/bericht.schema.json` (Quelle); Tabelle `bericht_quelle` mit dem Namen zum Datenstand (MIG/V20260915050000__uems_bericht.sql:299).",
     "abgrenzung": "Nicht die Quellenbindung einer Messstelle (die verbindet Messstelle und Messkanal), nicht die Herkunft eines Werts (die erklärt eine einzelne Zahl)."},
    {"id": "werte", "sicht": "zustand", "begriff": "Werte", "nachtrag": "AP-13 §4.1 (E9, E15)",
     "kurz": "Der Abschnitt einer Messstelle, in dem ihre Zahlen für einen Zeitraum stehen: Karte, Liste, Verlauf und Vergleich.",
     "lang": "Jede Zahl steht mit Zustand, Verlauf, Fassung, Kennzeichen und Version so, wie sie gebildet wurde; fehlt eine Zahl, steht ein Strich mit dem Satz ihres Grundes, nie eine 0. Die Zeiten stehen in der Zeitzone des Standorts, und der Kopf nennt sie. Jeder Weg zur Zahl einer Messstelle — aus dem Register, einer Übersicht, einer Kennzahl oder einem Bericht — endet hier, mit Zeitraum und Version.",
     "beispiel": "MS-10 Netzbezug Halle 2 am 03.11.2026: 2.304 kWh · vollständig (Menge aus Zählerständen) · Verlauf 85 % · vorläufig — Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg).",
     "heute": "Die Tages- und Monatskarte öffnet als Dialog an der Messstelle (`frontend/portal/src/uemsWerteKarte.ts`); als Abschnitt der Messstellen-Seite kommt sie mit AP-13 IP-3. Das Wort: `frontend/portal/src/glossar.ts` (`UEMS_WERTE`).",
     "abgrenzung": "Nicht der Reiter „Messwerte“ einer Anlage (Bestand, Verdichtung in Berlin-Zeit), nicht der Register-Verlauf eines Geräts."},
    {"id": "verlauf", "sicht": "zustand", "begriff": "Verlauf", "nachtrag": "AP-13 §4.1 (E5, E15)",
     "kurz": "Die Zeichnung der Werte über einen Zeitraum — Tag in Viertelstunden, Woche in Stunden, Monat in Tagen, Jahr in Monaten.",
     "lang": "Jeder Schritt zeigt Farbe und Wort seines Zustands; ein Schritt ohne Werte ist eine Lücke ohne Linie und ohne Null, eine Folge davon eine Fläche mit Satz. „Verlauf n %“ an einer Zahl sagt, welcher Anteil der erwarteten Werte angekommen ist — das ist nicht die Vollständigkeit der Menge: ein Tag kann vollständig gemessen sein und trotzdem „Verlauf 85 %“ tragen. Dasselbe Wort wie der Bereich „Verlauf“ einer Anlage, dieselbe Bedeutung.",
     "beispiel": "MS-10 am 03.11.2026: 96 Viertelstunden, 14:00–17:31 als Lücke mit dem Satz „Lücke von 14:00 bis 17:31 — nie als 0 gerechnet“; die Karte sagt „vollständig (Menge aus Zählerständen) · Verlauf 85 %“.",
     "heute": "Das Wort und die Form des Abzeichens: `frontend/portal/src/glossar.ts` (`UEMS_VERLAUF`, `UEMS_VERLAUF_PROZENT` = `satz.abdeckung` in `docs/contracts/v2/ergebnis-zustand-vectors.json`); das Raster je Zeitraum: `frontend/portal/src/uemsOberflaechen.ts` (`verlaufRaster`). Die Zeichnung kommt mit AP-13 IP-4.",
     "abgrenzung": "Nicht die „Abdeckung“ der Bestandsflächen (Viertelstunden einer Anlage), nicht eine Hochrechnung, nicht ein freier Von–Bis-Zeitraum."},
    {"id": "vergleich", "sicht": "zustand", "begriff": "Vergleich", "nachtrag": "AP-13 §4.1 (E6, E15)",
     "kurz": "Die Werte einer Messstelle neben ihrer Vorperiode oder ihrem Vorjahr — oder neben bis zu zwei weiteren passenden Messstellen.",
     "lang": "Gegen die eigene Vorperiode steht die Differenz in kWh und Prozent, gemessen an der neuesten Version des Vergleichswerts; fehlt der Vergleichswert, steht sein Grund, nie eine 0. Zwischen zwei Messstellen gibt es keine Differenz — ein Unterschied zweier Zähler sagt nichts über einen von beiden. Passend sind Messstellen mit gleicher Größe, Richtung, Einheit und Wertart; bei den anderen nennt die Auswahl, warum nicht.",
     "beispiel": "MS-12 im November 2026 gegen Oktober 2026 (Version 2): +260 kWh (+4,3 %). MS-06 und MS-11 (Spritzguss) nebeneinander; MS-21 ist nicht passend (Volumen in m³).",
     "heute": "Die Regel „passend“: `frontend/portal/src/uemsOberflaechen.ts` (`passend`); die Differenz rechnet der Bericht-Zwilling `frontend/portal/src/uemsBericht.ts` (AP-12). Das Wort: `frontend/portal/src/glossar.ts` (`UEMS_VERGLEICH`, dasselbe Wort wie die Vergleichsquelle). Die Fläche kommt mit AP-13 IP-5.",
     "abgrenzung": "Nicht die Vergleichsquelle (eine zweite Quelle derselben Größe an EINER Messstelle, AP-04), nicht ein Benchmark gegen andere Unternehmen."},
    {"id": "datenlage", "sicht": "zustand", "begriff": "Datenlage", "nachtrag": "AP-13 §4.1 (E13, E15)",
     "kurz": "Wie viele Messstellen einer Ebene Daten liefern — „15 von 16 Messstellen liefern Daten“, EINE Zählung je Ebene.",
     "lang": "Gezählt wird aus dem Messstellen-Register: berechnete Messstellen zählen mit, eine Messstelle ohne Datenquelle steht im Nenner, manuell abgelesene werden als Zusatz genannt („· 1 manuell abgelesen“). Schweigen ist nie rot: eine Messstelle, die nicht liefert, sagt seit wann.",
     "beispiel": "Unternehmen Ahrenberg, Oktober 2026: Werk Ahrenberg „15 von 16“, Werk Lindach „4 von 4“.",
     "heute": "Die Zählung je Zeile: `services/api/src/main/java/com/voltpilot/api/uems/MessstelleRegisterService.java` (`aggregatZustand`) über `aggregatLiefertDaten` (`frontend/portal/src/uemsZustand.ts`); seit AP-13 IP-7 spricht die Karte „Funktionen“ dieselbe Zählung (`services/api/src/main/java/com/voltpilot/api/uems/FunktionZustandAbleitung.java`, `datenlage` über `register_zeilen`) und der Baustein „Messstellen“ der Übersicht liest sie aus dem Register (`frontend/portal/src/uebersichtBausteine.ts`); die Wörter: `frontend/portal/src/glossar.ts` (`UEMS_DATENLAGE`, `UEMS_MANUELL_ABGELESEN`).",
     "abgrenzung": "Nicht der Online-Status einer Anlage oder Box, nicht die Vollständigkeit einer Zahl, nicht „Verlauf n %“."},
    {"id": "grund", "sicht": "zustand", "begriff": "Grund (einer fehlenden Zahl)", "nachtrag": "AP-13 §4.10 (E11)",
     "kurz": "Der Satz, warum an einer Stelle keine Zahl steht — je Grund genau einer.",
     "lang": "Die Karte zeigt den Strich UND den Satz. Der Satz nennt nur, was das System weiß: keine Quelle, eine Quelle, die den Zeitraum nur zum Teil deckt, ein Zeitraum, der noch nicht gerechnet ist, eine Version, die es nicht gibt — nie eine Ursache, die niemand festgestellt hat, und nie eine Störung.",
     "beispiel": "MS-21 Gas Heizung Verwaltung, Oktober 2026: „— · keine Werte“ und „Keine Quelle: MS-21 Gas Heizung Verwaltung hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0.“",
     "heute": "Acht Sätze als Vertrag: `docs/contracts/v2/ergebnis-zustand.md` §9 (Block `grund`, 1.11), gesprochen von `frontend/portal/src/uemsErgebnis.ts` und `services/api/src/main/java/com/voltpilot/api/uems/ErgebnisZustand.java` (`grundSatz`). An der Karte sprechen sie mit AP-13 IP-6.",
     "abgrenzung": "Nicht ein Fehler oder eine Störung, nicht der Zustand „keine Werte“ (der sagt, DASS keine Zahl da ist), nicht die Gründe einer Kennzahl (eigener Vertrag)."},
    {"id": "betrachtungsumfang", "sicht": "org", "begriff": "Betrachtungsumfang", "nachtrag": "AP-16 §3.2, §4.1",
     "kurz": "Fassung am Unternehmen: Standorte, Träger, Ausschlüsse mit Begründung; die Anlagen folgen aus den Standorten am Stichtag.",
     "lang": "Der Betrachtungsumfang ist eine Fassung am Unternehmen: welche Standorte, welche Energieträger — und was ausdrücklich außerhalb bleibt, mit Begründung. Die Anlagen im Umfang sind die Anlagen dieser Standorte am Stichtag (zeitgültig, AP-02/AP-10); die Bilanzgrenze bleibt die Anlage (AP-10 E9) — der Umfang ist die Menge der Bilanzgrenzen, kein neues Grenzobjekt.",
     "beispiel": "Ines Kaltenbach (Energiemanager) legt am 04.11.2026 den Betrachtungsumfang fest — beide Werke, Träger Strom: ST-1 Werk Ahrenberg mit AN-1, AN-2; ST-2 Werk Lindach mit AN-3; Träger Strom mit Anteil, Gas ohne Anteil.",
     "heute": "Tabellen `bewertung_umfang`, `bewertung_umfang_standort`, `bewertung_umfang_ausschluss`; `services/api/src/main/java/com/voltpilot/api/uems/BewertungUmfangService.java` (AP-16 IP-5). Wegweiser: `docs/agents/root/uems-bewertung-umfang.md`.",
     "abgrenzung": "Nicht ein neues Grenzobjekt; nicht ein Geltungsbereich-Wort."},
    {"id": "energieeinsatz", "sicht": "org", "begriff": "Energieeinsatz", "nachtrag": "AP-16 §3.3, §4.1 (E1)",
     "kurz": "Genau ein Prozess × genau ein Träger, mit Verantwortlichem, Einflussgrößen, Messbedarf, Einstufungs-Fassungen (Kennzeichen EE-…).",
     "lang": "Ein Energieeinsatz ist genau ein Prozess und genau ein Träger (E1). Er trägt: Kennzeichen (EE-1 …), Name, Verbraucher als Wortlaut (welche Maschinen, Anlagenteile), optional Verweise auf Komponenten (die Technik), einen Verantwortlichen, Einflussgrößen, Messbedarf und Einstufungs-Fassungen.",
     "beispiel": "Sieben Energieeinsätze, je Prozess einen (Spritzguss, Montage, Druckluft, Kühlung, Logistik, Verwaltung; dazu die Gasheizung der Verwaltung als Einsatz ohne Anteil), mit Verantwortlichen aus dem Personen-Satz.",
     "heute": "Tabellen `energieeinsatz`, `energieeinsatz_einflussgroesse`, `energieeinsatz_aenderung`; `services/api/src/main/java/com/voltpilot/api/uems/EnergieeinsatzService.java`, `services/api/src/main/java/com/voltpilot/api/web/EnergieeinsatzController.java` (AP-16 IP-3/IP-4). Regeln als Vertrag: `docs/contracts/v2/bewertung.md` mit `bewertung-vectors.json`. Wegweiser: `docs/agents/root/uems-energieeinsatz.md`.",
     "abgrenzung": "Nicht der Prozess selbst; nicht eine Messstelle; nicht eine Komponente."},
    {"id": "einstufung", "sicht": "org", "begriff": "Einstufung", "nachtrag": "AP-16 §3.1, §4.1",
     "kurz": "Fassung am Einsatz: `wesentlich` · `nicht_wesentlich` · `offen`; Person, Tag, Begründung, Herkunfts-Satz.",
     "lang": "Eine Bewertung ist eine Behauptung gegenüber Dritten. Deshalb hat jede Einstufung vier Dinge, oder sie ist keine: eine Person (Konto, Name, Rolle), einen Tag (gilt ab, als Fassung), eine Begründung (Pflichtfeld, im Wortlaut) und einen Herkunfts-Satz (welche Zahl in welcher Version, welcher Nenner aus welchen Bilanzwerten, welche Kriterien-Fassung, welches Urteil). Das System liefert die ersten drei nicht und den vierten immer.",
     "beispiel": "Ines Kaltenbach stuft ein — Spritzguss wesentlich nach Zahl, Druckluft wesentlich nach ihrer begründeten Einschätzung (Querschnitt, Leckagen vermutet).",
     "heute": "Tabelle `energieeinsatz_einstufung`; `services/api/src/main/java/com/voltpilot/api/uems/EnergieeinsatzEinstufungService.java` (AP-16 IP-11); Anzeigewörter in `frontend/portal/src/glossar.ts`. Wegweiser: `docs/agents/root/uems-bewertung-einstufung.md`.",
     "abgrenzung": "Nicht ein Vorschlag; nicht etwas, das ein Läufer setzt."},
    {"id": "messbedarf", "sicht": "org", "begriff": "Messbedarf", "nachtrag": "AP-16 §3.6, §4.1 (E6)",
     "kurz": "Eintrag am Einsatz (was, wo, Größe optional, Frist), Zustand offen · eingelöst · verworfen; eingelöst durch eine eingerichtete Messstelle.",
     "lang": "Messbedarf ist ein Eintrag am Einsatz (was, wo, welche Größe — optional —, Frist), Zustand offen · eingelöst · verworfen; eingelöst wird er durch eine eingerichtete Messstelle (AP-04 E8), die bis zum Zähler „keine Datenquelle seit …“ sagt und nie 0 ist (R5).",
     "beispiel": "Aus der Rest-Zeile wird Messbedarf: „Halle 1 Lüftung, Beleuchtung, Allgemein“ → eine geplante Messstelle ohne Datenquelle → am 01.03.2027 hängt der Zähler (R5).",
     "heute": "Tabellen `messbedarf`, `messbedarf_aenderung`; `services/api/src/main/java/com/voltpilot/api/uems/MessbedarfService.java` (AP-16 IP-19). Wegweiser: `docs/agents/root/uems-messbedarf.md`.",
     "abgrenzung": "Nicht eine Messstelle; nicht eine Maßnahme (AP-18)."},
    {"id": "messmittel_angabe", "sicht": "erf", "begriff": "Messmittel-Angabe", "nachtrag": "AP-16 §3.7, §4.1 (E7)",
     "kurz": "Am Einbau: Klasse, Prüfungsart, Datum, gültig bis, Beleg; Vorgabe `nicht_erhoben`.",
     "lang": "Messmittel-Angaben stehen am Einbau: Genauigkeitsklasse, Prüfungsart (Eichung · MID-Konformität · Kalibrierung · Werksbescheinigung · keine · nicht erhoben), Prüfdatum, gültig bis, Beleg. Ein Beleg ist ein Verweis mit Prüfsumme: Bezeichnung, Ablageort beim Kunden, SHA-256 der Datei (beim Eintragen im Portal gebildet), Person, Zeitpunkt — die Datei selbst wird nicht gespeichert (E7). Die Vorgabe ist `nicht_erhoben`, nie ein erfundener Wert; ein wesentlicher Einsatz mit Messmitteln ohne Angabe wird zur Prüfaufgabe (R8).",
     "beispiel": "Am Netzzähler trägt Ines Kaltenbach Eichung und Beleg ein; am Druckluft-Zähler steht „Klasse und Prüfung nicht erhoben“ — als Prüfaufgabe, nicht als Schätzung (R8).",
     "heute": "`services/api/src/main/java/com/voltpilot/api/uems/MessmittelService.java` (AP-16 IP-15), Anzeigewörter in `frontend/portal/src/glossar.ts`. Wegweiser: `docs/agents/root/uems-messmittel.md`.",
     "abgrenzung": "Nicht eine Katalog-Eigenschaft (die steht daneben: „laut Hersteller“)."},
    {"id": "energieleistungskennzahl", "sicht": "org", "begriff": "Energieleistungskennzahl", "nachtrag": "AP-17 §4.1 (SP1, E1)",
     "kurz": "Eine Kennzahl mit freigegebener Bezugsbasis — ein Wort an der Kennzahl, kein eigenes Objekt.",
     "lang": "Eine Energieleistungskennzahl ist eine Kennzahl (AP-11), für die eine Bezugsbasis freigegeben ist. Sie ist kein neues Objekt und keine neue Rechenform: Wert, Versionen, Kaskade und Herkunft der Kennzahl bleiben, wie sie sind (Invariante 1). Das Wort leitet der Leser aus der freigegebenen Fassung ab; ohne Basis bleibt die Kennzahl eine allgemeine Kennzahl (R10).",
     "beispiel": "KZ-0004 „Strom je Kilogramm Spritzguss“ wird mit der Freigabe von BB-0001 zur Energieleistungskennzahl; KZ-0003 bleibt ohne Basis eine Kennzahl wie bisher.",
     "heute": "Kein Feld, sondern abgeleitet: `bezugsbasis` am Register-Eintrag der Kennzahl (`services/api/src/main/java/com/voltpilot/api/web/dto/KennzahlDto.java`, AP-17 IP-8; für eine Kennzahl ohne Basis `null`); Anzeigewort `UEMS_ENERGIELEISTUNGSKENNZAHL` (PORTAL/glossar.ts:542). Wegweiser: `docs/agents/root/uems-bezugsbasis.md`.",
     "abgrenzung": "Nicht eine neue Kennzahl-Art; nicht eine gespeicherte bereinigte Kennzahl (Rechenform `modell` bleibt Folgestufe, E7)."},
    {"id": "bezugsbasis", "sicht": "org", "begriff": "Bezugsbasis", "nachtrag": "AP-17 §4.2–§4.5 (B1, B4, F1–F5)",
     "kurz": "Fassung an einer Kennzahl: Referenzperiode, Methode, eingefrorene Grundlage, Basiswert; Freigabe durch eine Person (BB-…).",
     "lang": "Eine Bezugsbasis hängt an genau einer Kennzahl (eine laufende je Kennzahl) und trägt Fassungen. Jede Fassung nennt Referenzperiode, Methode (Verhältnis, eine oder zwei Einflussgrößen, Gradtage), die eingefrorene Grundlage mit Prüfsumme, Basiswert und Koeffizienten samt Modellgüte, statische Faktoren und Begründung. Eine Person gibt frei (Vier-Augen nach Unternehmenseinstellung); danach bleibt die Fassung byte-gleich — eine Änderung darunter ist ein Anstoß, den eine Person beantwortet (Fassung n + 1 oder bestätigt). Kein Läufer legt an, gibt frei, fasst neu oder beendet (Invariante 4).",
     "beispiel": "BB-0001 an KZ-0004: Fassung 1 vorläufig (Referenzperiode Oktober 2026, Verhältnis), Fassung 2 mit Einflussgröße Produktionsmenge BZ-6, freigegeben von Ines Kaltenbach.",
     "heute": "Tabellen `bezugsbasis`, `bezugsbasis_fassung`, `bezugsbasis_anstoss`, `bezugsbasis_aenderung` (MIG/V20260924071500__uems_bezugsbasis.sql:151, :228, :481, :511; RLS + FORCE); Routen `/api/v1/kennzahlen/{id}/bezugsbasen` (services/api/src/main/java/com/voltpilot/api/web/BezugsbasisController.java:39); Dienst `services/api/src/main/java/com/voltpilot/api/uems/BezugsbasisService.java`, Grundlage `services/api/src/main/java/com/voltpilot/api/uems/BezugsbasisGrundlage.java`, Anstoß `services/api/src/main/java/com/voltpilot/api/uems/BezugsbasisAnstoss.java`; Vertrag `docs/contracts/v2/bezugsbasis.md` mit `bezugsbasis-vectors.json`, Zwillinge `services/api/src/main/java/com/voltpilot/api/uems/BezugsbasisRegeln.java` · Portal · Python. Wegweiser: `docs/agents/root/uems-bezugsbasis.md`.",
     "abgrenzung": "Nicht ein Ziel und keine Maßnahme (AP-18); nicht eine Vorperiode (der Vergleich rechnet „erwartet“ statt „Vormonat“)."},
    {"id": "referenzperiode", "sicht": "org", "begriff": "Referenzperiode", "nachtrag": "AP-17 §4.3 (P1–P3, E2)",
     "kurz": "Die Monate einer Fassung, aus denen Basiswert und Modell gerechnet werden; unter zwölf Monaten „vorläufig (n von 12)“.",
     "lang": "Die Referenzperiode ist ein Monatsbereich an der Fassung (`JJJJ-MM/JJJJ-MM`). Sie gilt erst als vollständig, wenn ihre Monate endgültig sind (Endgültigkeits-Läufer, AP-07); die Werte der Kennzahl, der Messstellen und der Einflussgrößen werden mit Version in die Grundlage eingefroren. Kürzer als zwölf Monate wird die Zahl trotzdem gebildet und trägt „vorläufig (n von 12)“ (E2 = A).",
     "beispiel": "Fassung 1 von BB-0001: Referenzperiode 2026-10/2026-10 — „vorläufig (1 von 12)“.",
     "heute": "Spalte `referenzperiode` an `bezugsbasis_fassung` (MIG/V20260924071500__uems_bezugsbasis.sql:228); Leser `services/api/src/main/java/com/voltpilot/api/uems/BezugsbasisGrundlage.java` (AP-17 IP-7); Anzeigewort `UEMS_REFERENZPERIODE` (PORTAL/glossar.ts:544).",
     "abgrenzung": "Nicht der Vergleichszeitraum; nicht ein Kalender (W2, E10 = A)."},
    {"id": "einflussgroesse", "sicht": "org", "begriff": "Einflussgröße (Variable)", "nachtrag": "AP-17 §4.4 (V1, V2, E3)",
     "kurz": "Eine Bezugsgröße mit Periodenwerten, die das Modell einer Fassung als Variable liest (höchstens zwei).",
     "lang": "Eine Einflussgröße der Bezugsbasis ist eine Bezugsgröße (AP-09) mit Werten je Periode, zitiert mit ihrer Fassung. Das Modell der Fassung nimmt eine oder zwei (E4 = A: keine nichtlinearen Modelle, keine dritte Variable). Der Vorschlag kommt aus den Einflussgrößen des Energieeinsatzes (AP-16) — dort sind sie Dokumentation, hier eine gerechnete Variable. Die Betriebszeit ist eine Variable wie jede (W2).",
     "beispiel": "Produktionsmenge BZ-6 (kg je Monat) als Einflussgröße von BB-0001; die Gradtagzahl BZ-8 als Einflussgröße der Heizung.",
     "heute": "Tabelle `bezugsbasis_variable` (MIG/V20260924071500__uems_bezugsbasis.sql:384); Vorschlag `GET /api/v1/kennzahlen/{id}/variablen-vorschlag` (services/api/src/main/java/com/voltpilot/api/web/KennzahlVariablenVorschlagController.java:42, `services/api/src/main/java/com/voltpilot/api/uems/VariablenVorschlag.java`, AP-17 IP-11a); Anzeigewort `UEMS_EINFLUSSGROESSE` (PORTAL/glossar.ts:545).",
     "abgrenzung": "Nicht die Einflussgröße des Energieeinsatzes selbst (die bleibt Wortlaut, AP-16 W1); nicht ein statischer Faktor."},
    {"id": "statischer_faktor", "sicht": "org", "begriff": "Statischer Faktor", "nachtrag": "AP-17 §4.4 (V3, E6)",
     "kurz": "Was in der Referenzperiode als gleichbleibend angenommen wird, als Liste an der Fassung — ändert es sich, entsteht ein Anstoß.",
     "lang": "Ein statischer Faktor ist eine Annahme an der Fassung: Fläche, Standort, Anlage, Prozess-Zuordnung oder ein Wortlaut. Die strukturellen Faktoren werden zum Stichtag aus der Struktur kopiert und beim Freigeben neu gelesen; ändert sich einer danach, stößt der Struktur-Läufer die Fassung an (Pfad 2). Ein Wortlaut-Faktor löst nie etwas aus (E6 = A).",
     "beispiel": "An BB-0001: Fläche Halle 1 = 4 200 m² zum 01.10.2026; „Ein-Schicht-Betrieb“ als Wortlaut.",
     "heute": "Tabelle `bezugsbasis_faktor` (MIG/V20260924071500__uems_bezugsbasis.sql:415); Vorschlag `GET /api/v1/kennzahlen/{id}/faktoren-vorschlag` (services/api/src/main/java/com/voltpilot/api/web/FaktorenVorschlagController.java:42, `services/api/src/main/java/com/voltpilot/api/uems/FaktorenVorschlag.java`), Kopie zum Stichtag `services/api/src/main/java/com/voltpilot/api/uems/BezugsbasisFaktoren.java` (AP-17 IP-16a/b); Anzeigewort `UEMS_STATISCHER_FAKTOR` (PORTAL/glossar.ts:546).",
     "abgrenzung": "Nicht ein Betriebskalender und kein Schichtmodell als Stammdatum (E10 = A); nicht eine Variable."},
    {"id": "leistungsvergleich", "sicht": "org", "begriff": "Leistungsvergleich", "nachtrag": "AP-17 §4.7–§4.9 (U1–U6, S1–S5, E8)",
     "kurz": "Wert gegen „erwartet“ aus der freigegebenen Basis: roh ohne Urteil, bereinigt mit Band und Bedingung; als Bericht ein Stand mit Prüfsumme.",
     "lang": "Der Leistungsvergleich stellt je Monat den Wert der Kennzahl dem erwarteten Wert der freigegebenen Fassung gegenüber. Roh gibt es kein Urteil; bereinigt urteilt er „besser · im Rahmen · schlechter“ nur mit Band = max(Toleranz, Streuung), Variable, Basis-Fassung und Vorbehalten, sonst steht ein Grund statt einer Zahl (außerhalb der Spannweite `nicht_anwendbar`). Der Zeitraum rechnet Σ ÷ Σ. Als Bericht ist er die Vorlage `leistungsvergleich` je Kennzahl; ein freigegebener Stand belegt die Basis-Fassung (409 `berichts_belege`).",
     "beispiel": "Dezember 2027 für Spritzguss: KZ-0004 gegen BB-0001 Fassung 2, bereinigt um die Produktionsmenge — Stand Nr. 1 mit Prüfsumme (R8).",
     "heute": "Leser `GET /api/v1/kennzahlen/{id}/vergleich` (services/api/src/main/java/com/voltpilot/api/web/BezugsbasisVergleichController.java:44, `services/api/src/main/java/com/voltpilot/api/uems/BezugsbasisVergleich.java`, AP-17 IP-19/IP-13); Vorlage `leistungsvergleich` in `bericht_vorlage()` (MIG/V20260924071945__uems_leistungsvergleich_vorlage.sql:68), Spalte `bericht.kennzahl_id` (MIG/V20260924211800__uems_leistungsvergleich_kennzahl.sql:7), Abzug `services/api/src/main/java/com/voltpilot/api/uems/BerichtLeistungsvergleich.java` (AP-17 IP-21a/b, IP-22); Anzeigewort `UEMS_LEISTUNGSVERGLEICH` (PORTAL/glossar.ts:551).",
     "abgrenzung": "Nicht der Vergleich der Messdaten-Oberflächen (AP-13, Vorperiode); nicht eine Ursache und keine Maßnahmenwirkung (AP-18, U6)."},
    {"id": "wetterbezug", "sicht": "erf", "begriff": "Wetterbezug", "nachtrag": "AP-17 §6.6 (E9 = C)",
     "kurz": "Eine Gradtagzahl am Standort, deren Tagesmittel VoltPilot aus einem Wetter-Archiv bezieht — Herkunft `bezogen`.",
     "lang": "Der Wetterbezug bindet eine Gradtagzahl eines Standorts an das Wetter-Archiv (Open-Meteo-Archiv; Quelle, Adresse und Schlüssel sind Werte des Betreibers). Ein täglicher Abruf holt die Tagesmittel über die Koordinaten des Standorts und schreibt Gradtage mit Herkunft `bezogen`, Quelle und Abrufzeit. Ein fehlender Tag fehlt — nie eine Null; der Monat ist dann „unvollständig, x von y Tagen“, der nächste Abruf holt nach. Ein gebundener Wetterbezug sperrt Eingabe und Import derselben Zahl.",
     "beispiel": "BZ-8 „Gradtagzahl Werk Ahrenberg“ (G20/15) ist an das Wetter-Archiv gebunden; der Oktober 2026 hat 31 von 31 Tagen.",
     "heute": "Tabelle `bezugsgroesse_wetterbezug` und Spalten `bezugsgroesse_wert.bezug_quelle`, `abgerufen_am`, `bezug_herkunft` (MIG/V20260924192700__uems_wetter_archiv_bezug.sql:310, :344); Takt `services/api/src/main/java/com/voltpilot/api/uems/WetterArchivLaeufer.java` (06:10 Europe/Berlin, Not-Aus `VOLTPILOT_UEMS_WETTER_ARCHIV_ENABLED`), Abruf `services/api/src/main/java/com/voltpilot/api/uems/WetterArchivAbruf.java`, Quelle `services/api/src/main/java/com/voltpilot/api/uems/OpenMeteoWetterArchiv.java` (AP-17 IP-12b); Binden/Lösen `PUT/DELETE /api/v1/bezugsgroessen/{id}/wetterbezug` (services/api/src/main/java/com/voltpilot/api/web/WetterbezugController.java:33, AP-17 IP-12c).",
     "abgrenzung": "Nicht eine Vorhersage (AP-09 E13); nicht eine Temperatur-Datei des Kunden (benannte Folgestufe, Auslegung LA1)."},
    {"id": "energieziel", "sicht": "org", "begriff": "Energieziel", "nachtrag": "AP-18 §4.1, §4.3 (Z1–Z5, E3)",
     "kurz": "Ein Ziel an genau einer Energieleistungskennzahl: Prozent weniger, als die Bezugsbasis erwarten lässt, für eine feste Zielperiode (EZ-…).",
     "lang": "Ein Energieziel zitiert eine Energieleistungskennzahl mit ihrer freigegebenen Bezugsbasis-Fassung und setzt einen Zielwert in Prozent gegenüber dem Erwarteten für ganze Monate (Zielperiode, vorher gesetzt, nie rückwirkend), dazu Verantwortlichen und Begründung. Den Ziel-Stand liest das Portal beim Abruf (Σ gemessen ÷ Σ erwartet über die endgültigen Monate, „x von y“); „erreicht“ oder „verfehlt“ ist der Vorschlag nur bei vollständiger Periode, die Bewertung ist ein Stand einer Person mit Prüfsumme (E3 = A). Zustand offen · bewertet · beendet.",
     "beispiel": "EZ-2028-0001 „Spritzguss: 5,0 % weniger Strom als die Bezugsbasis erwarten lässt“ an KZ-0004 mit BB-0001 Fassung 2, Zielperiode 2028-01/2028-12, angelegt von Ines Kaltenbach am 20.12.2027.",
     "heute": "Tabellen `energieziel`, `energieziel_aenderung`, Zähler `verbesserung_kennung_seq` (MIG/V20260924223000__uems_verbesserung.sql:228, :469, :142; RLS + FORCE); Routen `/api/v1/energieziele` (services/api/src/main/java/com/voltpilot/api/web/EnergiezielController.java:47, services/api/src/main/java/com/voltpilot/api/uems/EnergiezielService.java, AP-18 IP-6/IP-7); Anzeigewort `UEMS_ENERGIEZIEL` (PORTAL/glossar.ts:578). Wegweiser: `docs/agents/root/uems-energieziel-routen.md`.",
     "abgrenzung": "Nicht ein Steuerungs-Ziel („Ziel: 2,2 kW“ gehört der Steuerung, W6); nicht ein absoluter kWh-Wert; nicht die Toleranz der Bezugsbasis."},
    {"id": "massnahme", "sicht": "org", "begriff": "Maßnahme", "nachtrag": "AP-18 §4.1, §4.4 (M1–M7, E1, E2)",
     "kurz": "Ein geplantes Vorhaben mit Verantwortlichem, Termin und erwarteter Wirkung (M-…); geplant · umgesetzt · bewertet · verworfen.",
     "lang": "Eine Maßnahme trägt Titel, Verantwortlichen (aktives Konto, Fremdschlüssel plus Schnappschuss), Termin, Herkunft (Auffälligkeit, Energieziel, Energieeinsatz oder von Hand) und die erwartete Wirkung als Wortlaut. Die Messgrundlage — Energieleistungskennzahl × Bezugsbasis-Fassung × Ausgangslage als Kopie mit Prüfsumme — ist beim Anlegen wahlfrei und erst für die Bewertung der Wirkung Pflicht (E2 = A); ohne sie gibt es keine Zahl, nur „nicht messbar“. „Überfällig seit n Tagen“ leitet der Abruf ab — kein Läufer, keine Nachricht (E5 = A).",
     "beispiel": "M-2028-0001 „Werkzeugheizungen in Betriebspausen abschalten“, verantwortlich Murat Demirci, mit Messgrundlage KZ-0004 × BB-0001 Fassung 2; M-2028-0002 „Druckluft-Leckagen orten und beseitigen“ am Einsatz EE-3 ohne Messgrundlage.",
     "heute": "Tabellen `massnahme`, `massnahme_aenderung`, `massnahme_bewertung` (MIG/V20260924233000__uems_massnahme.sql:170, :428, :466; RLS + FORCE); Routen `/api/v1/massnahmen` (services/api/src/main/java/com/voltpilot/api/web/MassnahmeController.java:49, services/api/src/main/java/com/voltpilot/api/uems/MassnahmeService.java, AP-18 IP-10/IP-12); Anzeigewort `UEMS_MASSNAHME` (PORTAL/glossar.ts:582). Wegweiser: `docs/agents/root/uems-massnahme-routen.md`.",
     "abgrenzung": "Nicht ein Messbedarf (AP-16); nicht eine Korrektur (AP-08); nicht ein Anstoß; kein „Aktionsplan“ und keine „Korrekturmaßnahme“ (SP1)."},
    {"id": "abweichung", "sicht": "org", "begriff": "Abweichung", "nachtrag": "AP-18 §4.1, §4.5 (A2–A6, E1, E7)",
     "kurz": "Ein Vorgang, den eine Person zu einer Auffälligkeit eröffnet, untersucht und mit Ergebnis abschließt (AW-…).",
     "lang": "Eine Abweichung zitiert Kennzahl, Bezugsbasis-Fassung und Monate; ihr Anlass ist die Kopie des Vergleichsergebnisses mit Prüfsumme. Sie hat Verantwortlichen und Frist, ein Protokoll aus Kommentaren und Ursache-Aussagen (append-only) und endet mit einem Abschluss einer Person: Maßnahme (nur mit Verweis), erklärt, keine Abweichung oder nicht bewertbar — immer mit Begründung. Nichts wird gelöscht.",
     "beispiel": "AW-2028-0001 zur Auffälligkeit Dezember 2027 an KZ-0004: Frist, zwei Kommentare, eine Ursache-Aussage von Murat Demirci; am 15.01.2028 von Ines Kaltenbach mit Ergebnis „Maßnahme“ (M-2028-0001) abgeschlossen.",
     "heute": "Tabellen `abweichung`, `abweichung_aenderung` (MIG/V20260924235130__uems_abweichung.sql:214, :376; RLS + FORCE); Routen `/api/v1/abweichungen` (services/api/src/main/java/com/voltpilot/api/web/AbweichungController.java:45, services/api/src/main/java/com/voltpilot/api/uems/AbweichungService.java, AP-18 IP-16); Anzeigewort `UEMS_ABWEICHUNG` (PORTAL/glossar.ts:586). Wegweiser: `docs/agents/root/uems-abweichung-routen.md`.",
     "abgrenzung": "Nicht der Toleranz-Befund einer Vergleichsquelle (AP-16 E10, W10); nicht eine Nichtkonformität des Managementsystems (AP-19, E7); „wesentlich“ bleibt das Wort der Einstufung (W2)."},
    {"id": "auffaelligkeit", "sicht": "org", "begriff": "Auffälligkeit", "nachtrag": "AP-18 §4.1, §4.5 (A1, E4)",
     "kurz": "Ein Vermerk an der Energieleistungskennzahl: ein endgültiger Monat mit Urteil „schlechter“ — eine Person antwortet.",
     "lang": "Wird ein Monatswert einer Kennzahl mit freigegebener Bezugsbasis endgültig und urteilt der bereinigte Vergleich „schlechter“ (außerhalb des Bands der Basis — keine zweite Schwelle), vermerkt die Naht in derselben Transaktion genau eine Auffälligkeit mit Kopie des Vergleichsergebnisses und Prüfsumme (E4 = A). Sie ist kein Vorgang: eine Person antwortet einmal mit „Abweichung eröffnen“ oder „zur Kenntnis genommen“ (mit Begründung). Das System urteilt nicht und legt nichts an.",
     "beispiel": "Dezember 2027 wird am 07.01.2028 endgültig; der Vergleich von KZ-0004 sagt 12,9 % mehr als erwartet — schlechter; Ines Kaltenbach eröffnet AW-2028-0001.",
     "heute": "Tabelle `auffaelligkeit` (MIG/V20260924235130__uems_abweichung.sql:430; RLS + FORCE, Admin-`INSERT` aus MIG/V20260925002000__uems_auffaelligkeit_admin.sql); Naht services/api/src/main/java/com/voltpilot/api/uems/VerbesserungNaht.java (AP-18 IP-15, Schalter `voltpilot.uems.verbesserung.enabled`); Routen `/api/v1/kennzahlen/{id}/auffaelligkeiten` (services/api/src/main/java/com/voltpilot/api/web/AuffaelligkeitController.java:44); Anzeigewort `UEMS_AUFFAELLIGKEIT` (PORTAL/glossar.ts:588). Wegweiser: `docs/agents/root/uems-verbesserung-naht.md`.",
     "abgrenzung": "Nicht ein Alarm und keine Nachricht (E5 = A); nicht ein Urteil des Läufers; nicht „wesentlich“ (W2)."},
    {"id": "ursache_aussage", "sicht": "org", "begriff": "Ursache-Aussage", "nachtrag": "AP-18 §4.1, §4.6 (U1–U3, E6)",
     "kurz": "Der Wortlaut einer Person zur Ursache einer Abweichung — immer „Aussage von <Name>, <Datum>“.",
     "lang": "Eine Ursache nennt in VoltPilot nie das System: sie ist ein Eintrag im Protokoll einer Abweichung mit Namen, Datum und Wortlaut der Person, wahlfrei mit Beleg-Kennung (etwa ein Messmittel-Befund oder ein Zählerwechsel). Überall, wo sie erscheint, steht „Aussage von …“; ein Satz des Systems mit „Ursache“ ist verboten (Sprach-Wächter, SP1).",
     "beispiel": "„Ursache — Aussage von Murat Demirci, 14.01.2028 (keine Messung): ‚Die Werkzeugheizungen der Maschinen 3 bis 6 liefen vom 23.12. bis 02.01. durch.‘“",
     "heute": "Eintrag der Art `ursache` in `abweichung_aenderung` (MIG/V20260924235130__uems_abweichung.sql:376), Route `POST /api/v1/abweichungen/{id}/eintraege` (services/api/src/main/java/com/voltpilot/api/web/AbweichungController.java:45); Anzeigewort `UEMS_URSACHE_AUSSAGE_VON` (PORTAL/glossar.ts:599); Wächter `frontend/portal/src/copy.test.ts` (Block AP-18 IP-4).",
     "abgrenzung": "Nicht ein Satz des Systems; nicht ein Vokabular von Ursachen; nicht eine „Ursachenanalyse“ (SP1)."},
    {"id": "wirkung", "sicht": "org", "begriff": "Wirkung (beobachtet · belegt)", "nachtrag": "AP-18 §4.1, §4.7 (WK1–WK6, E6)",
     "kurz": "Beobachtet: was der Leser nach der Umsetzung misst, mit Bedingung. Belegt: das Wort einer Person, als Stand mit Prüfsumme.",
     "lang": "Die beobachtete Wirkung liest das Portal beim Abruf: Nachher-Monate ab dem Monat nach der Umsetzung (Startwert zwölf, verlängerbar bis 36), Σ gemessen ÷ Σ erwartet über die bewertbaren Monate, „x von 12“, Ausschlüsse mit Grund, Urteil nur mit Band. Ohne Stand steht „beobachtet — nicht belegt“. „Belegt“, „nicht belegt“ oder „nicht messbar“ sagt eine Person in einer Bewertung (Stand Nr. n: Kopie der Wirkung mit Prüfsumme, Begründung, Vier-Augen nach Einstellung) — das System sagt nie, eine Maßnahme habe gewirkt (E6 = A).",
     "beispiel": "M-2028-0001 am 15.11.2028: 2,4 % weniger, als die Bezugsbasis erwarten lässt, über 8 von 12 Monaten (März nicht bewertbar, Juli schlechter) — erwartet waren 3,0 % weniger; der Januar 2028 vor der Umsetzung zählt nicht.",
     "heute": "Leser `GET /api/v1/massnahmen/{id}/wirkung` (services/api/src/main/java/com/voltpilot/api/web/MassnahmeController.java:105, services/api/src/main/java/com/voltpilot/api/uems/MassnahmeWirkung.java, AP-18 IP-11), Stand `massnahme_bewertung` (MIG/V20260924233000__uems_massnahme.sql:466, services/api/src/main/java/com/voltpilot/api/uems/MassnahmeBewertung.java, IP-12); Operation `wirkung` in `docs/contracts/v2/verbesserung-vectors.json`; Anzeigewörter `UEMS_WIRKUNG`, `UEMS_BEOBACHTET_NICHT_BELEGT`, `UEMS_MASSNAHME_ERGEBNISSE` (PORTAL/glossar.ts:593).",
     "abgrenzung": "Nicht „hat gewirkt“ und keine „Einsparung durch“ (SP1); nicht ein Mittel und kein gespeicherter Wert; nicht der Ziel-Stand eines Energieziels."},
    {"id": "anstoss_am_vorgang", "sicht": "org", "begriff": "Anstoß am Vorgang", "nachtrag": "AP-18 §4.1, §4.4 (M5, Z5, E4)",
     "kurz": "Ein Vermerk an Maßnahme oder Energieziel, wenn eine zitierte Zahl eine neue Version bekommt oder die Bezugsbasis endet bzw. neu gefasst wird.",
     "lang": "Die Kopien einer Maßnahme (Ausgangslage, Bewertung) und eines Energieziels (Bewertung) bleiben byte-gleich. Bekommt ein zitierter Monat in der Kaskade Version n + 1 (Pfad 1) oder endet die zitierte Bezugsbasis bzw. wird nach der Umsetzung neu gefasst (Pfad 2, Struktur-Läufer), vermerkt die Naht einen Anstoß. Eine Person antwortet: bleibt, neu kopiert oder neu bewertet — immer mit Begründung. Muster wie beim Bericht (AP-12 E7) und bei der Bezugsbasis (AP-17), eine Stufe höher.",
     "beispiel": "K-2028-0001 berichtigt MS-06 um −600 kWh; der Dezember 2027 von KZ-0004 wird Version 2; die Ausgangslage von M-2028-0001 bleibt Version 1 und bekommt „Ausgangslage korrigiert“ — Ines Kaltenbach antwortet „bleibt“ mit Begründung (R12).",
     "heute": "Tabelle `vorgang_anstoss` (MIG/V20260924233000__uems_massnahme.sql:596; RLS + FORCE); services/api/src/main/java/com/voltpilot/api/uems/VorgangAnstoss.java über services/api/src/main/java/com/voltpilot/api/uems/VerbesserungNaht.java (AP-18 IP-17), Antwort `POST /api/v1/massnahmen|energieziele/{id}/anstoesse/{aid}/antwort` (services/api/src/main/java/com/voltpilot/api/uems/VorgangAntwort.java). Wegweiser: `docs/agents/root/uems-vorgang-anstoss.md`.",
     "abgrenzung": "Nicht ein Umbau der Kopie; nicht ein Läufer, der antwortet; nicht der Anstoß am Bericht (AP-12) oder an der Bezugsbasis (AP-17)."},
    {"id": "energiemanagement_bereich", "sicht": "org", "begriff": "Energiemanagement (Bereich)", "nachtrag": "AP-19 §4.1, §3.1 (G1–G5, E1)",
     "kurz": "Die neunte Seite am Unternehmen: Verzeichnis, Wiedervorlage, Dokumente, Aufgaben, Audits, Feststellungen, Managementbewertung.",
     "lang": "VoltPilot hält fest, der Kunde entscheidet, und jede Zeile sagt, wo das Original liegt (E1 = A). Der Bereich führt, was an VoltPilot hängt (Anwendungsbereich, Aufgaben, Bekanntmachungen, Audits, Feststellungen, Managementbewertung, die Energiepolitik als Wortlaut) und verweist auf alles andere. Jede Fläche trägt den Grenz-Satz und den Verantwortungs-Satz; kein Erfüllungsgrad, keine Ampel, keine Zahl über das Ganze (G4). Ohne Eintrag zeigt der Bereich die Nachweise der Vorgänger und je leerer Gruppe „Hier ist noch nichts festgehalten.“ (R15).",
     "beispiel": "Werk Ahrenberg am 12.02.2029: 62 Nachweise in 11 Gruppen im Verzeichnis, 8 fällige Zeilen in der Wiedervorlage (R3, R12).",
     "heute": "Seite `#/portfolio/energiemanagement` (PORTAL/pages/EnergiemanagementBereich.tsx:1, AP-19 IP-9/IP-13/IP-20); Kundenwort `UEMS_ENERGIEMANAGEMENT`, Verantwortungs-Satz `UEMS_VERANTWORTUNG` (PORTAL/glossar.ts:675, :719); Wörter `energiemanagement_vokabular()` (MIG/V20260925013500__uems_energiemanagement.sql:50); kein Schalter, kein Läufer (`UemsEnergiemanagementBestandsschutzTest`). Wegweiser: `docs/agents/root/uems-energiemanagement-abschluss.md`.",
     "abgrenzung": "Nicht ein „Managementsystem“ im Sinn einer Zertifizierung und kein allgemeines Dokumentenmanagement (SP2, G5); nicht die Funktion „Messen“."},
    {"id": "verzeichnis", "sicht": "org", "begriff": "Verzeichnis", "nachtrag": "AP-19 §4.1, §4.9 (VZ1–VZ4, KS2)",
     "kurz": "Der Leser über alle Nachweise und Entscheidungen: je Zeile Träger, Fassung oder Nr., Prüfsumme und Ort des Originals.",
     "lang": "Das Verzeichnis sammelt beim Abruf die Nachweise aller Pakete — Dokumente, Aufgaben, Audits, Feststellungen, Berichtsstände, Bewertungen, Bezugsbasen, Maßnahmen — in elf festen Gruppen; jede Zeile nennt, wer entschieden hat, wann, mit welcher Fassung oder Nr., mit Prüfsumme und dem Ort (in VoltPilot oder „Geführt in Ihrem System“). Es zählt nichts zusammen und urteilt nicht; der CSV-Abzug trägt Stichtag und Verantwortungs-Satz.",
     "beispiel": "Am 12.02.2029 zeigt der Filter „in meinem Namen festgehalten“ für Robert Falk 11 Zeilen; die Gruppe „Risiken und Chancen“ sagt „Hier ist noch nichts festgehalten.“ (R3).",
     "heute": "`GET /api/v1/energiemanagement/verzeichnis` (services/api/src/main/java/com/voltpilot/api/web/EnergiemanagementVerzeichnisController.java:30, services/api/src/main/java/com/voltpilot/api/uems/EnergiemanagementVerzeichnisService.java, Quellen `VerzeichnisQuelle`, AP-19 IP-8); Operation `verzeichnis_zeile` in `docs/contracts/v2/energiemanagement-vectors.json`; Kundenwort `UEMS_VERZEICHNIS` (PORTAL/glossar.ts:676). Wegweiser: `docs/agents/root/uems-energiemanagement-dokumente.md`.",
     "abgrenzung": "Nicht eine Ablage und keine Datei; nicht eine Checkliste; nicht ein Erfüllungsgrad (G4)."},
    {"id": "wiedervorlage", "sicht": "org", "begriff": "Wiedervorlage", "nachtrag": "AP-19 §4.1, §4.9 (WV1–WV5, E10)",
     "kurz": "Der Leser über alle Fristen aller Objekte, am längsten fällig zuerst, mit 30 Tagen Vorschau.",
     "lang": "Die Wiedervorlage rechnet keine Frist selbst: jede Quelle gibt ihr „fällig am“ aus der Regel ihres Objekts (Überprüfung eines Dokuments, nächstes internes Audit, Frist einer Feststellung, Bewertung, Bezugsbasis, Revisions-Anstoß eines Berichts, Maßnahmen und Energieziele). Nichts wird verschickt; der Kalender-Abzug ist ein Abruf mit Stand-Vermerk (E10 = A). Der Baustein „Energiemanagement“ erscheint nur mit Inhalt.",
     "beispiel": "12.02.2029: 8 fällige Zeilen (vier Bezugsbasen seit 457, 450, 344 und 80 Tagen …) und M-2029-0001 in 16 Tagen als Vorschau (R12).",
     "heute": "`GET /api/v1/energiemanagement/wiedervorlage?format=json|ics` (services/api/src/main/java/com/voltpilot/api/web/EnergiemanagementWiedervorlageController.java:27, services/api/src/main/java/com/voltpilot/api/uems/EnergiemanagementWiedervorlageService.java, AP-19 IP-21); Kundenwort `UEMS_WIEDERVORLAGE` (PORTAL/glossar.ts:677). Wegweiser: `docs/agents/root/uems-energiemanagement-wiedervorlage.md`.",
     "abgrenzung": "Nicht ein Postfach, kein Läufer und keine Erinnerung per E-Mail (E10 = A)."},
    {"id": "dokument_fassung", "sicht": "org", "begriff": "Dokument · Fassung", "nachtrag": "AP-19 §4.1, §4.4 (DK1–DK8, E2)",
     "kurz": "Ein Dokument D-nnnn mit Art, Bezug und Fassungen Nr. n — Wortlaut oder Verweis —, Freigabe mit „entschieden von“, Überprüfung und Bekanntmachung.",
     "lang": "Ein Dokument hat eine von zwölf Arten (keine „Sonstiges“, G5) und genau seinen Bezug. Jede Fassung ist entweder Wortlaut in VoltPilot (bis 20 000 Zeichen) oder Verweis auf das Original beim Kunden (Bezeichnung, Ablage, Kennung, Adresse, Fassungsangabe, Prüfsumme aus dem Browser) — nie eine Datei (E2 = A). Die Freigabe trägt „entschieden von“ (eine Person, auch ohne Konto) und „eingetragen von“ (ein Konto), bei Energiepolitik und Anwendungsbereich die Leitung; eine freigegebene Fassung ist unveränderlich, die nächste löst sie ab.",
     "beispiel": "D-0001 Energiepolitik Fassung 1 am 15.12.2026 — entschieden von Robert Falk (ohne Konto), eingetragen von Ines Kaltenbach; D-0004 ist ein Verweis auf den Arbeitsplan IH-SG-01 Rev. 4 im Instandhaltungssystem (R1, R7).",
     "heute": "Tabellen `energiemanagement_dokument`, `energiemanagement_dokument_fassung`, `energiemanagement_dokument_eintrag` (MIG/V20260925013500__uems_energiemanagement.sql:532, :675, :960; RLS + FORCE); Routen `/api/v1/energiemanagement/dokumente` (services/api/src/main/java/com/voltpilot/api/web/EnergiemanagementDokumentController.java:44, AP-19 IP-7); Kundenwörter `UEMS_DOKUMENT`, `UEMS_WORTLAUT`, `UEMS_VERWEIS`, `UEMS_GEFUEHRT_IN_IHREM_SYSTEM` (PORTAL/glossar.ts:678). Wegweiser: `docs/agents/root/uems-energiemanagement-dokumente.md`.",
     "abgrenzung": "Nicht eine Datei, kein Ordner und kein Anhang (E2 = A); nicht die „Revision“ eines Berichts (SP3)."},
    {"id": "energiepolitik", "sicht": "org", "begriff": "Energiepolitik · Anwendungsbereich", "nachtrag": "AP-19 §4.1, §4.4 (DK3, DK7, W5)",
     "kurz": "Zwei Dokument-Arten mit Leitungs-Pflicht: der Wortlaut der Energiepolitik und die Grenze des Energiemanagements.",
     "lang": "Die Energiepolitik steht als Wortlaut in VoltPilot, das unterschriebene Original bleibt beim Kunden. Der Anwendungsbereich nennt Standorte, Energieträger und Ausschlüsse mit Begründung. Beide gibt die Leitung frei. Neben dem Betrachtungsumfang der energetischen Bewertung sagt die Seite in einem Satz ohne Urteil, ob beide deckungsgleich sind (DK7).",
     "beispiel": "D-0002 Anwendungsbereich Fassung 1 (Werk Ahrenberg und Werk Lindach, Strom und Gas, keine Ausschlüsse) ist deckungsgleich mit dem Betrachtungsumfang Fassung 1 ab 04.11.2026 (R2).",
     "heute": "Arten `energiepolitik`, `anwendungsbereich` in `energiemanagement_vokabular()` (MIG/V20260925013500__uems_energiemanagement.sql:176); Tabelle `energiemanagement_anwendungsbereich` (MIG/V20260925013500__uems_energiemanagement.sql:898); Vergleich `GET /api/v1/energiemanagement/dokumente/{id}/vergleich` (Operation `anwendungsbereich_vergleich`); Kundenwörter `UEMS_ENERGIEPOLITIK`, `UEMS_ANWENDUNGSBEREICH` (PORTAL/glossar.ts:683).",
     "abgrenzung": "Nicht der „Geltungsbereich“ einer Kennzahl und nicht der Betrachtungsumfang der Bewertung (SP3, AP-16 U1); nicht die Energiepolitik eines Staates."},
    {"id": "person_aufgabe", "sicht": "org", "begriff": "Person · Aufgabe im Energiemanagement · Leitung", "nachtrag": "AP-19 §4.1, §4.5 (PA1–PA5, E7)",
     "kurz": "Wer entscheidet, prüft oder teilnimmt — auch ohne Konto — und welche Aufgabe er ab wann bis wann hat, entschieden von wem.",
     "lang": "Eine Person im Energiemanagement hat Namen, Funktion und Organisation und kann mit einem Konto verknüpft sein, muss es aber nicht (E7 = A). Eine Aufgabe ist Aufgabe × Person × gilt ab/bis mit „entschieden von“; sie wird beendet, nie gelöscht. Die Leitung ist die Person mit der laufenden Aufgabe „Leitung des Unternehmens“. „Wer ist wofür verantwortlich“ nennt je Aufgabe die Person oder „keine Person festgelegt“.",
     "beispiel": "Am 22.01.2029 zehn laufende Zuordnungen, entschieden von Robert Falk; „Bezugsbasen pflegen und freigeben — keine Person festgelegt“; ab 01.03.2029 Ines Kaltenbach, Vertretung Jonas Wendlinger (R5).",
     "heute": "Tabellen `energiemanagement_person`, `energiemanagement_aufgabe` (MIG/V20260925013500__uems_energiemanagement.sql:374, :443; RLS + FORCE); Routen `/api/v1/energiemanagement/personen`, `…/aufgaben` (services/api/src/main/java/com/voltpilot/api/web/EnergiemanagementPersonenController.java:49, AP-19 IP-6/IP-10); Kundenwörter `UEMS_PERSON_IM_ENERGIEMANAGEMENT`, `UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT`, `UEMS_LEITUNG` (PORTAL/glossar.ts:685). Wegweiser: `docs/agents/root/uems-energiemanagement-personen.md`.",
     "abgrenzung": "Nicht ein Konto und keine Zugriffsrolle; nicht die „Zuständigkeit“ einer Box (SP3)."},
    {"id": "entschieden_eingetragen", "sicht": "org", "begriff": "entschieden von · eingetragen von", "nachtrag": "AP-19 §4.1, §4.3 (G2, E7, E8)",
     "kurz": "Die zwei Träger jeder Entscheidung im Energiemanagement: die Person, die entschieden hat, und das Konto, das es eingetragen hat.",
     "lang": "Die Leitung, die kein Konto will, entscheidet trotzdem: eingetragen wird ihre Entscheidung von einer Person mit Recht, sichtbar als zwei Namen. Eine Bestätigung durch die Leitung selbst ist eine benannte spätere Stufe (E8 = A). Beide Namen stehen an jeder Freigabe, jeder Aufgabe und jedem Beschluss.",
     "beispiel": "„entschieden von Robert Falk (Geschäftsführer) · eingetragen von Ines Kaltenbach“ an D-0001 Fassung 1 (R1).",
     "heute": "Spalten `entschieden_von` (Fremdschlüssel auf `energiemanagement_person`) und `freigabe_*`/`actor_*` an Fassung und Aufgabe (MIG/V20260925013500__uems_energiemanagement.sql:675, :443); Kundenwörter `UEMS_ENTSCHIEDEN_VON`, `UEMS_EINGETRAGEN_VON` (PORTAL/glossar.ts:708).",
     "abgrenzung": "Nicht ein Vier-Augen-Paar (das sind zwei Konten)."},
    {"id": "einsicht", "sicht": "org", "begriff": "Einsicht", "nachtrag": "AP-19 §4.1, §4.11 (RE3–RE5, E8)",
     "kurz": "Eine Zugriffsrolle: unternehmensweit nur ansehen, befristbar — für die Leitung und für Prüfende.",
     "lang": "„Einsicht“ ist die achte Rolle der Rechte-Matrix und das erste Unternehmensrecht ohne Schreibrecht: sie sieht unternehmensweit Nachweise, Berichte und die Bewertung, lädt PDFs und ändert nichts (jede Schreibroute 403). Der Kundenadministrator weist sie zu, wahlweise mit Enddatum; danach gilt wieder die vorige Sicht. Die Lese-Kennungen `bericht.unternehmen_abrufen` und `bewertung.ansehen` sind dafür vom Freigeben getrennt (W10) — KA und EM behalten jede Zelle.",
     "beispiel": "Claudia Berger (Leser an ST-1/ST-2) hat vom 20. bis 31.01.2029 „Einsicht“ für das interne Audit; Robert Falk ab 01.02.2029 ein Konto mit „Einsicht“ (R6).",
     "heute": "`zugriff_rolle()` Zeile 8 und CHECK-Tausch `bericht_abruf_actor_rolle_chk` (MIG/V20260925030000__uems_rolle_einsicht.sql:38, :52, AP-19 IP-12); Spalte `einsicht` in `docs/contracts/v2/rechte-matrix.json`; Kundenwort `UEMS_EINSICHT` (PORTAL/glossar.ts:693). Wegweiser: `docs/agents/root/uems-benutzerverwaltung.md`.",
     "abgrenzung": "Nicht ein Unterstützer (VoltPilot) und nicht ein Leser am Standort; kein Bestätigen und kein Festhalten (E8 = A)."},
    {"id": "internes_audit", "sicht": "org", "begriff": "internes Audit · Hinweis", "nachtrag": "AP-19 §4.1, §4.6 (IA1–IA5, E5)",
     "kurz": "Ein internes Audit AU-JJJJ-nnnn mit Auditorin, Unabhängigkeit als Wortlaut, Umfang und Ergebnissen; ein Hinweis ist ein Ergebnis ohne Nichterfüllung.",
     "lang": "Ein internes Audit wird geplant, durchgeführt und abgeschlossen (mit Kopie und Prüfsumme) oder abgesagt. Ergebnisse sind Hinweise (Nr. n, daraus kann eine Maßnahme werden) und Feststellungen. Das nächste Audit leitet der Abruf aus dem letzten Durchführungstag und dem Rhythmus ab (Auditprogramm).",
     "beispiel": "AU-2029-0001 am 22.01.2029, Auditorin Claudia Berger (Controlling, nicht im Energieteam): ein Hinweis → M-2029-0002, eine Feststellung F-2029-0001; abgeschlossen am 31.01.2029 mit dem Bericht als Verweis; nächstes Audit fällig am 22.01.2030 (R9).",
     "heute": "Tabellen `internes_audit`, `internes_audit_eintrag` (MIG/V20260925031500__uems_audit_feststellung.sql:254, :445; RLS + FORCE); Routen `/api/v1/energiemanagement/audits` (services/api/src/main/java/com/voltpilot/api/web/InternesAuditController.java:46, AP-19 IP-18); Kundenwörter `UEMS_INTERNES_AUDIT`, `UEMS_HINWEIS` (PORTAL/glossar.ts:694). Wegweiser: `docs/agents/root/uems-audit-routen.md`.",
     "abgrenzung": "Nicht das Zertifizierungsaudit und nicht das Pilot-Audit von AP-20; nicht ein technisches Audit-Protokoll."},
    {"id": "feststellung", "sicht": "org", "begriff": "Feststellung · Wirksamkeit", "nachtrag": "AP-19 §4.1, §4.7 (FS1–FS7, E4)",
     "kurz": "Eine festgestellte Nichterfüllung einer Vorgabe des Energiemanagements (F-JJJJ-nnnn); ihre Wirksamkeit sagt eine Person als Stand Nr. n.",
     "lang": "Eine Feststellung hat Wortlaut, festgestellt von, Verantwortlichen und Frist, Einträge (sofortige Behebung, Ursache als Aussage einer Person, ähnliche Fälle — je mit Person und Tag) und ihre Maßnahmen: AP-18-Maßnahmen mit der Herkunft `nichtkonformitaet` (Kundenwort „Feststellung F-…“, SP5). Die Wirksamkeit ist kein Rechenergebnis: eine Person hält „wirksam“ oder „nicht wirksam“ mit Begründung, Kopie und Prüfsumme fest (E4 = A); danach ist die Feststellung abgeschlossen.",
     "beispiel": "F-2029-0001 „Wer die Bezugsbasen pflegt und freigibt …, ist nicht festgelegt“ — Maßnahme M-2029-0001; am 15.04.2029 hält Ines Kaltenbach Stand Nr. 1 „wirksam“ fest (R10, R11).",
     "heute": "Tabellen `feststellung`, `feststellung_eintrag`, `feststellung_wirksamkeit` (MIG/V20260925031500__uems_audit_feststellung.sql:519, :667, :724; RLS + FORCE); Routen `/api/v1/energiemanagement/feststellungen` (services/api/src/main/java/com/voltpilot/api/web/FeststellungController.java:48, AP-19 IP-19); Herkunft der Maßnahme per CHECK-Tausch (MIG/V20260925040000__uems_massnahme_herkunft_weiten.sql:140, IP-17); Kundenwörter `UEMS_FESTSTELLUNG`, `UEMS_SOFORTIGE_BEHEBUNG`, `UEMS_WIRKSAMKEIT` (PORTAL/glossar.ts:697). Wegweiser: `docs/agents/root/uems-feststellung-routen.md`.",
     "abgrenzung": "Nicht eine Abweichung der Energieleistung (AP-18) und nicht ein Befund (AP-16); nie „Nichtkonformität“ oder „Korrekturmaßnahme“ auf einer Fläche (SP2); die Wirksamkeit ist nicht die Wirkung einer Maßnahme (AP-18)."},
    {"id": "managementbewertung", "sicht": "org", "begriff": "Managementbewertung", "nachtrag": "AP-19 §4.1, §4.8 (MG1–MG7, E6)",
     "kurz": "Ein Bericht der VoltPilot-Vorlage Nr. 7 „Managementbewertung“ (Unternehmen × Jahr) mit Eingaben, Sitzung, Beschlüssen der Leitung und Stand.",
     "lang": "Die Managementbewertung liest ihre Eingaben aus den Vorgängern — Energieziele, Maßnahmen und ihre Bewertungen, Abweichungen, Leistungsvergleich, Bewertung, Bezugsbasen, Audits und Feststellungen — als Stände und Zustände, nie als neue Rechnung. Der Stand ist eine Kopie seines Tages mit Prüfsumme (MG3); spätere Änderungen erreichen ihn nicht.",
     "beispiel": "BR-2029-0001 für 2028 am 12.02.2029: Energieziel EZ-2028-0001 verfehlt, M-2028-0001 belegt, M-2028-0002 nicht messbar, ein Audit mit offener Feststellung; Stand Nr. 1 mit Prüfsumme (R13).",
     "heute": "Vorlage `managementbewertung` Nr. 7 (services/api/src/main/resources/berichte/bericht-vorlagen.json:327, `bericht_vokabular()`/`bericht_vorlage()` als Vereinigung in MIG/V20260925061500__uems_managementbewertung_vorlage.sql:11), Abschnitt-Leser services/api/src/main/java/com/voltpilot/api/uems/BerichtManagementbewertung.java (AP-19 IP-22); Kundenwort `UEMS_MANAGEMENTBEWERTUNG` (PORTAL/glossar.ts:703).",
     "abgrenzung": "Nicht die energetische Bewertung (AP-16) und nie „Bewertung“ allein (SP3); nicht ein Protokoll-Upload."},
    {"id": "beschluss_folge", "sicht": "org", "begriff": "Sitzung · Beschluss · Folge", "nachtrag": "AP-19 §4.1, §4.8 (MG4–MG7, E6)",
     "kurz": "Die Sitzung der Managementbewertung mit der Leitung, ihre Beschlüsse Nr. n und je Beschluss die Verknüpfung mit dem Objekt, das daraus wurde.",
     "lang": "Eine Managementbewertung wird nur mit Sitzung (Tag, Leitung, Teilnehmende), Leitung und mindestens einem Beschluss freigegeben. Ein Beschluss hat Art, Wortlaut und „entschieden von“ (die Leitung), wahlfrei zuständig und Termin; mit der Freigabe steht er im Stand. Eine Folge verknüpft von Hand einen Beschluss mit dem, was daraus wurde — Energieziel, Dokument-Fassung, Aufgabe, internes Audit; Maßnahmen verknüpfen sich über ihre Herkunft `managementbewertung`. Eine Folge ändert den Stand nicht (ein Stand seines Tages).",
     "beispiel": "BR-2029-0001: Sitzung am 12.02.2029 mit Robert Falk als Leitung, sechs Beschlüsse — B1 → EZ-2029-0001, B2 → M-2029-0003, B3 → Energiepolitik Fassung 2, B4 → Aufgabe Bezugsbasen, B5 ohne Folge in VoltPilot, B6 „geprüft, bleibt“ (R13, R14).",
     "heute": "Tabellen `managementbewertung_sitzung`, `managementbewertung_beschluss`, `managementbewertung_folge` (MIG/V20260925093000__uems_managementbewertung_beschluesse.sql:30, :57, :89; RLS + FORCE); Routen `/api/v1/energiemanagement/managementbewertungen/{kennung}` (services/api/src/main/java/com/voltpilot/api/web/ManagementbewertungController.java:43, AP-19 IP-23); Kundenwörter `UEMS_SITZUNG`, `UEMS_BESCHLUSS`, `UEMS_FOLGE` (PORTAL/glossar.ts:704). Wegweiser: `docs/agents/root/uems-managementbewertung-beschluesse.md`.",
     "abgrenzung": "Nicht eine Aufgabe des Systems und nicht selbst eine Maßnahme; kein Protokoll-Upload."},
    {"id": "taetigkeit", "sicht": "betrieb", "begriff": "Tätigkeit des Speichers", "nachtrag": "Fahrplan „Tagesuhr und Bildfahrplan“ E8 (24.09.2026)",
     "kurz": "Was der Speicher in einer Phase des Fahrplans tun soll — in fünf Wörtern: Sonne speichern · Günstig aus dem Netz laden · Verbrauch decken · Warten · Einspeisung pausieren.",
     "lang": "Die Tätigkeit ist eine Aussage des PLANS über eine Phase, nie eine Messung: was der Speicher wirklich getan hat, sagen Geräteantwort und Messwerte. Dieselben Wörter stehen auf der Tagesuhr, im Bildfahrplan, in den Stationen, in den Antworten, im Erklär-Panel und in der Hilfe; eine Phase trägt nie zwei Namen. Seltene Tätigkeiten behalten ihren Namen aus dem Erklär-Panel (Verkaufen bzw. Einspeisen, Lastspitze kappen, Reserve halten). „Warten“ meint eine Phase ohne Laden und Abgeben — nicht den Ruhe-Zustand einer Anlage (AP-01 E7/E8).",
     "beispiel": "AN-1 am 24.09.2026: 00:00 Warten · 05:45 Verbrauch decken · 13:30 Günstig aus dem Netz laden · 14:30 Sonne speichern · 17:30 Verbrauch decken.",
     "heute": "Die Wörter stehen als Konstanten `FAHRPLAN_TAETIGKEIT` in PORTAL/glossar.ts:187; die Zuordnung Rolle → Wort macht `filmLabel` (PORTAL/fahrplanFilm.ts:120), für die übrigen Rollen `roleLabel` (PORTAL/fahrplanWhy.ts:718). Die Rolle je Viertelstunde (`slot_role`) schreibt der Optimierer; das Tagesbild legt die Phasen auf die Uhrzeit (PORTAL/fahrplanTag.ts:165).",
     "abgrenzung": "Nicht das Betriebsmodell (die Betriebsweise der Anlage), nicht die Regel (eine Ausnahme obendrauf), nicht der Zustand „steuert“ (eine Beobachtung)."},
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
    'energiebilanz': [
        ('AP-13 E15',
         'Auf den Messdaten- und Analyseoberflächen heißt der Rest eines Systems an der Anlage „nicht zugeordnet“, in der '
         'Gebäude-Sicht „nicht verortet“ und bei den Kostenstellen „nicht verteilt“ — drei Wörter für drei Sichten, nie '
         'vertauscht. „Bilanz“ steht nie ohne Präfix, „Energiefluss“ bleibt das Bestandsbild der Bühne. Die Wörter: '
         '`frontend/portal/src/glossar.ts` (`UEMS_ENERGIEBILANZ`, `UEMS_NICHT_VERORTET`).'),
    ],
    'netzanschluss': [
        ('AP-10 E8 (W9)',
         'Der Netzanschluss wird ein eigenes OBJEKT am Standort — Kennzeichen (`NA-`, Form wie beim '
         'Messstellen-Kennzeichen), Name, Marktlokation (elf Ziffern, nie aufgefüllt), Netzbetreiber, '
         'Anschlussleistung in kVA, vereinbarte Leistung in kW und Messung RLM · SLP — und eine Anlage '
         'verweist ZEITGÜLTIG auf ihn (Tage; je Tag höchstens einer je Anlage und eine Anlage je '
         'Anschluss). Preis-, Vergütungs- und Grenzspalten ziehen dabei NICHT mit: sie bleiben an der '
         'Anlage (`site_supply_price`, `tarif_art`, `max_feed_in_kw` …), bis das Folgepaket '
         '„Netzanschluss-Preisblatt“ sie zeitgültig übernimmt. Die vereinbarte Leistung wird gezeigt, '
         'nicht geprüft — die Grenzprüfung ist AP-15. Regeln: `docs/contracts/v2/netzanschluss.md`.'),
    ],
    'elsystem': [
        ('AP-10 E9',
         'Das elektrische System ist die BILANZGRENZE und im Code die Anlage: je System genau ein '
         'Netzanschluss und je Richtung höchstens ein Hauptzähler. Standort und Unternehmen bilanzieren '
         'als Summe über ihre Systeme mit „x von y“ und haben keinen eigenen Rest; ein Gebäude ist eine '
         'SICHT (Ort × Stellung), keine Bilanzgrenze. Regeln: `docs/contracts/v2/bilanz.md` §4.8.'),
    ],
    'kostenstelle': [
        ('AP-10 E11/E12',
         'Die „festen Prozentanteile“ aus AP-00 werden eine eigene zeitgültige Beziehung Messstelle → '
         'Kostenstelle (Tage): an jedem Tag mit Zeilen genau 100 %, sonst „nicht verteilt“. Sie wirkt je '
         'Tag auf die Tagesmenge (kein Stichtag), endet mit der Kostenstelle und kennt keine dynamischen '
         'Schlüssel. Regeln: `docs/contracts/v2/verteilung.md`.'),
    ],
    'bezugsgroesse': [
        ('AP-09 E1/E2/E4/E17',
         'Der Geltungsbereich ist genau EINES von sieben Fachobjekten — Unternehmen · Standort · '
         'Gebäude · Bereich · Prozess · Kostenstelle · Messstelle (AP-00 nannte vier; aufgelöst in '
         'AP-09 W7) —, und die Wertart ist genau EINE von drei: Periodenwert (Menge je Tag, Woche, '
         'Monat oder Jahr), Stand (Ablesung zu einem Zeitpunkt) oder Stammdatum mit Gültigkeit. Die '
         'Einheit kommt aus einem geschlossenen Vokabular JE GRÖSSE (Masse kg · t, Stückzahl Stück, '
         'Zeit h · min, Fläche m², Volumen m³ · l, Personen, Schichten, Gradtage Kd); umgerechnet '
         'wird nur innerhalb derselben Größe mit festem Faktor, alles andere wird abgelehnt statt '
         'geraten. Die Betriebszeit ist eine Periodenreihe, kein Wochenmodell (E2). Die Bezugsfläche '
         'wird NICHT in AP-09 erfasst, sondern am Gebäude gelesen — zum Stichtag der Periode, ihrem '
         'letzten Tag (E17): ein neuer Wert ab Tag X ändert keine Periode vor X. Die Regeln stehen '
         'als Vertrag in `docs/contracts/v2/bezugsdaten.md` samt Vektoren '
         '(`bezugsdaten-vectors.json`).'),
        ('AP-17 W9',
         'Heute im Code (Stand 23.09.2026, gebaut mit AP-09): Tabellen `bezugsgroesse` mit genau einem '
         'Geltungsbereich, `bezugsgroesse_wert` (Werte als Fassungen, nur anhängend), '
         '`bezugsgroesse_kennzeichen_verlauf` und `bezugsgroesse_aenderung` '
         '(MIG/V20260913104500__uems_bezugsgroesse.sql:162, :291); Art als eigenes Datum '
         '(MIG/V20260918110000__uems_bezugsgroesse_art.sql); Kanalbindung an Zähler-, Zustands- und '
         'Temperaturkanäle mit Gradtagen G20/15 (`bezugsgroesse_kanalbindung`, '
         'MIG/V20260917100000__uems_bezugsgroesse_kanalbindung.sql:2; '
         'services/api/src/main/java/com/voltpilot/api/uems/GradtagRegeln.java:14). Routen `/api/v1/bezugsgroessen` '
         '(services/api/src/main/java/com/voltpilot/api/web/BezugsgroesseController.java:64) und '
         '`/api/v1/bezugsdaten/importe`; Regeln `uems/BezugsdatenRegeln` ⟷ `bezugsdaten.ts` gegen '
         '`docs/contracts/v2/bezugsdaten-vectors.json`; Portal „Unternehmen › Bezugsgrößen“ (PORTAL/nav.ts:250). '
         'Die Herkunft `bezogen` einer Gradtagzahl (von VoltPilot aus einem Wetter-Archiv, AP-17 E9 = C) ist '
         'seit AP-17 IP-12 gebaut (siehe „Wetterbezug“). Einstieg: '
         '`docs/agents/root/uems-bezugsgroessen-abschluss.md`.'),
        ('AP-17 W2 (E10 = A)',
         'Erledigt: AP-09 §6.5 wies Betriebskalender, Arbeitszeitmodell und Wetterbereinigung AP-17 zu. '
         'Es gibt keinen Kalender und kein Arbeitszeitmodell als Stammdatum — die Betriebszeit ist eine '
         'Bezugsgröße mit Periodenwerten und als Einflussgröße eine Variable wie jede; ein Schichtmodell ist '
         'höchstens ein Wortlaut-Faktor an der Fassung. Die Wetterbereinigung ist mit Gradtagen eingelöst, die '
         'Temperatur dafür bezieht VoltPilot aus dem Wetter-Archiv (E9 = C). AP-09 E2 („die Zahl wäre geplant, '
         'nicht gemessen“) bleibt. Einstieg: `docs/agents/root/uems-bezugsbasis.md`.'),
    ],
    "unternehmen": [
        ("AP-02 E2", "Neben dem Kundenbereich entsteht ein eigenes Objekt „Unternehmen“ (Name, Kurzname, Zeitzone-Vorgabe, Sitz, Rechtsform); 1 : n für Konzerne bleibt vorbereitet."),
        ("AP-03 E10", "Die Unternehmensebene erscheint erst ab zwei zugänglichen Standorten und dann als Teilansicht („Teilansicht: n von m Standorten“); unternehmensweite Kennzahlen, Berichte und Exporte bleiben unsichtbar, solange nicht alle Standorte zugänglich sind."),
    ],
    "standort": [
        ("AP-01 E6 = C", "Die Funktionen „Messen & Auswerten“ und „Steuern & Optimieren“ gelten JE STANDORT; jede Anlage des Standorts nimmt EINZELN teil. Freigabe, Grenze, Betriebsweise, Ruhe und Start bleiben an der Anlage, der Standort trägt den Lebenszyklus der Funktion (AP-01 W7)."),
        ("AP-02 E9", "„gültig ab“ ist ein TAG, wirksam 00:00 Uhr in der Zeitzone des Standorts — die Zeitzone ist damit ein Pflicht-Stammdatum des Standorts."),
        ("AP-02 W4 (IP-8)", "Stehen das Objekt und das Koordinaten-Feld auf EINER Karte (Anlage › Einstellungen › „Meine Anlage“), heißt die Objekt-Zeile „Standort“ (Name, Kurzzeichen, Adresse, seit) und die Koordinaten-Zeile in der Anzeige „Standort auf der Karte“ — das Label, das sie beim Bearbeiten schon trägt. Ohne Standort-Objekt bleibt die Karte, wie sie ist; E9 = B bleibt."),
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
        ('AP-16 E10 (IP-17/IP-18)', 'Eine Vergleichsquelle trägt eine **Toleranz** als Fassung (Startwert 2 % je Monat, änderbar mit Begründung ab dem laufenden Monat). Liegt die Monatsabweichung darüber, steht unter der Quelle-Karte ein Befund „Abweichung x % (Toleranz y %) — bitte prüfen“ — ohne Ursache; die Werte stehen weiter nebeneinander, keiner ersetzt den anderen. Messmittel-Angaben ohne Erhebung heißen „nicht erhoben“; ein wesentlicher Einsatz mit solchen Messmitteln wird zur **Prüfaufgabe**.'),
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
# ABSCHNITTE_NACH — freie Abschnitte, die hinter einem Begriff (nach seinen Verfeinerungen)
# wörtlich ins Glossar kommen: Summenwert (PR 855), Ersatzwert/Korrektur/Widerruf (PR 909).
# ---------------------------------------------------------------------------------------------
ABSCHNITTE_NACH = {
    "messstelle": ["""## Summenwert

Das Kundenwort für eine berechnete Messstelle vom Typ **gewichtete Summe**:
aus Registern und anderen berechneten Messstellen derselben Anlage, mit
Vorzeichen und Faktor. Kein eigenes drittes Objekt. Die Messstellen-Welt
nennt sie weiterhin „berechnet (Summe)“ mit Kennzeichen; „Gesamt-PV“ bleibt
Cockpit-Wort. „Gesamtwert“, „PV gesamt“ und „Helfer“ sind keine neuen
Produkttexte (freie Kundennamen bleiben erhalten). Konstante `SUMMENWERT`
in `frontend/portal/src/glossar.ts`; Umstellung der Bestandsflächen H-5/H-7.

Die Rolle ist eine gesonderte Zuordnung am Gerät: PV-Produktion, Verbrauch,
Netz oder keine Rolle (Vorgabe). Sie wirkt ab jetzt auf die Anlagen-Anzeige,
mit Änderungsprotokoll. Ein Wert zählt je Anlage und Rolle einmal, Netz hat
höchstens einen maßgeblichen Wert. Vertrag und Zwillinge:
[`rollen-zuordnung.md`](../contracts/v2/rollen-zuordnung.md)."""],
    "grund": ["""### Ersatzwert, Korrektur und Widerruf

Ein **Ersatzwert** füllt oder verteilt fehlende Messwerte mit einer benannten Methode
und einer Begründung. Bei gemessenem Zuwachs wird dessen Menge verteilt; ohne
Zuwachs kann eine belegte Menge, eine Vorperiode oder eine Vergleichsquelle helfen.
Ein nachgetragener Ablesestand bleibt als solcher erkennbar.

Eine **Korrektur** bewahrt den bisherigen Wert und erzeugt nach der Freigabe eine neue
Version. Ein Vorschlag verändert noch keinen Wert. Bei eingeschalteter Prüfung durch
eine zweite Person kann der Ersteller nicht selbst freigeben.

Ein **Widerruf** nimmt einen freigegebenen Vorgang begründet zurück. Auch dabei entsteht
eine weitere Version; die bisherigen Werte und Begründungen bleiben erhalten.
Wege und Umsetzung: [Korrektur-Prüfseite und Ersatzwerte](../agents/root/uems-korrektur-portal-routen.md)."""],
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
    ('12.09.2026', 'AP-09 E1/E2', 'Option A — Geltungsbereich einer Bezugsgröße = genau eines von SIEBEN Fachobjekten (AP-00 nannte vier, AP-09 W7); Betriebszeit als Periodenreihe'),
    ('12.09.2026', 'AP-09 E3', 'Option A — Bezugsdaten bekommen einen EIGENEN Herkunftsvertrag; der Messwert-Herkunftsvertrag (AP-07) wird dafür nicht erweitert'),
    ('12.09.2026', 'AP-09 E17', 'Option A — die Bezugsfläche wird nur aus der Ortsstruktur GELESEN, zum Stichtag der Periode (letzter Tag); es gibt keine zweite Flächen-Eingabe'),
    ('12.09.2026', 'AP-10 E1', 'Option A — zwei neue Formel-Typen `rest` und `saldo`; die Ergebnis-Richtung ist JE TYP eine Regel (Bezug − Bezug bleibt Bezug), nicht eine Ableitung aus Vorzeichen'),
    ('12.09.2026', 'AP-10 E8 (W9)', 'Option A — der Netzanschluss bekommt sein Objekt am Standort und die zeitgültige Bindung; die Preis- und Grenzspalten der Anlage ziehen erst mit dem Folgepaket „Netzanschluss-Preisblatt“ um'),
    ('12.09.2026', 'AP-10 E11/E13', 'Option A — eine feste Verteilung ist eine eigene zeitgültige Beziehung mit Anteil; die Herkunft eines berechneten oder verteilten Werts bekommt einen EIGENEN additiven Vertrag (der Messwert-Herkunftsvertrag bleibt unberührt)'),
]
