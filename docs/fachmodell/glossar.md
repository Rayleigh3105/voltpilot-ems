<!-- ERZEUGT von docs/fachmodell/tools/build_fachmodell.py aus fachmodell.py — nicht von Hand ändern. -->

# Glossar des Unternehmens-Energiemanagements

Alle 23 Begriffs-Einträge aus AP-00 §4.1, dazu 24 NACHTRÄGE späterer Pakete (am Begriff als „Nachtrag <Paket>“ ausgewiesen — dasselbe Muster wie die `nachtrag`-Zeilen der Rechte-Matrix). Ein Nachtrag ergänzt einen FEHLENDEN Begriff; ein bestehender AP-00-Text wird nie umgeschrieben. **Definition · Erläuterung · Beispiel** sind die Kundensprache; **Heute im Code** ist die einzige Spalte, in der interne Namen (`tenant`, `site`, `measurement_point` …) vorkommen dürfen. **Abgrenzung** sagt, was der Begriff NICHT ist.

Belege sind `datei:zeile` am Stand `origin/main` 36f3e7e8 (10.09.2026); `MIG` = `services/api/src/main/resources/db/migration`, `PORTAL` = `frontend/portal/src`, `DATA` = die Konzept-Ablage des Programms (nicht in diesem Repo). `tools/check_belege.sh` prüft die Pfade.

Ein Kasten **Verfeinert durch** nennt, was ein späteres Konzeptpaket geschärft, ergänzt oder mit ⚠ ERSETZT hat — mit Paket und Entscheid. Der Text darüber ist der AP-00-Stand vom 10.09.2026 und bleibt unverändert stehen.

## Inhalt

- [Kundenbereich](#kundenbereich) — Sicht Ort
- [Unternehmen](#unternehmen) — Sicht Ort
- [Standort](#standort) — Sicht Ort
- [Gebäude](#gebäude) — Sicht Ort
- [Bereich](#bereich) — Sicht Ort
- [Anlage](#anlage) — Sicht Elektrisch
- [Elektrisches System](#elektrisches-system) — Sicht Elektrisch
- [Netzanschluss](#netzanschluss) — Sicht Elektrisch
- [Box (Edge)](#box-edge) — Sicht Erfassung
- [Datenquelle](#datenquelle) — Sicht Erfassung
- [Gerät (physisches Messgerät, Controller, Energiekarte)](#gerät-physisches-messgerät-controller-energiekarte) — Sicht Erfassung
- [Komponente](#komponente) — Sicht Erfassung
- [Messkanal](#messkanal) — Sicht Erfassung
- [Logische Messstelle](#logische-messstelle) — Sicht Zustand
- [Messgröße, Medium, Einheit, Richtung, Wertart](#messgröße-medium-einheit-richtung-wertart) — Sicht Zustand
- [Prozess](#prozess) — Sicht Organisation
- [Kostenstelle](#kostenstelle) — Sicht Organisation
- [Betriebsmodell (übernommen)](#betriebsmodell-übernommen) — Sicht Betrieb
- [Regel und Steuerart (übernommen)](#regel-und-steuerart-übernommen) — Sicht Betrieb
- [Bezugsgröße (nur Begriff, Ausbau AP-09)](#bezugsgröße-nur-begriff-ausbau-ap-09) — Sicht Organisation
- [Benutzer und Rolle (nur Begriff, Rechte-Matrix AP-03)](#benutzer-und-rolle-nur-begriff-rechte-matrix-ap-03) — Sicht Ort
- [Zuordnung (zeitgültig)](#zuordnung-zeitgültig) — Sicht Zustand
- [Zustände: aktiv · eingerichtet · liefert Daten · steuert](#zustände-aktiv--eingerichtet--liefert-daten--steuert) — Sicht Zustand
- [Ablesung](#ablesung) — Sicht Erfassung · Nachtrag AP-09 §6.2 (W7)
- [Ablesezeitraum](#ablesezeitraum) — Sicht Erfassung · Nachtrag AP-09 §6.2 (W7)
- [Fassung](#fassung) — Sicht Erfassung · Nachtrag AP-09 §6.2 (W7)
- [Herkunft](#herkunft) — Sicht Erfassung · Nachtrag AP-09 §6.2 (W7)
- [Import](#import) — Sicht Erfassung · Nachtrag AP-09 §6.2 (W7)
- [Zuordnungs-Vorlage](#zuordnungs-vorlage) — Sicht Erfassung · Nachtrag AP-09 §6.2 (W7)
- [Befund](#befund) — Sicht Erfassung · Nachtrag AP-09 §6.2 (W7)
- [Energiebilanz](#energiebilanz) — Sicht Elektrisch · Nachtrag AP-10 §4.1 (E9)
- [Bilanzdifferenz](#bilanzdifferenz) — Sicht Elektrisch · Nachtrag AP-10 §4.3 (E1, E3)
- [Feste Verteilung](#feste-verteilung) — Sicht Organisation · Nachtrag AP-10 §4.6 (E11, E12)
- [Berechnete Messstelle](#berechnete-messstelle) — Sicht Zustand · Nachtrag AP-10 §4.1 (E1, E5)
- [Kennzahl](#kennzahl) — Sicht Organisation · Nachtrag AP-11 §4.1 (E1, E2, E5)
- [Kennzahlvorlage](#kennzahlvorlage) — Sicht Organisation · Nachtrag AP-11 §4.12 (E9)
- [Bericht](#bericht) — Sicht Organisation · Nachtrag AP-12 §4.1 (E1, E8, E9)
- [Berichtsvorlage](#berichtsvorlage) — Sicht Organisation · Nachtrag AP-12 §4.5 (E9)
- [Berichtsstand](#berichtsstand) — Sicht Organisation · Nachtrag AP-12 §4.3 (E1, E2, E5)
- [Revision](#revision) — Sicht Organisation · Nachtrag AP-12 §4.9 (E6, E7)
- [Datenstand](#datenstand) — Sicht Organisation · Nachtrag AP-12 §4.6 (E4)
- [Quellenverzeichnis](#quellenverzeichnis) — Sicht Organisation · Nachtrag AP-12 §4.4 (E3, E6)
- [Werte](#werte) — Sicht Zustand · Nachtrag AP-13 §4.1 (E9, E15)
- [Verlauf](#verlauf) — Sicht Zustand · Nachtrag AP-13 §4.1 (E5, E15)
- [Vergleich](#vergleich) — Sicht Zustand · Nachtrag AP-13 §4.1 (E6, E15)
- [Datenlage](#datenlage) — Sicht Zustand · Nachtrag AP-13 §4.1 (E13, E15)
- [Grund (einer fehlenden Zahl)](#grund-einer-fehlenden-zahl) — Sicht Zustand · Nachtrag AP-13 §4.10 (E11)

## Kundenbereich

*Sicht: Ort*

**Der abgeschlossene Datenraum eines Vertragspartners: alles, was seine Benutzer sehen und bedienen dürfen.**

Der Kundenbereich ist die Grenze für Daten, Benutzer und Rechte. Nichts darin ist von außen sichtbar; die Plattform-Administration von VoltPilot kann hineinschauen, aber niemals ein Kunde in einen fremden Bereich (fremde Objekte sind „nicht gefunden“, nie „verboten“).

**Beispiel (Referenzunternehmen Ahrenberg).** Kundenbereich KB-AHRENBERG — angelegt 12.03.2024 mit der Bestandsanlage, seit 01.10.2026 mit Unternehmensstruktur.

**Heute im Code.** Tabelle `tenant` (MIG/V1__core_schema.sql:36-44: id, name, segment CI|B2C, plan; `betriebsart` endkunde|betreiber MIG/V20260720000000__tenant_betriebsart.sql:20); Trennung per Keycloak-Benutzerattribut `tenant_id` in EINEM Realm `voltpilot` (infra/local/keycloak/voltpilot-realm.json:2,187) und Postgres-RLS (MIG/V2__row_level_security.sql:31-36). Kundenwort heute: keines — „Mandant“ ist intern (frontend/portal/AGENTS.md:48) und heißt nur hinter dem Admin-Tor so (PORTAL/nav.ts:280-286).

**Abgrenzung.** Nicht das Unternehmen (das ist der fachliche Inhalt des Bereichs), nicht der Standort (ein Ort im Unternehmen).

## Unternehmen

*Sicht: Ort*

**Die Organisation des Kunden mit Namen, Rechtsform und Sitz — die Wurzel des Ortsbaums und des Prozessbaums.**

Das Unternehmen ist das, worüber der Kunde berichtet („Unternehmensweiter Bericht“, „unternehmensweite Kennzahl“). Im ersten Umfang gibt es genau EIN Unternehmen je Kundenbereich; es entsteht automatisch aus dem Kundenbereich und trägt dessen Namen (E2). Ein Konzern mit mehreren Gesellschaften ist vorbereitet, nicht ausgebaut.

**Beispiel (Referenzunternehmen Ahrenberg).** Kunststoffwerk Ahrenberg GmbH, Sitz Ahrenberg, 180 Mitarbeitende, Zeitzone Europe/Berlin, Geschäftsjahr = Kalenderjahr.

**Heute im Code.** Heute nicht vorhanden. Suche `grep -rni 'company|organisation|organization' MIG` → nur Prosa (MIG/V20260838000000__site_profil.sql:29-30). Der Name lebt als `tenant.name` (MIG/V1__core_schema.sql:38); eine Registrierung legt Mandant + Keycloak-Login an (docs/agents/root/portal-api-auth-tenancy-rls-services-api.md:35).

**Abgrenzung.** Kundenbereich = technischer Zaun; Unternehmen = fachliche Wurzel. Bei 1:1 sieht der Kunde nur das Unternehmen.

> **Verfeinert durch AP-02 E2:** Neben dem Kundenbereich entsteht ein eigenes Objekt „Unternehmen“ (Name, Kurzname, Zeitzone-Vorgabe, Sitz, Rechtsform); 1 : n für Konzerne bleibt vorbereitet.

> **Verfeinert durch AP-03 E10:** Die Unternehmensebene erscheint erst ab zwei zugänglichen Standorten und dann als Teilansicht („Teilansicht: n von m Standorten“); unternehmensweite Kennzahlen, Berichte und Exporte bleiben unsichtbar, solange nicht alle Standorte zugänglich sind.

## Standort

*Sicht: Ort*

**Ein räumlich abgegrenzter Ort des Unternehmens mit Adresse, an dem Gebäude, Boxen und Netzanschlüsse liegen.**

Der Standort ist die Rechte-Einheit (AP-03: „Zugriff auf ausgewählte Standorte“) und die Berichts-Einheit unter dem Unternehmen (AP-12). Er trägt Adresse, Zeitzone, Nutzung und Bezugsfläche (AP-02). Ein Standort kann mehrere Netzanschlüsse, mehrere Anlagen und mehrere Boxen haben; er versorgt selbst nichts — die Versorgung ist Sache der Anlage.

**Beispiel (Referenzunternehmen Ahrenberg).** ST-1 Werk Ahrenberg (Gewerbering 7; 3 Gebäude, 2 Netzanschlüsse, 2 Anlagen, 2 Boxen) und ST-2 Werk Lindach (2 Gebäude, 1 Anschluss, 1 Anlage, 1 Box).

**Heute im Code.** Heute nicht vorhanden als Objekt. Das Wort „Standort“ ist im Portal das Koordinaten-Feld der Anlage (PORTAL/pages/AnlageTechnik.tsx:508, :1207); Koordinaten `site.latitude/longitude` (MIG/V20260701010000__site_geo_and_data_feeds.sql:29-30). Keine Adress- und keine Zeitzonen-Spalte (`grep -rni 'address|adresse|plz|timezone' MIG` → nur Kommentare, MIG/V20260719020000__telemetry_v2_rollup_cascade.sql:14 „timezone is future work“).

**Abgrenzung.** Nicht die Anlage (die ist elektrisch, nicht räumlich); nicht das Gebäude (ein Teil des Standorts). Zwei Standorte sind nie ein elektrisches System. Das Feld „Standort“ in den Anlagen-Einstellungen (Koordinaten) behält seinen Namen (E9: B) — dort ist die Lage der Anlage gemeint, hier das Objekt.

> **Verfeinert durch AP-01 E6 = C:** Die Funktionen „Messen & Auswerten“ und „Steuern & Optimieren“ gelten JE STANDORT; jede Anlage des Standorts nimmt EINZELN teil. Freigabe, Grenze, Betriebsweise, Ruhe und Start bleiben an der Anlage, der Standort trägt den Lebenszyklus der Funktion (AP-01 W7).

> **Verfeinert durch AP-02 E9:** „gültig ab“ ist ein TAG, wirksam 00:00 Uhr in der Zeitzone des Standorts — die Zeitzone ist damit ein Pflicht-Stammdatum des Standorts.

> **Verfeinert durch AP-02 W4 (IP-8):** Stehen das Objekt und das Koordinaten-Feld auf EINER Karte (Anlage › Einstellungen › „Meine Anlage“), heißt die Objekt-Zeile „Standort“ (Name, Kurzzeichen, Adresse, seit) und die Koordinaten-Zeile in der Anzeige „Standort auf der Karte“ — das Label, das sie beim Bearbeiten schon trägt. Ohne Standort-Objekt bleibt die Karte, wie sie ist; E9 = B bleibt.

> **Verfeinert durch AP-02 E1/E12:** Archivieren ist der Normalweg, Löschen nur für Objekte OHNE jede Historie. Archiviert wird nur ohne aktive Messstellen und Anlagen; leere Kinder werden mitarchiviert.

> **Verfeinert durch AP-02 E8/E10:** Kurzzeichen (ST-1, G-1, B-1) werden automatisch vergeben, sind änderbar, je Kundenbereich eindeutig und werden nie wiederverwendet. Ein automatisch angelegter Standort bleibt Entwurf, bis die Adresse steht — sichtbar nur auf Standort-Flächen, er blockiert nichts.

> **Verfeinert durch AP-03 E3/E5:** Der Standort ist die Einheit des Bedienrechts (alle Anlagen des Standorts) und wird ausdrücklich zugewiesen — eine Schnellwahl füllt die Liste, neue Standorte müssen einzeln zugewiesen werden.

## Gebäude

*Sicht: Ort*

**Ein Bauwerk am Standort mit Nutzung, Fläche und Baujahr — die optionale zweite Ebene des Ortsbaums.**

Das Gebäude ist optional (Plan AP-02: „Optionale Gebäudeebene für Außenanlagen oder kleine Standorte“). Eine Messstelle darf direkt am Standort hängen; es wird kein Gebäude erfunden (E3). Gebäude sind Zuordnungsziele für Messstellen und Bezugsflächen, nie Versorgungsgrenzen: ein elektrisches System kann mehrere Gebäude versorgen, ein Gebäude kann aus zwei Systemen versorgt werden.

**Beispiel (Referenzunternehmen Ahrenberg).** G-1 Halle 1 (4 200 m²), G-2 Halle 2 (3 100 m²), G-3 Verwaltung (1 150 m²) am Werk Ahrenberg; G-4 Lagerhalle, G-5 Montagehalle am Werk Lindach. Der Zählerplatz NA-1 (MS-01) und der Ladepunkt auf der Außenfläche (MS-14) hängen direkt am Standort.

**Heute im Code.** Heute nicht vorhanden (`grep -rni 'building|gebaeude' MIG` → 0 Objekte; im Portal kommt „Gebäude“ als Kundenwort nicht vor).

**Abgrenzung.** Nicht der Bereich (ein Teil des Gebäudes), nicht die Anlage (elektrisch).

> **Verfeinert durch AP-02 E3:** Die Bezugsfläche ist zeitgültig: Intervalle mit „gültig ab“ je Standort, Gebäude und Bereich.

> **Verfeinert durch AP-02 E4:** Nutzung ist ein geschlossenes Vokabular mit Mehrfachauswahl; die erste Auswahl ist die Hauptnutzung, „Sonstiges“ trägt eine Notiz.

> **Verfeinert durch AP-02 E11:** Beim Verschieben ziehen Bereiche mit; Messstellen bleiben an ihrem Knoten; Anlagen und Netzanschlüsse ziehen nie automatisch mit.

## Bereich

*Sicht: Ort*

**Ein räumlicher Teil eines Gebäudes oder Standorts (Halle Nord, Etage, Technikraum, Außenfläche) — die dritte, optionale Ebene des Ortsbaums.**

Ein Bereich ist räumlich, nicht organisatorisch (E4): „Halle 1 Nord“ ist ein Bereich, „Abteilung Spritzguss“ ist ein Prozess. Bereiche werden nicht verschachtelt (erster Umfang). Ein Bereich kann direkt am Standort hängen, wenn es kein Gebäude gibt.

**Beispiel (Referenzunternehmen Ahrenberg).** B-1 Halle 1 Nord (Maschinenreihe SG01–SG06), B-2 Halle 1 Süd (Technikraum mit Druckluft, Kühlung und Box E-1).

**Heute im Code.** Heute nicht vorhanden (`grep -rni 'bereich\b' MIG` → 0). `measurement_point.folder` (MIG/V20260709000000__measurement_point.sql:33) ist ein reiner Anzeige-Ordner ohne Bedeutung; das Einheitsmodell hatte „Areas/Floors bewusst NICHT in V1“ (DATA/vp-komponenten-einheit-h2/report.md:268) — durch den Plan vom 10.09.2026 aufgehoben (W2).

**Abgrenzung.** Nicht Prozess, nicht Kostenstelle (beide organisatorisch, beide gebäudeübergreifend).

> **Verfeinert durch AP-02 E7:** Der Bereich ist optional — er wird nur dort angelegt, wo Messstellen feiner als das Gebäude verortet werden.

## Anlage

*Sicht: Elektrisch*

**Ein elektrisches System an genau einem Standort zusammen mit seinen Komponenten, Boxen, Messstellen und seinem Betrieb (Betriebsmodell, Tarif).**

Die Anlage bleibt das heutige Objekt (E1, Variante A): sie ist die Betriebseinheit, die VoltPilot beobachtet und steuert. Neu ist, dass sie unter einem Standort hängt und dass ihr Ort (Adresse) und ihr Anschluss (Netzanschluss) eigene Objekte werden. Ein reiner Messkunde hat ebenfalls eine Anlage je Netzanschluss — sie heißt dann z. B. „Werk Lindach“ und trägt nur „reine Messung“; das Portal rückt sie für ihn nicht in den Vordergrund (AP-01). Fachlich ist jede Anlage genau EIN elektrisches System (siehe dort).

**Beispiel (Referenzunternehmen Ahrenberg).** AN-1 Werk Ahrenberg – Halle 1 (Bestand seit 12.03.2024; PV 240 kWp + Speicher 200 kWh; Lastspitzenkappung läuft; versorgt Halle 1 UND Verwaltung), AN-2 Werk Ahrenberg – Halle 2 (reine Messung), AN-3 Werk Lindach (reine Messung).

**Heute im Code.** Tabelle `site` (MIG/V1__core_schema.sql:45-52: name, bidding_zone) plus 17 Zusatzspalten — u. a. `plant_kind` (MIG/V20260706010000__site_plant_kind.sql:17), `tarif_art`/`tarif_param_ct_kwh` (MIG/V20260708010000__site_tarif_model.sql:41-44), `max_feed_in_kw` (MIG/V20260716000000__site_max_feed_in_kw.sql:21), `component_authority` box|portal (MIG/V20260817000000__component_authority_and_definitions.sql:42-43), `profil` privat|gewerbe (MIG/V20260838000000__site_profil.sql:45) — und 19 Migrationen mit 24 Verweisen `REFERENCES site(id)` (device, asset, measurement_point, site_profile_state, site_charging_config …). Portal: `#/anlage/{siteId}/…` (PORTAL/nav.ts:504, :612-641), fünf Bereiche Cockpit · Fahrplan · Verlauf · Steuerung · Anlage (PORTAL/anlageNav.ts:16-17, :76). Topic `ems/{tenant}/{site}/{device}/…` (docs/architecture.md:90-94).

**Abgrenzung.** Nicht der Standort (räumlich, kann mehrere Anlagen haben), nicht der Netzanschluss (der Übergabepunkt der Anlage), nicht die Box (die Hardware in der Anlage).

> **Verfeinert durch AP-01 E7/E8:** Eine Anlage ohne aktive Teilnahme liegt im Ruhe-Zustand OHNE Enddatum; alles bleibt gespeichert, nur Fahrplan, Regeln und Steuerarten wirken nicht. „Steuerung starten“ hebt die Ruhe auf.

> **Verfeinert durch AP-01 Geld-Regel:** Eine reine Messanlage zeigt auf KEINER Ebene Geld: Kontoauszug, Vorteil-Zählung und Marktpreis-Kacheln gehören zu „Steuern & Optimieren“ und zu Anlagen mit Erzeuger oder Speicher.

> **Verfeinert durch AP-02 E5:** Die Zuordnung Anlage → Standort ist zeitgültig und wohnt in einer eigenen Beziehung, nicht in einer Spalte an der Anlage. Ein Bestandskunde mit EINER Anlage bekommt den Standort automatisch, ab mehreren Anlagen als Vorschau-Zuordnung.

> **Verfeinert durch AP-06 E3:** Hat eine Anlage mehrere Boxen, ist EINE davon die „führende Box“ — ein gespeicherter, sichtbarer Fakt (Vorgabe: Box des primären Speichers, sonst die einzige; bei zwei Boxen ohne Speicher wählt der Kundenadministrator sie ausdrücklich). Sie bildet die Anlagen-Summe und empfängt den Fahrplan.

## Elektrisches System

*Sicht: Elektrisch*

**Alles, was hinter einem Netzanschluss elektrisch zusammenhängt: Hauptzähler, Unterzähler, Erzeuger, Speicher, Verbraucher — die Bilanzgrenze der Anlage.**

Das elektrische System ist die fachliche Definition dessen, was eine Anlage elektrisch umfasst. Im ersten Umfang gilt: eine Anlage = ein elektrisches System = ein Netzanschluss. Ein System kann mehrere Gebäude versorgen (Referenzfall 4). Zwei Anschlüsse am selben Standort sind zwei Systeme und damit zwei Anlagen (Referenzfall 3), solange sie nicht dauerhaft gekuppelt sind (vorbereitet: 1..n Anschlüsse je System, E6). Ein Steuerungsverbund (AP-15) lebt immer INNERHALB eines elektrischen Systems, nie darüber hinaus.

**Beispiel (Referenzunternehmen Ahrenberg).** System hinter NA-1: Hauptzähler MS-01/02, PV MS-03, Speicher MS-04, Unterzähler MS-05…MS-08, Rest MS-09 — es versorgt Halle 1 und die Verwaltung.

**Heute im Code.** Heute nicht als Objekt, sondern implizit die Anlage mit ihrem einen maßgeblichen Netzpunkt: Rolle `grid` ist „die maßgebliche Messung, nie eine Summe“ (docs/contracts/v2/topology-read-model.md:14-21), 0–1 Netz je Anlage, 409 beim zweiten (docs/agents/root/multi-source-anlage-phase-1-n-erzeuger-p.md:24-29); Energiefluss aus Rollen pv|storage|grid|consumer|charging (docs/contracts/v2/edge-entity.schema.json:348-353).

**Abgrenzung.** Nicht der Ortsbaum (AP-02: „Elektrische Versorgung wird nicht aus dem Ortsbaum abgeleitet“), nicht die Box (mehrere Boxen können in einem System lesen).

> **Verfeinert durch AP-10 E9:** Das elektrische System ist die BILANZGRENZE und im Code die Anlage: je System genau ein Netzanschluss und je Richtung höchstens ein Hauptzähler. Standort und Unternehmen bilanzieren als Summe über ihre Systeme mit „x von y“ und haben keinen eigenen Rest; ein Gebäude ist eine SICHT (Ort × Stellung), keine Bilanzgrenze. Regeln: `docs/contracts/v2/bilanz.md` §4.8.

## Netzanschluss

*Sicht: Elektrisch*

**Der Übergabepunkt zum öffentlichen Netz mit Marktlokation, Netzbetreiber, Anschlussleistung und Tarif.**

Der Netzanschluss ist ein eigenes Objekt am Standort (E6). Er trägt, was heute auf der Anlage liegt: vereinbarte Leistung, Einspeisegrenze, Leistungspreis, Arbeitspreis, Vergütung. Sein Hauptzähler ist eine Messstelle mit der elektrischen Stellung „Hauptzähler“. Im ersten Umfang gehört ein Netzanschluss zu genau einer Anlage.

**Beispiel (Referenzunternehmen Ahrenberg).** NA-1 Hauptanschluss Halle 1 (Marktlokation 47110000001, 630 kVA, vereinbart 550 kW, RLM, 22,4 ct/kWh, 96 €/kW·a), NA-2 Anschluss Halle 2 (250 kVA, 200 kW), NA-3 Anschluss Lindach (160 kVA, 120 kW).

**Heute im Code.** Heute nicht als Objekt; seine Eigenschaften liegen auf `site`: `max_feed_in_kw` (MIG/V20260716000000__site_max_feed_in_kw.sql:21), `leistungspreis_eur_kw`/`abrechnung_leistung` (MIG/V20260716020000__peak_shaving_master_data.sql:44-50), `tarif_art`/`tarif_param_ct_kwh` (MIG/V20260708010000__site_tarif_model.sql:41-44), `anzulegender_wert_ct_kwh` (MIG/V20260707020000__anzulegender_wert_and_monthly_market_value.sql:44), `netzladen_erlaubt` (MIG/V20260707000000__site_netzladen_erlaubt.sql:21). Portal-Erklärtext „Name, Standort, Veräußerungsform und Netzanschluss“ (PORTAL/pages/AnlageTechnik.tsx:486) und Feld „Maximale Einspeiseleistung am Netzanschlusspunkt“ (PORTAL/pages/AnlageTechnik.tsx:547). Der Netzzähler ist die Komponente mit Rolle `grid`.

**Abgrenzung.** Nicht das elektrische System (das hängt dahinter), nicht der Hauptzähler (eine Messstelle AM Anschluss).

> **Verfeinert durch AP-01 E10:** Die vereinbarte Leistung des Anschlusses ist der Prüfstein: Grenzen werden gegen ihn plausibilisiert.

## Box (Edge)

*Sicht: Erfassung*

**Die VoltPilot-Hardware beim Kunden, die Datenquellen liest, Werte puffert und Pläne unter eigenen Wächtern ausführt.**

Eine Box hat genau eine Heimat-Anlage (E7, unverändert: sie ist die Topic-Adresse) und liest die Datenquellen, für die sie zuständig ist (AP-06, zeitgültig). Mehrere Boxen an einem Standort sind normal; mehrere Boxen in EINER Anlage sind der Fall für AP-06/AP-15. Zwei Boxen sind noch kein Steuerungsverbund.

**Beispiel (Referenzunternehmen Ahrenberg).** E-1 Box Halle 1 (Bestand, liest Wechselrichter, Netzzähler, vier Unterzähler; steuert den Wechselrichter), E-2 Box Halle 2 (liest WAGO C-1 und den Ladepunkt), E-3 Box Lindach.

**Heute im Code.** Tabelle `device` (MIG/V1__core_schema.sql:54-62: external_ref, kind, status unclaimed|claimed ohne CHECK — einzige Schreibstelle services/api/src/main/java/com/voltpilot/api/repo/DeviceRepository.java:72), `device_enrollment` (MIG/V20260702040000__device_enrollment.sql:27-37), `device_edge_version` (MIG/V20260803000000__device_edge_version.sql:24-30), `lan_host`/`lan_seen_at` (MIG/V20260832000000__device_lan_address.sql:30-32). „Online“ = MAX(telemetry.received_at) im 5-Minuten-Fenster (services/api/src/main/java/com/voltpilot/api/repo/OverviewRepository.java:29-31). Umzug: `device_site_assignment.effective_at` (MIG/V20260843000000__component_edit_contract.sql:54-67). Kundenwort „VoltPilot-Box“ (PORTAL/komponenten.ts:268, :311-313), Box-Seite `#/anlage/{siteId}/box` (PORTAL/nav.ts:881).

**Abgrenzung.** Nicht das Gerät (das hängt hinter der Box), nicht die Datenquelle (der Weg zum Gerät).

> **Verfeinert durch AP-06 E2:** Die Zuständigkeit hängt an der DATENQUELLE, nicht am Gerät und nicht an der Komponente: alle Geräte hinter einem Erfassungsweg liest dieselbe Box, ein Wechsel nimmt alle mit.

> **Verfeinert durch AP-06 E4:** Registry-Push und Mess-Plan werden je Box aus ihren Zuständigkeiten zum Zeitpunkt zusammengesetzt — je Box eine DISJUNKTE Menge; ein Wechsel sind zwei Pushes (erst die alte Box ohne die Quelle, dann die neue mit ihr).

> **Verfeinert durch AP-06 E5/E12:** Der Herzschlag trägt additive Blöcke `data_sources[]` (Zustand je Quelle) und `supports[]` (Fähigkeiten); bis eine Box das meldet, gilt eine Cloud-Tabelle „Version → Fähigkeiten“.

> **Verfeinert durch AP-06 E6:** Das Lese-Budget bleibt je BOX (physischer Deckel); jede Datenquelle zeigt ihren Anteil, Anlage und Standort die Summe.

> **Verfeinert durch AP-06 E7/E11:** „Box tauschen“ überträgt ab dem Zeitpunkt Heimat-Anlage, Rolle, alle Zuständigkeiten, Mess-Selektionen, Freigaben und OTA-Zuordnung auf die Nachfolgerin. Eine Box = ein Netz: eine Quelle in einem anderen Netz braucht eine Box in diesem Netz.

> **Verfeinert durch AP-04 E11:** Ein Wechsel der zuständigen Box ist eine reine Zuständigkeitssache — Messstelle und Quellenbindung bleiben unberührt; ab dem Zeitpunkt nennt die Herkunft je Wert die neue Box.

## Datenquelle

*Sicht: Erfassung*

**Ein von einer Box erreichbarer Erfassungsweg — Adresse plus Protokoll — hinter dem ein oder mehrere Geräte antworten.**

Die Datenquelle ist der technische Zugang (Modbus TCP Host/Port/Geräte-ID, MQTT-Themen, HTTP-Auskunft, OCPP-Station). Sie gehört zeitgültig zu genau einer zuständigen Box (AP-06). Ein Controller mit mehreren Karten oder ein Gateway mit mehreren Zählern ist EINE Datenquelle mit mehreren Geräten. „Datenquelle“ ist ein Fachwort für Einrichtende, kein Wort der Auswertungsflächen.

**Beispiel (Referenzunternehmen Ahrenberg).** DQ-3: Modbus TCP 192.168.10.31, Geräte-IDs 1–4 — vier Unterzähler hinter einer Adresse, zuständig Box E-1. DQ-5: OCPP-Station AHR-LP-01, die sich selbst zur Box E-2 verbindet.

**Heute im Code.** Kein Objekt. Transport-Wahrheit je Komponente in `measurement_point.communication/family/connection_json` (MIG/V20260709000000__measurement_point.sql:38-43), historisiert in `component_definition.connection_json` (MIG/V20260817000000__component_authority_and_definitions.sql:82-93); „Der Lesepfad reist im Flow“ (docs/contracts/v2/edge-entity-config.md:192-194); Lesetypen `vp.modbus.read`, `vp.mqtt.read`, `vp.http.read` sind Flow-Knoten (services/api/src/main/resources/flowcatalog/catalog.json:769,904,1046). Ist-Rückmeldung je Quelle `device_source_status.health` ok|stale|never (MIG/V20260721000000__device_source_status.sql:24-41). Zuständige Box = `measurement_point.device_id` bzw. `entity_registry_state.device_id` je Anlage (MIG/V20260709000000:48; MIG/V20260719030000__entity_sync_state.sql:24-27). Im Portal ist „Datenquelle“ heute nur die MaStR-Herkunft (PORTAL/components/MastrDrawer.tsx:276).

**Abgrenzung.** Nicht das Gerät (was antwortet), nicht der Messkanal (was gelesen wird), nicht die Box (wer liest).

> **Verfeinert durch AP-06 E1:** ⚠ Die Datenquelle wird ein EIGENES Objekt (Kennzeichen DQ-x, Anlage, Protokoll, Adresse, Netzlage, Lesetakt, Verlauf); Komponenten verweisen additiv darauf. Der Bestand wird als Vorschlagsliste (Box + Protokoll + Adresse) gruppiert und vom Kunden bestätigt.

> **Verfeinert durch AP-06 E10:** Zwei Boxen dürfen dasselbe Gerät nur als gekennzeichnete Vergleichsquelle lesen, nach ausdrücklicher Bestätigung — und nie bei Protokollen oder Vorlagen, die nur einen Leser vertragen.

> **Verfeinert durch AP-06 E1/E2/E5/E12:** Identität, Zuständigkeitszeiträume (halboffen auf die Minute, nie überlappend, nie rückwirkend, beendet statt überschrieben), Doppel-Lesen, Fehlerklassen je Quelle und die Tabelle „Software-Stand → Fähigkeiten“ sind Vertrag: `docs/contracts/v2/data-source-assignment.md` mit `data-source-vectors.json` und `edge-capabilities.json` (AP-06 IP-1, Zwillinge `uems/DatenquelleRegeln` ⟷ `uemsDatenquelle.ts`).

> **Verfeinert durch AP-04 E4 · AP-05 E5:** Wandlerfaktor und Einstellungen hängen an der QUELLE (Gerät bzw. Gerät + Kanal), zeitgültig als Fassung; die Messstelle bleibt hardwarefrei.

## Gerät (physisches Messgerät, Controller, Energiekarte)

*Sicht: Erfassung*

**Das physische Kästchen hinter der Box — Wechselrichter, Zähler, Ladestation oder ein Controller mit Energiekarten — mit Hersteller, Typ und Seriennummer.**

„Gerät“ folgt dem entschiedenen Naming Set A (Komponente · Gerät · VoltPilot-Box). Ein Gerät kann mehrere Komponenten speisen. Ein physisches Messgerät ist ein Gerät in seiner messenden Rolle; ein Zählerwechsel ist ein neues Gerät an derselben Komponente und derselben Messstelle (AP-04). Ein Controller (z. B. WAGO) ist ein Gerät, das Energiekarten trägt; jede Energiekarte speist eine Komponente (E12; Hardware-Details AP-05).

**Beispiel (Referenzunternehmen Ahrenberg).** GR-1 Hybrid-Wechselrichter (speist K-1 Wechselrichter und K-2 Speicher), GR-4 Unterzähler Spritzguss (Z-5a, ab 18.11.2026 Z-5b), GR-7 WAGO-Controller C-1 mit EK-1…EK-4.

**Heute im Code.** Naming Set A entschieden (DATA/vp-komponenten-einheit-h2/report.md:923-924, :758-762; „EIN Gerät speist MEHRERE Komponenten“ :766-767); Portal „Gerät = a physical box the edge reports BEHIND the VoltPilot-Box“ (PORTAL/komponenten.ts:234-249); Vertrag `driver` brand/model/family/communication/connection (docs/contracts/v2/edge-entity.schema.json:296, :365-367); `edge_source_id` (MIG/V20260720010000__u2_geraete_adoption.sql:27). Controller/Energiekarte heute nicht vorhanden — nächstes: `modbus-generic` (services/api/src/main/resources/entitytypes/catalog.json:352) und Selbstbau-Tür (services/api/src/main/java/com/voltpilot/api/components/SelfBuildDefinition.java:54).

**Abgrenzung.** Nicht die Komponente (das EMS-Objekt), nicht die Datenquelle (der Weg).

> **Verfeinert durch AP-05 E4:** Die Identität einer Energiekarte ist (Gerät, Steckplatz); eine Karten-Seriennummer ist optionaler Freitext, ein Steckplatzwechsel eine ausdrückliche Zuordnung.

> **Verfeinert durch AP-05 E6:** Kartenwechsel und Zählerrücksetzung sind Gerätegrenzen OHNE Gerätewechsel — ein Ereignis an der Komponente mit Zeitpunkt und optionalem Endstand.

> **Verfeinert durch AP-04 E10:** Ein Controller-Wechsel ist EIN Vorgang am Gerät: Karten gelten als übernommen, je Karte abwählbar; alle Komponenten wechseln auf das neue Gerät, alle Messstellen binden automatisch an die neuen Kanäle.

## Komponente

*Sicht: Erfassung*

**Das EMS-Objekt in einer Anlage, das misst und/oder gesteuert wird — mit Rolle im Energiefluss, Messkanälen und Freigabe-Zustand.**

Unverändert aus dem Einheitsmodell: die Komponente ist die Zeile, die der Kunde als „Wechselrichter“, „Speicher“, „Zähler Halle 2“ oder „Ladepunkt“ sieht. Sie gehört zu genau einer Anlage (elektrisches System) und wird von genau einem Gerät gespeist. Ihre Messkanäle sind die Quellen der logischen Messstellen. Steuern ist eine getrennte Freigabe je Komponente („Steuern freigeben“).

**Beispiel (Referenzunternehmen Ahrenberg).** K-1 Wechselrichter, K-2 Speicher, K-3 Netzzähler Halle 1, K-8.1…K-8.4 Zähler je Energiekarte, K-9 Ladepunkt (bis 30.11.2026 „Nur messen“).

**Heute im Code.** `measurement_point` mit `entity_type` = v2-Entität (MIG/V20260718000000__v2_entity_registry.sql:4-5, :22-24), Basis MIG/V20260709000000__measurement_point.sql:27-60 (role, label, brand, model, communication, connection_json, unit, device_id, control, capacity_kwp); `source_kind` builtin|certified|custom|composed (MIG/V20260815000000__component_template.sql:208-221). Kundenwort „Komponente“ statt „Entität“/„Anlagenteil“ (PORTAL/copy.test.ts:77,80). Freigabe-Stufen „Nur messen / Von VoltPilot freigegeben / Geprüfte Vorlage / Von Ihnen freigegeben“ (PORTAL/schaltFreigabe.ts:401-434). Kein Status-/Aktiv-/Archiv-Feld (17× `ALTER TABLE measurement_point`, keines fügt eines hinzu).

**Abgrenzung.** Nicht das Gerät (physisch), nicht die Messstelle (fachlich, überlebt die Komponente).

> **Verfeinert durch AP-07 E2:** ⚠ Die Messreihe ist an der KOMPONENTE geschlüsselt (Mandant + Komponente + Messkanal) — das ERSETZT AP-00 §6.4 „die Reihe bleibt am Gerät geschlüsselt“. Gerät samt Einbau, lesende Box, Einstellungs-Fassung und Katalogstand reisen als Herkunft je WERT mit.

> **Verfeinert durch AP-07 E8:** Kein Unclaim, Box-Tausch oder Komponenten-Löschen vernichtet Messreihen oder Ereignisse: die Box wird „ausgebaut“, die Reihen bleiben mit ihrer Herkunft. Löschen ist nur der ausdrückliche Purge.

## Messkanal

*Sicht: Erfassung*

**Eine einzelne gelesene Größe einer Komponente — benannt nach dem Messpunkt-Katalog, mit Einheit, Wertart und Qualität je Wert.**

Der Messkanal ist die technische Reihe: „Zähler EK-2, Wirkenergie Bezug“. Er entsteht mit der Komponente und stirbt mit ihr; ein neues Gerät hat neue Kanäle. Er ist NIE das, worüber der Kunde berichtet — das ist die Messstelle, der er als führende Quelle dient.

**Beispiel (Referenzunternehmen Ahrenberg).** K-3 · Wirkenergie Bezug (Zählerstand, kWh), K-1 · PV-Leistung (Momentanwert, kW), K-9 · Energie je Ladevorgang.

**Heute im Code.** Kein Objekt, ein String: `channel` in `telemetry_v2(time, tenant_id, site_id, device_id, entity_id, channel, value)` (MIG/V20260718010000__telemetry_v2.sql:27-36) bzw. `point_key` in `device_measurement_sample` mit `quality` good|uncertain|invalid|stale|device_error und `aggregation_kind` gauge|counter|state|event|bitfield|text|none (MIG/V20260848000000__additional_measurement_pipeline.sql:27-55). Katalog mit 2 341 Punkten, Felder point_key/unit/aggregation_kind/… (catalog/measurement-points/README.md:17-28). Einheit nur `measurement_point.unit` Default kW (MIG/V20260709000000:45); Richtung nur als Vorzeichen-Konvention (docs/contracts/v2/mqtt-telemetry-2.0.schema.json:8). Kundenwort „Messwert“, nie „Messpunkt“ (PORTAL/copy.test.ts:78); Auswahl heißt „Beobachtete Register/Messwerte“ (PORTAL/beobachteteRegister.ts:45-60).

**Abgrenzung.** Nicht die Messstelle (fachliche Identität), nicht die Messgröße (das Attribut).

> **Verfeinert durch AP-07 E1:** Die Strecke der Zusätzlichen Messwerte wird die EINE Messwert-Strecke, additiv erweitert um Komponente, Herkunft und Fassung; die Kern-Telemetrie bleibt der Betriebs-Pfad (Cockpit, Fahrplan, Regelung) und trägt keine Messstellen-Reihe.

> **Verfeinert durch AP-07 E6/E7:** Jeder Messkanal jeder Komponente bekommt Viertelstunden- und Tageswerte für zehn Jahre (Retention 3 653 Tage) — eine Regel, kein Sonderfall.

> **Verfeinert durch AP-07 E9:** Die Kadenz ist ein Feld der Quellenbindung, zeitgültig; sie reist als Soll zur Box und wird je Viertelstundenwert als „erwartet“ gespeichert. Eine Lücke beginnt ab 2 × Kadenz ohne guten Wert.

> **Verfeinert durch AP-07 E3/E13:** Derselbe Wert ist Reihe + Messzeit — die Sequenz ist nur noch Kennzeichen: dasselbe Paket zweimal ist EIN Wert, ein abweichender Wert zur selben Messzeit wird abgewiesen und als `duplicate_conflict` festgehalten, der erste bleibt. Eine Messzeit mehr als 5 Minuten in der Zukunft oder älter als 90 Tage wird abgewiesen; ein Uhrsprung wird gemeldet, der Wert bleibt. Die 15 Angaben je Wert und diese Ableitung stehen als Vertrag mit Vektoren in `docs/contracts/v2/messwert-herkunft.md` (AP-07 IP-1).

> **Verfeinert durch AP-05 E9:** Standardsatz für eine Energiekarte: 13 Kanäle bei 60 s; die Wirkleistung gesamt bildet die Box als Summe, die Hauptzuleitung darf 10 s.

## Logische Messstelle

*Sicht: Zustand*

**Die fachliche Identität einer Messung mit eigenem Kennzeichen, die Gerät, Kanal, Box und Erfassungsweg überlebt — und in allen drei Sichten (Ort, Organisation, elektrisch) zugeordnet ist.**

Die Messstelle ist das zentrale Objekt des Unternehmens-Energiemanagements. Sie hat Kennzeichen (E10), Namen, Messgröße mit Medium (E11), Richtung und Wertart. Sie ist gemessen (führende Quelle = ein Messkanal, zeitgültig; Vergleichsquellen AP-04) oder berechnet (Summe, Differenz, fester Anteil — AP-10). Ihre Zuordnungen zu Ort, Anlage/elektrischer Stellung, Prozess und Kostenstellen sind zeitgültig und bleiben nachvollziehbar. Bis 100 je Kundenbereich im ersten Umfang.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-06 „Spritzguss SG01–SG06“: Ort B-1, elektrisch AN-1 Unterzähler von MS-01, Prozess Spritzguss, Kostenstelle 4100, führende Quelle K-5 (Z-5a bis 18.11.2026, danach Z-5b); Oktober 2026: 55 100 kWh.

**Heute im Code.** Heute nicht vorhanden. Die Identität einer Reihe ist heute (tenant, site, device, entity_id, channel) bzw. (tenant, site, device, point_key) — ein Zählerwechsel ist heute eine neue Reihe. Nächstes: `device_measurement_selection.entity_id` bindet einen Punkt an eine Komponente (MIG/V20260855000000__measurement_selection_per_component.sql:16,44-45), Geräteumzug lässt Historie am alten Ort (MIG/V20260850000000__measurement_history_device_move.sql).

**Abgrenzung.** Nicht der Messkanal (technisch), nicht die Komponente (Gerätesicht). Ein Zählerwechsel ändert die Quelle, nie die Messstelle.

> **Verfeinert durch AP-04 E1:** ⚠ Eine Messstelle hat genau EINE Hauptgröße (identitätsstiftend, nie änderbar) und 0..n Nebengrößen desselben Messortes, jede mit eigener führender Quelle — das ERSETZT AP-00 §4.2 „Messstelle 1 : 1 Messgröße“ (AP-04 W1). Nebengrößen tragen nie Bilanz oder Bericht.

> **Verfeinert durch AP-04 E3:** Vergleichsquellen werden mit Zweck gekennzeichnet (Plausibilität · Ersatz bei Ausfall · Abrechnungszähler) und beide Werte nebeneinander gezeigt — ohne Bewertung, ohne Ersatz.

> **Verfeinert durch AP-04 E7:** Das Kennzeichen ist vierstellig fortlaufend („MS-0001“) je Kundenbereich, änderbar auf 2–16 Zeichen (Großbuchstaben, Ziffern, „-“, „.“, „/“); archivierte Kennzeichen bleiben belegt.

> **Verfeinert durch AP-04 E8:** Eine Messstelle OHNE Quelle ist erlaubt und eingerichtet (Kennzeichen + Name + Hauptgröße + Ort); ihre Beobachtung ist „keine Datenquelle“, und in Bilanz und Bericht steht sie als „ohne Werte“ — nie als 0.

> **Verfeinert durch AP-04 E12:** Die elektrische Stellung „Unterzähler von …“ bezieht sich auf die übergeordnete MESSSTELLE derselben Anlage (zeitgültig, Tag), nicht auf eine Komponente.

> **Verfeinert durch AP-04 E2:** Ein Quellenwechsel trägt einen Zeitpunkt auf die Minute (Zeitzone des Standorts, Vorgabe „jetzt“); Vergangenheit ist erlaubt und als „rückwirkend“ markiert, Zukunft heißt „angekündigt“. Lücke und Überlappung werden angezeigt, nie aufgefüllt.

> **Verfeinert durch AP-04 E6:** Bestandskomponenten werden als Vorschlagsliste je Standort übernommen („Alle übernehmen“ erst nach Sichtung); Bestandskunden ohne „Messen & Auswerten“ bekommen keine Messstellen.

> **Verfeinert durch AP-05 E3:** Bei einer Energiekarte ist der Zählerstand der Karte die Hauptgröße und die Wirkleistung eine Nebengröße; eine auf der Box integrierte Energie darf nur als gekennzeichnete Vergleichsgröße auftreten.

> **Verfeinert durch AP-04 IP-1:** Die Regeln der Messstelle sind ein Vertrag mit geteilten Vektoren: `docs/contracts/v2/messstelle.md` (Schema `messstelle.schema.json`, Vektoren `messstelle-vectors.json`). Ein Kennzeichen geht nie an eine ANDERE Messstelle — auch das frühere einer umbenannten bleibt belegt; „genau ein Hauptzähler je Anlage“ heißt: je Anlage und Richtung einer, alle am selben Zähler (MS-01 Bezug und MS-02 Abgabe an K-3); eine neue Quelle beendet die laufende genau zu ihrem Beginn, eine Lücke bleibt als Abschnitt ohne Quelle sichtbar; eine berechnete Messstelle braucht keinen Ort. Zwillinge: `services/api .../uems/MessstelleRegeln` und `frontend/portal/src/uemsMessstelle.ts` — noch ruft niemand an.

## Messgröße, Medium, Einheit, Richtung, Wertart

*Sicht: Zustand*

**Die Attribute, die sagen, WAS eine Messstelle misst: Medium (Strom, Gas, Wärme, Wasser, Druckluft), Größe (Wirkenergie, Leistung, Volumen), Einheit, Richtung (Bezug, Abgabe, Erzeugung, Laden/Entladen) und Wertart (Zählerstand, Intervallmenge, Momentanwert).**

Das Medium ist ein geschlossenes Vokabular an der Messstelle; im ersten Umfang ist nur „Strom“ wählbar, die anderen sind vorbereitet, nicht ausgebaut (E11). Hier hängt der Haken: Verbrauchsbildung (AP-08) und Katalog kennen nur Strom; ein Gas-Wert bekommt einen Platz, aber keine Auswertung. „Einheit“ ist die physikalische Einheit (kWh, kW, m³) — nicht zu verwechseln mit dem „Einheitsmodell“, dem Namen des vereinheitlichten Komponenten-Modells.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-01: Strom · Wirkenergie · kWh · Bezug · Zählerstand + 15-min-Menge. MS-21: Gas · Volumen · m³ · Bezug · Zählerstand monatlich (vorbereitet).

**Heute im Code.** Medium heute nicht vorhanden (`grep -rniE 'medium|\bgas\b|waerme|wasser' MIG` → nur Prosa; Katalog 0 Treffer gas/wasser/wärme, catalog/measurement-points/README.md). Wertart ≈ `aggregation_kind` (catalog/measurement-points/schema/catalog.schema.json:138); Einheit `unit` (MIG/V20260709000000:45); Richtung per Vorzeichen (docs/contracts/v2/mqtt-telemetry-2.0.schema.json:8) und in der Topologie als `direction in|out` (docs/contracts/v2/topology-read-model.md:23-26).

**Abgrenzung.** Attribute der Messstelle, keine eigenen Objekte.

> **Verfeinert durch AP-04 E1:** Medium, Größe, Einheit, Richtung und Wertart sind Attribute der HAUPTGRÖSSE; jede Nebengröße trägt denselben Satz für sich.

> **Verfeinert durch AP-07 E12:** Die Wertart bestimmt die Cloud beim Schreiben aus Katalog bzw. Vorlage zur Messzeit und speichert sie je Rohwert und je Viertelstundenwert. Ein Punkt OHNE Wertart ist nicht an eine Messstelle bindbar.

## Prozess

*Sicht: Organisation*

**Eine betriebliche Tätigkeit, die Energie einsetzt (Spritzguss, Druckluft, Logistik) — organisatorisch, gebäude- und standortübergreifend.**

Prozesse bilden die zweite Sicht auf dieselben Messstellen. Ein Prozess kann Messstellen in mehreren Gebäuden, Anlagen und Standorten haben. Prozesse dürfen einen übergeordneten Prozess haben (Prozessbaum, eine Ebene). Sie sind der Anker für „wesentliche Energieeinsätze“ (AP-16) und Prozesskennzahlen (AP-11).

**Beispiel (Referenzunternehmen Ahrenberg).** P-1 Spritzguss läuft in Halle 1 (MS-06, AN-1) und Halle 2 (MS-11, AN-2); P-2 Montage in Halle 2 und Werk Lindach; P-3 Druckluft ist Querschnitt (70 % Spritzguss, 30 % Montage).

**Heute im Code.** Heute nicht vorhanden (`grep -rniE '\bprocess\b|prozess' MIG` → nur MIG/V20260842000000__flow_claim.sql:8 Prosa).

**Abgrenzung.** Nicht der Bereich (räumlich), nicht die Kostenstelle (buchhalterisch, mit Prozentaufteilung).

## Kostenstelle

*Sicht: Organisation*

**Eine Verrechnungseinheit des Kunden (Nummer + Name), der Energiemengen ganz oder zu festen Anteilen zugeordnet werden.**

Kostenstellen sind flach und kommen aus der Buchhaltung des Kunden. Eine Messstelle kann auf mehrere Kostenstellen mit festen Prozentanteilen verteilt werden (Summe 100 %, Rechnung in AP-10). Die Zuordnung ist zeitgültig: ein neuer Kostenstellenplan verändert keinen alten Bericht.

**Beispiel (Referenzunternehmen Ahrenberg).** 4100 Spritzguss, 4200 Montage, 4300 Logistik, 9000 Infrastruktur (ab 01.01.2027 aufgeteilt in 9010/9020), 9100 Verwaltung. MS-07 Druckluft: 70 % → 4100, 30 % → 4200.

**Heute im Code.** Heute nicht vorhanden (`grep -rni 'kostenstelle|cost_center' MIG` → 0).

**Abgrenzung.** Nicht der Prozess (Tätigkeit), nicht der Bereich (Raum). Prozess und Kostenstelle sind zwei getrennte Achsen (E5).

> **Verfeinert durch AP-10 E11/E12:** Die „festen Prozentanteile“ aus AP-00 werden eine eigene zeitgültige Beziehung Messstelle → Kostenstelle (Tage): an jedem Tag mit Zeilen genau 100 %, sonst „nicht verteilt“. Sie wirkt je Tag auf die Tagesmenge (kein Stichtag), endet mit der Kostenstelle und kennt keine dynamischen Schlüssel. Regeln: `docs/contracts/v2/verteilung.md`.

## Betriebsmodell (übernommen)

*Sicht: Betrieb*

**Die vom Kunden gewählte Betriebsweise einer Anlage (Lastspitzenkappung, Marktoptimierung, Atypische Netznutzung); es läuft immer nur eines je Anlage.**

Unverändert übernommen aus Steuerung Stufe 5 und dem Anwendungs-Zielbild: das Betriebsmodell hängt an der Anlage, nie am Standort. „Anwendung“ bleibt das interne Katalogwort; `site.profil` (privat|gewerbe) ist nur Voreinstellung und Tonalität. Für einen reinen Messkunden ist kein Betriebsmodell gewählt — das ist ein vollwertiger Zustand („reine Messung“).

**Beispiel (Referenzunternehmen Ahrenberg).** AN-1: Lastspitzenkappung, läuft seit 02.05.2024. AN-2, AN-3: keines (reine Messung). Der Ladepark-Rahmen an NA-2 ab 01.12.2026 ist Schutz, kein Betriebsmodell.

**Heute im Code.** `site_profile_state(site_id, profile, state an|aus)` (MIG/V20260723000000__site_profile_state.sql:26-36); Katalog services/api/src/main/java/com/voltpilot/api/profile/AnwendungKatalog.java:55-64; Portal „Betriebsmodelle“ als Radiogruppe (PORTAL/components/Betriebsmodelle.tsx:85), „läuft seit …“ (PORTAL/betriebsmodelle.ts:110-137), Grundzustand „Eigenverbrauchs-Fahrplan“ (:274-278); Kundenwort-Regel (PORTAL/copy.test.ts:103-113). Entscheidungen DATA/vp-steuerung-konzept-b3/report.md:146, DATA/vp-portal-zielbild-anwendungen/report.md:324.

**Abgrenzung.** Nicht die Regel (Ausnahme obendrauf), nicht die Steuerart (Grundverhalten je Verbraucher), nicht der Zustand „steuert“ (Beobachtung).

> **Verfeinert durch AP-01 E11:** „Marktoptimierung“ bleibt das Kundenwort und eine Option der Radiogruppe Betriebsmodell — nicht „Arbitrage“.

> **Verfeinert durch AP-03 E15:** Wird ein Bedienrecht entzogen, bleiben gesetzte Handeingriffe bis zum Ablauf oder bis ein Berechtigter sie beendet; die Zone „Jetzt“ nennt Urheber und „Bedienrecht beendet am …“.

## Regel und Steuerart (übernommen)

*Sicht: Betrieb*

**Regel = Wenn/Dann-Ausnahme, die immer gewinnt; Steuerart = Grundverhalten je Verbraucher (Quelle + optionales Ziel).**

Beide bleiben, wie in Verbrauchsmanagement v1 entschieden. Für AP-00 relevant ist nur ihre Stellung: sie hängen an Komponenten einer Anlage, nie an Messstellen, Gebäuden oder Prozessen. Ein Messkunde hat keine — und braucht keine, um Messstellen zu pflegen.

**Beispiel (Referenzunternehmen Ahrenberg).** Ab 01.12.2026: Ladepunkt K-9 mit Steuerart „Netzschonend laden“ unter dem Ladepark-Rahmen an NA-2 (Referenzfall 5).

**Heute im Code.** `flow_definition.lifecycle` draft|simulated|active|retired (MIG/V20260719000000__flow_definition.sql:31), `consumer_policy.lifecycle` draft|active|retired (MIG/V20260810000000__consumer_profile_and_policy.sql:94); Kundenwort „Regel“ (PORTAL/copy.test.ts:97); Steuerart = Quelle + Ziel (DATA/vp-verbrauchsmgmt-konzept-v1/captain-scoping.md:24).

**Abgrenzung.** Nicht das Betriebsmodell (Betriebsweise der Anlage).

## Bezugsgröße (nur Begriff, Ausbau AP-09)

*Sicht: Organisation*

**Eine nicht-energetische Größe mit Geltungsbereich (Unternehmen, Standort, Gebäude, Prozess), auf die Energie bezogen wird: Produktionsmenge, Betriebszeit, Fläche.**

AP-00 legt nur fest, dass Bezugsgrößen an Objekte des Fachmodells gebunden sind (Geltungsbereich) und zeitabhängig (Menge je Monat) oder Stammdatum (Fläche, zeitgültig) sein können. Eingabe, CSV und Kanalbindung sind AP-09.

**Beispiel (Referenzunternehmen Ahrenberg).** BZ-1 Produktionsmenge Spritzguss 312 400 kg im Oktober 2026 (Prozess P-1); BZ-4 Bezugsfläche Halle 1 4 200 m² (Gebäude G-1).

**Heute im Code.** Heute nicht vorhanden; nächstes: `asset.pv_capacity_kwp` u. a. als Stammdaten (MIG/V20260702010000__asset_registry_link.sql:27-38).

**Abgrenzung.** Nicht die Messstelle (misst Energie), nicht die Kennzahl (AP-11: Verhältnis aus beidem).

> **Verfeinert durch AP-09 E1/E2/E4/E17:** Der Geltungsbereich ist genau EINES von sieben Fachobjekten — Unternehmen · Standort · Gebäude · Bereich · Prozess · Kostenstelle · Messstelle (AP-00 nannte vier; aufgelöst in AP-09 W7) —, und die Wertart ist genau EINE von drei: Periodenwert (Menge je Tag, Woche, Monat oder Jahr), Stand (Ablesung zu einem Zeitpunkt) oder Stammdatum mit Gültigkeit. Die Einheit kommt aus einem geschlossenen Vokabular JE GRÖSSE (Masse kg · t, Stückzahl Stück, Zeit h · min, Fläche m², Volumen m³ · l, Personen, Schichten, Gradtage Kd); umgerechnet wird nur innerhalb derselben Größe mit festem Faktor, alles andere wird abgelehnt statt geraten. Die Betriebszeit ist eine Periodenreihe, kein Wochenmodell (E2). Die Bezugsfläche wird NICHT in AP-09 erfasst, sondern am Gebäude gelesen — zum Stichtag der Periode, ihrem letzten Tag (E17): ein neuer Wert ab Tag X ändert keine Periode vor X. Die Regeln stehen als Vertrag in `docs/contracts/v2/bezugsdaten.md` samt Vektoren (`bezugsdaten-vectors.json`).

## Benutzer und Rolle (nur Begriff, Rechte-Matrix AP-03)

*Sicht: Ort*

**Ein Benutzer gehört zu genau einem Kundenbereich und hat Rollen entweder unternehmensweit oder je Standort.**

AP-00 legt nur den Geltungsbereich fest: Rollen wirken auf das Unternehmen oder auf ausgewählte Standorte (entschieden); der Standort ist deshalb ein Objekt des Fachmodells, nicht nur eine Anzeigegruppe. Feinere Rechte je Gebäude oder Messstelle gibt es im ersten Umfang nicht (AP-03).

**Beispiel (Referenzunternehmen Ahrenberg).** Ines Kaltenbach: Energiemanagerin unternehmensweit. Peter Hollerbach: Bearbeiter nur für ST-2. Elektro Brunner: Installateur mit zeitlich begrenztem Zugriff (AP-03).

**Heute im Code.** Benutzer nur in Keycloak (keine DB-Tabelle: `grep -rn 'CREATE TABLE.*user' MIG` → 0); Realm-Rollen operator, admin (legacy), site-admin (Realm-Rolle OHNE Anlagenbezug), platform-admin, edge-release-publisher (infra/local/keycloak/voltpilot-realm.json:29-45); keine Benutzer↔Anlagen-Zuordnung (`grep -rn 'user_site|site_member|site_access' MIG` → 0); keine Installateur-Rolle (PORTAL/rollen.ts:33); Benutzerverwaltung nur durch Plattform-Admin (services/api/src/main/java/com/voltpilot/api/web/AdminController.java:238-323).

**Abgrenzung.** Nicht der Kundenbereich (der Zaun), nicht das Unternehmen (die Wurzel).

> **Verfeinert durch AP-03 E1:** Die Rollen sind entschieden: Kundenadministrator und Energiemanager (unternehmensweit) · Bearbeiter, Bedienberechtigt und Leser (je Standort) · Unterstützer (Installateur | VoltPilot, befristet).

> **Verfeinert durch AP-03 E2/E4:** Benutzer, Rollen und Unterstützung sind allein Sache des Kundenadministrators. Bedienberechtigt umfasst den Betrieb IM RAHMEN (Betriebsmodell, Regeln, Steuerarten, Rangliste, Ladekarten); Freigeben, Grenze und Starten/Beenden bleiben beim Kundenadministrator.

> **Verfeinert durch AP-03 E6/E7/E8/E9:** Eine Unterstützung hat ein Pflicht-Enddatum (Vorgabe 30 Tage, höchstens 12 Monate). Der Installateur hat ein Partner-Konto ohne Heimat-Kundenbereich. VoltPilot kommt nur mit Gewährung hinein — plus 24-h-Notfall-Zugriff mit Pflicht-Grund, Banner, E-Mail und Protokoll. Der Umfang je Gewährung: Ansehen · Einrichten · Einrichten und Bedienen.

> **Verfeinert durch AP-03 E11/E12:** Die Wahrheit über Rechte ist eine Zuweisungstabelle im API (Benutzer × Rolle × Standort × Gültigkeit, unter RLS) plus `/me`; Keycloak bleibt Identität. Jeder heutige Kundenbenutzer wird Kundenadministrator.

> **Verfeinert durch AP-03 W3/E13:** Die Realm-Rolle `site-admin` wird abgeschafft: OCPP-Stufen hängen künftig an der Zuweisung; bestehende Träger werden Kundenadministrator.

> **Verfeinert durch AP-03 IP-1:** Die Rechte-Matrix ist Daten: 48 Kundenaktionen × 7 Rollen mit stabiler Kennung je Zeile (`docs/contracts/v2/rechte-matrix.json`, die Tabelle `rechte-matrix.md` wird daraus erzeugt), dazu als Nachträge die Rechte-Abschnitte der später konzipierten Pakete AP-04, AP-06 und AP-07 (Zeilen mit `nachtrag`, z. B. `datenquelle.zustaendigkeit`). Ob ein Benutzer eine Aktion an einem Standort darf, welche Standorte er sieht, die Teilansicht, die OCPP-Stufe aus der Zuweisung, Unterstützung und Entzug sind Vertrag: `docs/contracts/v2/rechte-vectors.json` (Zwillinge `uems/RechteAbleitung` ⟷ `rechte.ts`) — erst der Geltungsbereich (404), dann die Aktion (403 mit der nötigen Rolle).

## Zuordnung (zeitgültig)

*Sicht: Zustand*

**Jede Beziehung, die sich im Leben eines Objekts ändern kann, hat ein „gültig ab“ und ein „gültig bis“ — und wird nie überschrieben, sondern beendet und neu begonnen.**

Zeitgültig sind: Messstelle → Ort, Messstelle → Anlage/elektrische Stellung, Messstelle → Prozess, Messstelle → Kostenstelle (mit Anteil), Messstelle → führende Quelle, Box → Datenquelle (Zuständigkeit), Anlage → Standort, Netzanschluss → Anlage, Komponente → Steuer-Freigabe, Anlage → laufendes Betriebsmodell, Benutzer → Standortrecht. Nicht zeitgültig (Änderung = neues Objekt): Komponente → Gerät, Datenquelle → Gerät, Messstelle → Messgröße. Gebäude/Bereich dürfen selten umgeordnet werden (zeitgültig, AP-02). Ein Bericht liest immer die Zuordnungen seines Zeitraums.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-08 Kühlung: Ort B-2 bis 28.02.2027, ab 01.03.2027 B-3; elektrisch AN-1 bis 28.02.2027, ab 01.03.2027 AN-2; Quelle K-7 bis 28.02.2027, ab 01.03.2027 K-8.7.

**Heute im Code.** Keine `valid_from`/`valid_to` im Modell (`grep -rn 'valid_from|valid_to|effective_from' MIG` → 0). Vorhanden sind Journale: `component_change_event.effective_at` (MIG/V20260843000000__component_edit_contract.sql:8-21), `device_site_assignment.effective_at` (:54-67), Fassungs-Historie `component_definition` (MIG/V20260817000000__component_authority_and_definitions.sql:74-109).

**Abgrenzung.** Ein Journal sagt, WANN sich etwas geändert hat; eine zeitgültige Zuordnung sagt, WAS in einem Zeitraum galt. Berichte brauchen das Zweite.

> **Verfeinert durch AP-02 E9:** Die zeitliche Auflösung einer Gültigkeit ist der TAG: „gültig ab“ wirkt 00:00 Uhr in der Zeitzone des Standorts. Ausnahme: die Quellenbindung einer Messstelle trägt einen Zeitpunkt auf die Minute (AP-04 E2).

> **Verfeinert durch AP-02 E2:** Rückwirkende Verschiebungen und Zuordnungen sind erlaubt — aber immer sichtbar: Kennzeichen „rückwirkend“, Folgen-Karte, Revision in AP-12.

> **Verfeinert durch AP-02 IP-1:** Die Mechanik der Gültigkeit ist ein Vertrag mit geteilten Vektoren: `docs/contracts/v2/ortsbaum-vectors.json` (Schema `ortsbaum.schema.json`). „gültig bis“ ist der LETZTE gültige Tag — ein Wechsel ab 01.03.2027 beendet das Alte am 28.02.2027; rückwirkend ist ein Eintrag, dessen „gültig ab“ vor dem Eintragstag am Standort liegt; der Standort einer Messstelle ist die Wurzel ihres Ortes an diesem Tag. Zwillinge: `services/api .../uems/OrtsbaumAbleitung` und `frontend/portal/src/uemsOrtsbaum.ts` — noch ruft niemand an.

> **Verfeinert durch AP-07 E4:** Der Writer prüft je Wert die lesende Box gegen die zeitgültige Zuständigkeit der Datenquelle ZUR MESSZEIT: zuständig → führend, bestätigte Vergleichsquelle → `vergleich`, sonst → gespeichert als `spiegel`, nie in Rollups.

## Zustände: aktiv · eingerichtet · liefert Daten · steuert

*Sicht: Zustand*

**Zwei Zustandsfamilien: der Lebenszyklus, den der Kunde setzt (Entwurf → eingerichtet → aktiv → archiviert, dazu angehalten), und die Beobachtung, die nie jemand setzt (liefert Daten, steuert).**

„eingerichtet“ = alle Pflichtangaben vorhanden und die technische Prüfung bestanden. „aktiv“ = nimmt am Betrieb teil (Auswertung, Bericht, Steuerung). „liefert Daten“ = innerhalb der erwarteten Kadenz kam ein Wert an; sonst „liefert keine Daten seit …“ oder „wartet auf erste Daten“. „steuert“ = Freigabe erteilt UND ein Betriebsmodell oder eine Regel läuft UND die Box bestätigt die Ausführung; sonst „steuert nicht“ mit Grund. Die vier Wörter bedeuten bei jedem Objekt dasselbe; welche davon ein Objekt haben kann, sagt die Zustandstabelle (E8).

**Beispiel (Referenzunternehmen Ahrenberg).** AN-1: aktiv · eingerichtet · liefert Daten · steuert. AN-2 am 20.10.2026: aktiv · eingerichtet · liefert Daten · steuert nicht (nichts freigegeben). MS-21 Gas: eingerichtet · aktiv · liefert keine Daten (keine Quelle).

**Heute im Code.** Kein gemeinsames Vokabular; heute je Tabelle eigene Wörter: `device.status` unclaimed|claimed (MIG/V1__core_schema.sql:60), `site_profile_state.state` an|aus (MIG/V20260723000000:26-36), `device_measurement_selection.apply_status` pending_edge|applied|rejected|first_sample (MIG/V20260841000000__device_measurement_selection.sql:38-39), `component_activation_outbox.status` pending|applied|refused (MIG/V20260843000000:92), Steuer-Scharfschaltung = Existenz einer Zeile `device_control_activation` (MIG/V20260814000000__inverter_control_certification.sql:99-111). „liefert Daten“ ist überall eine Ableitung mit hartem 5-Minuten-Fenster (services/api/src/main/java/com/voltpilot/api/repo/OverviewRepository.java:31; services/api/src/main/java/com/voltpilot/api/repo/AdminFleetRepository.java:50). Kein Aktiv-Status für Anlage und Komponente. Kundenwörter heute: „Liefert Daten / Meldet sich gerade nicht / Wartet auf die ersten Daten“ (PORTAL/komponenten.ts:754-766), „Verbunden“ (PORTAL/komponenten.ts:865-877), „Wird von VoltPilot gesteuert“ (PORTAL/komponenten.ts:307), „läuft seit“ (PORTAL/betriebsmodelle.ts:110-137).

**Abgrenzung.** „eingerichtet“ ist kein Betrieb; „aktiv“ ist keine Beobachtung; „liefert Daten“ sagt nichts über Steuerung; „steuert“ setzt „liefert Daten“ voraus.

> **Verfeinert durch AP-01 E8:** Die drei Wörter des Plans werden auf dieses Vokabular abgebildet: sichtbar = kein Objekt (Angebot auf der Karte), begonnen = Entwurf (bei „Steuern“ auch eingerichtet, noch nicht gestartet), aktiv = aktiv.

> **Verfeinert durch AP-01 E7/E8:** „angehalten“ heißt bei einer Anlage: Ruhe OHNE Enddatum; alles bleibt gespeichert, nur Fahrplan, Regeln und Steuerarten wirken nicht.

> **Verfeinert durch AP-01 E9:** Beim Fortsetzen läuft die Prüfliste erneut, dann zeigt eine Folgen-Karte, was passiert — und dann genügt ein Klick.

> **Verfeinert durch AP-01 E6 = C/W7:** Der Funktions-Zustand gilt je STANDORT und ist der HÖCHSTE Zustand seiner Teilnahmen (Rang: kein Objekt < archiviert < Entwurf < eingerichtet < angehalten < aktiv — angehalten, solange keine Anlage aktiv teilnimmt). Je Anlage entscheidet vor dem Start und beim Fortsetzen DIESELBE Prüfliste (Box, Freigabe, Verbindungstest, Grenze, Hauptzähler, Betriebsweise), und „Entwurf“ nennt, was fehlt. Die Ableitung ist Vertrag: `docs/contracts/v2/funktion-zustand-vectors.json` (AP-01 IP-1, Zwillinge `uems/FunktionZustandAbleitung` ⟷ `uemsFunktion.ts`).

> **Verfeinert durch AP-07 E9:** „liefert Daten“ ist geschärft: letzter guter Wert jünger als 3 × Kadenz nach Eingangszeit, mindestens 5 Minuten und höchstens 1 Tag; eine Lücke der Reihe beginnt schon ab 2 × Kadenz. Die Kadenz ist ein zeitgültiges Feld der Quellenbindung, kein fester 5-Minuten-Deckel.

> **Verfeinert durch AP-04 E8:** Eine Messstelle ohne Quelle hat die Beobachtung „keine Datenquelle“ — sie ist eingerichtet und aktiv, zeigt aber nie eine 0.

> **Verfeinert durch AP-07 E11:** Ereignisse (Lücke, Nachlieferung, Gerätegrenze, Zeitfehler, Konflikt) reisen über einen additiven Vertrag `…/v2/events` in eine Ereignis-Tabelle je Mandant, append-only und NIE gelöscht — sie sind der Beweis hinter jeder Zustandsaussage. Das geschlossene Vokabular (23 Arten mit Urheber, Bezug, Zeitregel und Kundensatz; ein offenes Ereignis wird fortgeschrieben, nie geändert), der Umschlag Box → Cloud (2.1) und das Redpanda-Ereignis `events.raw` stehen als Vertrag mit Vektoren in `docs/contracts/v2/events-vocabulary.md` (AP-07 IP-3).

## Ablesung

*Sicht: Erfassung · Nachtrag AP-09 §6.2 (W7)*

**Ein von Hand erfasster Zählerstand zu einem Zeitpunkt — der Messwert einer Messstelle, die keine Datenquelle hat.**

Eine Ablesung ist ein STAND, keine Menge: sie sagt, was der Zähler zu dieser Minute anzeigte. Sie trägt ihren Zeitpunkt auf die Minute mit Zone, ihren Urheber und ihre Fassung. Zwei Ablesungen derselben Reihe schließen einen Ablesezeitraum — erst daraus entsteht eine Menge. Dieselbe Ablesung noch einmal ist eine Wiederholung; derselbe Zeitpunkt mit einem anderen Stand ist ein Konflikt und braucht eine Berichtigung, nie ein stilles Überschreiben.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-21 Gas Heizung Verwaltung: 48 211 m³ am 01.10.2026 07:15 und 49 451 m³ am 02.11.2026 07:40, abgelesen von Jonas Wendlinger.

**Heute im Code.** Heute nicht vorhanden (`grep -rni 'ablesung|meter_reading' MIG` → 0). Die Regeln stehen als Vertrag in `docs/contracts/v2/bezugsdaten.md` (AP-09 IP-1); der Speicherweg kommt mit AP-09 IP-8.

**Abgrenzung.** Nicht der Messwert einer Datenquelle (der kommt von einer VoltPilot-Box), nicht die Menge (die entsteht erst aus zwei Ablesungen).

## Ablesezeitraum

*Sicht: Erfassung · Nachtrag AP-09 §6.2 (W7)*

**Die Strecke zwischen zwei Ablesungen derselben Reihe — der Zeitraum, für den ihre Differenz gilt.**

Der Ablesezeitraum ist die einzige Periode, für die eine abgelesene Menge gilt. Er wird NIE auf Tage oder Viertelstunden verteilt: ein Tag darin hat „keine Werte“, nicht 0. Berührt er zwei Kalendermonate, trägt die schließende Ablesung ein Kennzeichen „gilt für <Monat>“ — vorbelegt ist der Monat mit dem größten zeitlichen Anteil, änderbar durch den Kunden. Ab drei berührten Monaten gibt es keine Vorbelegung.

**Beispiel (Referenzunternehmen Ahrenberg).** 01.10.2026 07:15 bis 02.11.2026 07:40 = 32 Tage 1 h 25 min, 1 240 m³; Anteil Oktober 95,9 % → „gilt für Oktober 2026“.

**Heute im Code.** Heute nicht vorhanden. Die Zuordnungsregel steht als Vektor in `docs/contracts/v2/bezugsdaten-vectors.json` (Fall B8).

**Abgrenzung.** Nicht die Periode einer Bezugsgröße (die ist ein Kalendertag, eine Woche, ein Monat oder ein Jahr), nicht das Zeitraster einer Verdichtung.

## Fassung

*Sicht: Erfassung · Nachtrag AP-09 §6.2 (W7)*

**Ein Stand eines erfassten Werts mit Urheber, Zeitpunkt und Begründung — jede Änderung ist eine neue Fassung, keine überschreibt eine alte.**

Ein gespeicherter Wert wird nie geändert und nie gelöscht. Der Erstwert ist Fassung 1 und braucht keine Begründung; jede Änderung ist eine Berichtigung = Fassung n + 1 mit Begründung, und Fassung n bleibt lesbar. Hat das Unternehmen das Vier-Augen-Prinzip eingeschaltet, ist die neue Fassung ein Vorschlag, bis eine ZWEITE Person freigibt — der Urheber kann sich nie selbst freigeben. Eine Rücknahme ist ebenfalls nur die nächste Fassung: ohne Betrag, wenn sie einen Erstwert trifft, und mit dem Betrag der Vorfassung, wenn sie eine Berichtigung trifft.

**Beispiel (Referenzunternehmen Ahrenberg).** BZ-2 Gutteile Montage, Oktober 2026: Fassung 1 = 4 820 Stück (Tippfehler), Fassung 2 = 48 200 Stück mit der Begründung „Tippfehler — eine Null fehlte“.

**Heute im Code.** Das Muster gibt es schon bei den zeitgültigen Einstellungen je Quelle (Tabelle `quelle_einstellung`, AP-04); für erfasste WERTE ist es neu. Die Regeln stehen in `docs/contracts/v2/bezugsdaten.md` (AP-09 IP-1).

**Abgrenzung.** Nicht die Version einer Kennzahl (AP-11 bildet sie neu, wenn eine Fassung sich ändert), nicht die Zeitgültigkeit eines Stammdatums: „gültig ab“ sagt, WANN ein Wert gilt — die Fassung sagt, WER ihn wann erfasst hat.

## Herkunft

*Sicht: Erfassung · Nachtrag AP-09 §6.2 (W7)*

**Woher ein Wert kommt: eingegeben, importiert, aus einem Messkanal abgeleitet oder aus einem Stammdatum gelesen — je Wert, nicht je Tabelle.**

Jeder Wert nennt seine Art, seinen Urheber, seinen Erfassungszeitpunkt, seine Fassung und seinen Status. Ein importierter Wert nennt zusätzlich Datei, Zeile und den gelieferten Text samt Einheit; ein abgeleiteter nennt Komponente, Messkanal und die Regel. Die Herkunft reist unverändert in Kennzahlen und Berichte — eine Zahl ohne Herkunft ist im Unternehmens-Energiemanagement keine Zahl.

**Beispiel (Referenzunternehmen Ahrenberg).** BZ-1 Produktionsmenge Spritzguss, Oktober 2026 = 312 400 kg · Import I-2026-0001, Zeile 2 · Ines Kaltenbach, 03.11.2026 09:12.

**Heute im Code.** Für Messwerte entschieden und als Vertrag gebaut (`docs/contracts/v2/messwert-herkunft.md`, AP-07 IP-1). Für Bezugsdaten gilt ein EIGENER Vertrag (`docs/contracts/v2/bezugsdaten.md`, AP-09 E3) — der Messwert-Vertrag wird dafür nicht erweitert.

**Abgrenzung.** Nicht das Änderungsprotokoll (das sagt, was jemand an einem OBJEKT geändert hat), nicht die Datenquelle (die ist der technische Weg einer VoltPilot-Box).

## Import

*Sicht: Erfassung · Nachtrag AP-09 §6.2 (W7)*

**Ein bestätigter Vorgang, der aus einer hochgeladenen Datei Werte macht — in vier Schritten: Datei, Zuordnung, Vorschau, Übernahme.**

Die Vorschau schreibt nichts: sie sagt je Zeile ihr Urteil und ihre Befunde und je Datei die Zähler, und sie darf beliebig oft laufen. Erst die Übernahme schreibt, in einem Stück; bricht sie ab, ist nichts geschrieben. Dieselbe Datei ein zweites Mal verdoppelt keine Menge. Ein Import kann zurückgenommen werden — dann bekommt jeder Wert, den er geschrieben hat, eine Folge-Fassung; gelöscht wird nichts.

**Beispiel (Referenzunternehmen Ahrenberg).** I-2026-0001 übernimmt eine Zeile (BZ-1 Oktober 2026 = 312 400 kg); I-2026-0002 ist dieselbe Datei und schreibt 0 Änderungen.

**Heute im Code.** Heute nicht vorhanden. Die Urteile je Zeile, die Zähler je Datei und die Rücknahme stehen als Vektoren in `docs/contracts/v2/bezugsdaten-vectors.json` (AP-09 IP-1); der Weg selbst kommt mit AP-09 IP-11 … IP-13.

**Abgrenzung.** Nicht die Datenannahme (die nimmt Messwerte einer VoltPilot-Box entgegen), nicht die Bestandsübernahme (die legt Objekte an, keine Werte).

## Zuordnungs-Vorlage

*Sicht: Erfassung · Nachtrag AP-09 §6.2 (W7)*

**Die gespeicherte Deutung einer Datei-Art: welche Spalte was bedeutet, in welchem Zahlen- und Datumsformat, und welcher Text auf welche Bezugsgröße zeigt.**

Eine Vorlage gehört dem Kundenbereich, nicht einem Benutzer: jeder, der importieren darf, sieht und nutzt sie. Sie hält Trennzeichen, Kodierung, Zahlen- und Datumsformat, die Perioden-Deutung, die Zeitzone, die Einheiten-Synonyme und die Tabelle „Spaltenwert → Bezugsgröße“. Sie wird versioniert: eine Änderung ist eine neue Fassung, und ein früherer Import nennt weiter die Fassung, mit der er gelesen wurde.

**Beispiel (Referenzunternehmen Ahrenberg).** „ERP-Export Spritzguss“: Spalte 1 Periode (Monat, JJJJ-MM), Spalte 2 Bezug („Spritzguss gesamt“ → BZ-1), Spalte 3 Wert (Dezimalkomma, Tausenderpunkt), Spalte 4 Einheit.

**Heute im Code.** Heute nicht vorhanden. Das Muster gibt es schon bei den Geräte-Vorlagen der Komponenten (Tabelle `component_template`, Einheitsmodell Stufe 0a).

**Abgrenzung.** Nicht die Geräte-Vorlage (die beschreibt ein Gerät und seine Register), nicht der Bericht (der beschreibt eine Ausgabe).

## Befund

*Sicht: Erfassung · Nachtrag AP-09 §6.2 (W7)*

**Ein benannter Grund, warum eine Zeile nicht übernommen wird — oder ein Hinweis, der sie begleitet.**

Befunde sind ein geschlossenes Vokabular mit einem Kundensatz je Eintrag. Drei von ihnen sind Hinweise und verhindern nichts (die Datei ist bekannt, die Einheit wurde umgerechnet, der Wert ist auffällig); alle anderen halten die Zeile oder die Datei an. Ein Befund wird GENANNT, nicht aufgelöst: eine unbekannte Einheit wird nie geraten, ein mehrdeutiger Zeitpunkt nie gewählt, ein Zeitraum nie geteilt.

**Beispiel (Referenzunternehmen Ahrenberg).** „Unbekannte Einheit »lbs« — erlaubt sind kg, t.“ · „25.10.2026 02:30 gibt es an diesem Tag zweimal (Zeitumstellung). Geben Sie die Zone an.“

**Heute im Code.** Das Muster gibt es schon bei den Ablehnungsgründen der Schreibwege (`MessstelleAbgelehnt`, `DatenquelleAbgelehnt`); das Vokabular der Bezugsdaten steht in `docs/contracts/v2/bezugsdaten.schema.json`.

**Abgrenzung.** Nicht das Ereignis (das beschreibt, was an einer Messreihe geschehen ist), nicht die Fehlermeldung einer Route (die sagt, warum eine ANFRAGE abgelehnt wurde).

## Energiebilanz

*Sicht: Elektrisch · Nachtrag AP-10 §4.1 (E9)*

**Was in ein elektrisches System hineinfließt, was es verlässt und was an Unterzählern gemessen ist — für einen Zeitraum.**

Die Bilanzgrenze ist die Anlage, nie ein Gebäude und nie ein Standort: nur hinter einem Netzanschluss hängt alles elektrisch zusammen. Zufluss ist, was hereinkommt (Netzbezug, Erzeugung, Speicher-Entladen); Abfluss ist, was das System verlässt, ohne verbraucht zu werden (Netzabgabe, Speicher-Laden); zugeordnet ist, was an Unterzählern gemessen wurde. Was eine Messstelle in der Bilanz tut, wird aus ihrer STELLUNG abgeleitet und nie gewählt. Standort und Unternehmen summieren ihre Systeme mit „x von y“ und haben keinen eigenen Rest.

**Beispiel (Referenzunternehmen Ahrenberg).** Werk Lindach am 18.10.2026: Hauptzähler 100 kWh, Unterzähler 60 und 30 kWh — Gesamtverbrauch 100 kWh, zugeordnet 90 kWh.

**Heute im Code.** Heute nicht vorhanden. Die Regeln stehen als Vertrag in `docs/contracts/v2/bilanz.md` samt Vektoren (`bilanz-vectors.json`, AP-10 IP-1); Lesemodell und Fläche kommen mit AP-10 IP-9/IP-14.

**Abgrenzung.** Nicht die Erlösbilanz (die rechnet Geld, nicht Energie), nicht der Fahrplan (der plant, statt zu bilanzieren), nicht die Verdichtung (die bildet Mengen, nicht Rollen).

> **Verfeinert durch AP-13 E15:** Auf den Messdaten- und Analyseoberflächen heißt der Rest eines Systems an der Anlage „nicht zugeordnet“, in der Gebäude-Sicht „nicht verortet“ und bei den Kostenstellen „nicht verteilt“ — drei Wörter für drei Sichten, nie vertauscht. „Bilanz“ steht nie ohne Präfix, „Energiefluss“ bleibt das Bestandsbild der Bühne. Die Wörter: `frontend/portal/src/glossar.ts` (`UEMS_ENERGIEBILANZ`, `UEMS_NICHT_VERORTET`).

## Bilanzdifferenz

*Sicht: Elektrisch · Nachtrag AP-10 §4.3 (E1, E3)*

**Zufluss minus Abfluss minus zugeordnet — der Teil des Verbrauchs, der keiner Messstelle zugeordnet ist.**

Die Bilanzdifferenz ist eine DIFFERENZ und sonst nichts. Sie heißt dem Kunden gegenüber „nicht zugeordnet“ und wird nie einem Gerät, einem Gebäude, einem Prozess oder einer Ursache zugeschrieben — kein Verlust, kein Schwund. Ihre Richtung ist fest Wirkenergie · Bezug: 100 minus 60 minus 30 ergibt 10 kWh Bezug, nicht „richtungslos“. Sie darf negativ sein; dann heißt der Satz „Messwerte passen nicht zusammen (−x kWh)“, und es wird nichts geklemmt und nichts gedeutet. Fehlt EIN Eingang, gibt es keine Differenz („keine Werte“) — eine verkleinerte Differenz wäre zu hoch.

**Beispiel (Referenzunternehmen Ahrenberg).** Werk Lindach am 18.10.2026: 100 − 60 − 30 = 10 kWh sind keiner Messstelle zugeordnet.

**Heute im Code.** Heute nicht vorhanden; die Box rechnet mit `house = pv + grid − battery` ein namenloses Äquivalent ohne Unterzähler. Der benannte Fall steht in `docs/contracts/v2/bilanz-vectors.json` (F1–F7).

**Abgrenzung.** Nicht ein Messfehler (den behauptet niemand), nicht der Hausverbrauch des Cockpits (der ist die Box-Rechnung ohne Unterzähler), nicht ein Ersatzwert.

## Feste Verteilung

*Sicht: Organisation · Nachtrag AP-10 §4.6 (E11, E12)*

**Eine zeitgültige Beziehung Messstelle → Kostenstelle mit Anteil; alle Zeilen eines Tages ergeben genau 100 %.**

Eine Verteilung teilt MENGEN, nie Stammdaten, und sie wirkt je Tag auf die Tagesmenge — kein Stichtag, kein Mittel, keine Interpolation. Sie wird als Satz geschrieben (alle Ziele eines Tages in einer Anfrage), sonst wären die 100 % nicht prüfbar. Ohne Zeile an einem Tag ist die Messstelle „nicht verteilt“; das ist ein Zustand, kein Fehler. Sie endet mit ihrem Ziel und wandert nie still auf einen Nachfolger. Es gibt keine dynamischen Schlüssel: kein Anteil aus Messwerten, Flächen, Stückzahlen oder Betriebsstunden.

**Beispiel (Referenzunternehmen Ahrenberg).** Druckluft MS-07 im Oktober 2026: 70 % an 4100 Spritzguss (11 130 kWh), 30 % an 4200 Montage (4 770 kWh).

**Heute im Code.** Heute nicht vorhanden (`kostenstellen_anteile` steht bisher nur im Referenzunternehmen). Die Regeln stehen als Vertrag in `docs/contracts/v2/verteilung.md` samt Vektoren; Tabelle und Dialog kommen mit AP-10 IP-8/IP-15.

**Abgrenzung.** Nicht die Prozess-Zuordnung (die hat keinen Anteil), nicht die Formel einer berechneten Messstelle (die summiert, statt zu teilen), nicht eine Umlage nach Schlüssel.

## Berechnete Messstelle

*Sicht: Zustand · Nachtrag AP-10 §4.1 (E1, E5)*

**Eine Messstelle, deren Wert aus anderen Werten entsteht — mit genau einem Formel-Typ und einer tagesgenau gültigen Fassung.**

Drei Typen: die gewichtete Summe (Terme mit Vorzeichen und Faktor), der Rest (die Bilanzdifferenz eines Hauptzählers, je Tag aus der Stellung abgeleitet) und der Saldo (Bezug minus Abgabe derselben Grenze). Der Typ entscheidet die Richtung des Ergebnisses; sie wird nie aus Vorzeichen abgeleitet. Ein berechneter Wert trägt dieselben vier Angaben wie ein gemessener — Zustand, Abdeckung, Kennzeichen, Version — und zusätzlich seine Herkunft mit jedem Eingang. Die Formel ist zeitgültig in Tagesfassungen; Fassung n + 1 beendet Fassung n am Vortag, nichts wird überschrieben.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-19 „Netzbezug gesamt Unternehmen“ = MS-01 + MS-10 + MS-16 = 174 400 kWh im Oktober 2026 (3 von 3 Systemen).

**Heute im Code.** Gebaut ist die gewichtete Summe (`messstelle_formel_term`, `docs/contracts/v2/messstelle-formel.md`). Die Typen `rest` und `saldo` und die Fassungen stehen als Vertrag in `bilanz.md` und in `messstelle-formel.md` §0/§6; den Code ziehen AP-10 IP-3/IP-4 nach.

**Abgrenzung.** Nicht die Kennzahl (die teilt durch eine Bezugsgröße, AP-11), nicht der Messkanal (der wird gelesen, nicht gerechnet), nicht der Ersatzwert (der steht für einen fehlenden Messwert).

## Kennzahl

*Sicht: Organisation · Nachtrag AP-11 §4.1 (E1, E2, E5)*

**Ein eigenes Objekt, das Mengen teilt: Menge je Bezugsgröße, Teil am Ganzen oder Summe durch Summe über Kennzahlen — mit Zustand, Richtung, Fassung und Version.**

Eine Kennzahl hat ein Kennzeichen (KZ-0001), genau einen Geltungsbereich, einen Verantwortlichen und einen Zweck. Ihre Berechnung lebt in tagesgültigen Fassungen, ihr Wert je Periode in Versionen. Sie summiert nie selbst (Summen sind Gesamtwerte) und mittelt nie Quotienten: eine Unternehmenszahl aus Gebäuden ist Summe durch Summe. Eine Zahl gibt es nur mit Menge UND Bezugsgröße und einer Bezugsgröße ungleich 0; ist ein Eingang unvollständig, steht die Richtung dabei (mindestens, höchstens).

**Beispiel (Referenzunternehmen Ahrenberg).** KZ-0001 Halle 2 im Oktober 2026: 6 100 kWh ÷ 41 000 Stück = 0,15 kWh je Stück; KZ-0003 Unternehmen: (6 100 + 3 600) ÷ (41 000 + 7 200) = 0,20 kWh je Stück.

**Heute im Code.** Heute nicht vorhanden; das Wort benennt bisher den Aggregat-Schritt der Eigenen Auswertung (AP-11 W7). Die Regeln stehen als Vertrag in `docs/contracts/v2/kennzahl.md` samt Vektoren (`kennzahl-vectors.json`, Zwillinge `uems/KennzahlRegeln` ⟷ `uemsKennzahl.ts`, AP-11 IP-1/IP-3); Tabellen, Rechenlauf und Fläche kommen mit AP-11 IP-4 ff.

**Abgrenzung.** Nicht die Messstelle (die misst oder summiert, sie teilt nicht), nicht der Gesamtwert (eine berechnete Messstelle), nicht die Bezugsgröße (der Nenner), nicht ein Mittelwert.

## Kennzahlvorlage

*Sicht: Organisation · Nachtrag AP-11 §4.12 (E9)*

**Ein Katalog-Eintrag, der das Anlegen einer Kennzahl vorbelegt: Rechenform, Name, Zweck und die Erwartung an Menge und Bezugsgröße.**

Eine Vorlage ist nie selbst eine Kennzahl und hat keine Fassungen. Aus ihr entsteht eine Kennzahl mit neuem Kennzeichen und Fassung 1; Eingänge und Geltungsbereich werden immer neu gebunden. Wer eine bestehende Kennzahl kopiert, übernimmt Form, Name und Zweck ebenso — und bindet ebenso neu.

**Beispiel (Referenzunternehmen Ahrenberg).** Aus „Stromeinsatz je Stück — {Geltungsbereich}“ legt Peter Hollerbach KZ-0002 für die Montagehalle Lindach an.

**Heute im Code.** Heute nicht vorhanden. Die Regel für Vorlage und Kopie steht in `docs/contracts/v2/kennzahl-vectors.json` (K20); der Katalog `kennzahl-vorlagen.json` kommt mit AP-11 IP-10.

**Abgrenzung.** Nicht die Zuordnungs-Vorlage eines Imports (die deutet eine Datei), nicht eine Kundenvorlage mit eigenen Fassungen (E9, nicht gewählt).

## Bericht

*Sicht: Organisation · Nachtrag AP-12 §4.1 (E1, E8, E9)*

**Ein eigenes Objekt aus Berichtsvorlage, Geltung (Standort oder Unternehmen) und Zeitraum (Monat oder Jahr) — mit genau einem Entwurf und null bis n freigegebenen Berichtsständen.**

Ein Bericht zitiert nur die Welt der Messstellen: Messstellen, Kostenstellen-Energie, Bezugsgrößen und Kennzahlen, jede Zahl mit Zustand, Version und Herkunft. Sein Entwurf bildet sich neu, wenn sich eine Quelle ändert; ein Berichtsstand bleibt, wie er freigegeben wurde. Je Vorlage, Geltung und Zeitraum gibt es genau einen Bericht.

**Beispiel (Referenzunternehmen Ahrenberg).** BR-2026-0001, Monatsbericht Werk Ahrenberg Oktober 2026: Berichtsstand Nr. 1 am 10.11.2026, Nr. 2 (Revision) am 16.11.2026.

**Heute im Code.** Heute nicht vorhanden; es gibt nur den Geräte-Export ohne Stand. Die Regeln stehen als Vertrag in `docs/contracts/v2/bericht.md` samt Vektoren (`bericht-vectors.json`, Zwillinge `uems/BerichtRegeln` ⟷ `uemsBericht.ts`, AP-12 IP-1/IP-3); Tabellen, Routen und Fläche kommen mit AP-12 IP-4 ff.

**Abgrenzung.** Nicht der Export (der zitiert nichts und hat keinen Stand), nicht die Erlöse-Karte (keine Berichtsquelle, E3), nicht der freie Zeitraum des Lese-Modells.

## Berichtsvorlage

*Sicht: Organisation · Nachtrag AP-12 §4.5 (E9)*

**Ein Katalog-Eintrag von VoltPilot mit Fassungsnummer, der Geltung, Zeitraum, Vergleichszeiträume und die festen Abschnitte eines Berichts festlegt.**

Es gibt vier Vorlagen: Monats- und Jahresbericht je Standort und je Unternehmen. Der Kunde wählt Vorlage, Geltung, Zeitraum und abgewählte Kennzahlen — sonst nichts. Eine neue Fassung einer Vorlage ändert keinen Berichtsstand; der nächste Entwurf nennt die neue Fassung.

**Beispiel (Referenzunternehmen Ahrenberg).** Monatsbericht Standort, Fassung 1: Kopf · Zusammenfassung · Verbrauch je Messstelle · Tagesverlauf · Kennzahlen · Qualität · Quellenverzeichnis.

**Heute im Code.** Heute nicht vorhanden. Der Katalog steht in `docs/contracts/v2/bericht-vorlagen.json` (vier Vorlagen, AP-12 IP-1); ausgeliefert wird er ab AP-12 IP-5.

**Abgrenzung.** Nicht die Kennzahlvorlage (die legt eine Kennzahl an), nicht ein freier Berichtsdesigner (E9, nicht gewählt).

## Berichtsstand

*Sicht: Organisation · Nachtrag AP-12 §4.3 (E1, E2, E5)*

**Der freigegebene, unveränderliche Inhalt eines Berichts zu einem Datenstand: eine Kopie mit Prüfsumme, Nummer, Person und Freigabe-Zeitpunkt.**

Er entsteht nur, wenn eine Person mit Recht den Entwurf freigibt — der Zeitraum ist zu Ende, jeder Wert endgültig und der Entwurf aktuell. Er wird nie geändert und nie gelöscht und hält jede Zahl mit ihrem Nachweis selbst fest, auch wenn die Messdaten ihre Aufbewahrung überschritten haben. Ändert sich eine Quelle später, bekommt er einen Anstoß; der nächste Stand ersetzt ihn, er bleibt lesbar.

**Beispiel (Referenzunternehmen Ahrenberg).** BR-2026-0001 Nr. 1 nennt MS-12 mit 6 100 kWh in Version 1 — auch 2036, wenn die Zeilen der Speicherklasse gelöscht sind.

**Heute im Code.** Heute nicht vorhanden. Die Form steht in `docs/contracts/v2/bericht.schema.json` (Abzug, Stand); die Tabelle kommt mit AP-12 IP-4.

**Abgrenzung.** Nicht die Version eines Werts (die gehört der Zahl), nicht der Entwurf (der bildet sich neu), nicht eine Datei (PDF und CSV werden aus ihm erzeugt).

## Revision

*Sicht: Organisation · Nachtrag AP-12 §4.9 (E6, E7)*

**Ein neuer Berichtsstand, der den gültigen ersetzt — immer die Freigabe einer Person nach einem Anstoß, nie automatisch.**

Eine Korrektur, ein Ersatzwert oder eine rückwirkende Änderung der Struktur trifft einen freigegebenen Berichtsstand, wenn sie eine seiner Quellen in seinem Zeitraum ändert. Der Stand bleibt unverändert und zeigt „Revision nötig“; der Entwurf nennt jede Abweichung. Ein Anstoß kann mit Begründung verworfen werden.

**Beispiel (Referenzunternehmen Ahrenberg).** Die Korrektur K-2026-0007 stößt Nr. 1 an („Revision nötig — Korrektur K-2026-0007“); Ines Kaltenbach gibt am 16.11.2026 Nr. 2 frei, drei Abweichungen.

**Heute im Code.** Heute nicht vorhanden. Die Regeln stehen in `docs/contracts/v2/bericht.md` (Betroffenheit, Anstoß, Abweichung); Anstoß-Tabelle und Kaskaden-Naht kommen mit AP-12 IP-4/IP-8.

**Abgrenzung.** Nicht die Korrektur eines Werts (die macht eine neue Version einer Zahl), nicht das Zurücknehmen einer Freigabe (gibt es nicht).

## Datenstand

*Sicht: Organisation · Nachtrag AP-12 §4.6 (E4)*

**Der Zeitpunkt, zu dem ein Berichtsentwurf oder Berichtsstand aus den Daten gebildet wurde — alle einbezogenen Werte sind älter.**

Der Datenstand ist eine Aussage über die Daten, die Freigabe eine über eine Person; beide stehen im Kopf eines Berichts. Ändert sich eine Quelle nach dem Datenstand, ist der Entwurf veraltet und bildet sich neu; eine Freigabe mit einem veralteten Datenstand wird abgelehnt. An einer Anlage sagt dasselbe Wort, wie aktuell ihre Daten sind — dieselbe Bedeutung an einem anderen Gegenstand.

**Beispiel (Referenzunternehmen Ahrenberg).** Berichtsstand Nr. 2: Datenstand 12.11.2026 10:05 (MEZ), freigegeben 16.11.2026 14:20 von Ines Kaltenbach.

**Heute im Code.** Für Berichte heute nicht vorhanden. Die Regeln stehen in `docs/contracts/v2/bericht.md` (Datenstand, D1–D5, AP-12 IP-1/IP-3).

**Abgrenzung.** Nicht der Freigabe-Zeitpunkt, nicht „endgültig ab“ eines Werts, nicht die Berechnungszeit einer einzelnen Zahl.

## Quellenverzeichnis

*Sicht: Organisation · Nachtrag AP-12 §4.4 (E3, E6)*

**Die Liste aller Objekte, aus denen ein Bericht seine Zahlen hat — unmittelbar, mittelbar oder als Vergleich, je mit ihrem Zeitraum.**

Das Quellenverzeichnis entscheidet, welche Änderung einen Bericht trifft: Zeitraum mal Quellen, nie der Standort oder ein Name. Mittelbare Quellen (die Eingänge berechneter Messstellen, Kostenstellen und Kennzahlen) stehen mit darin, damit eine Korrektur auch den Unternehmensbericht erreicht.

**Beispiel (Referenzunternehmen Ahrenberg).** BR-2026-0001: 19 Einträge von BZ-4 bis MS-15, darunter KZ-0001 und KZ-0005.

**Heute im Code.** Heute nicht vorhanden. Die Form einer Zeile steht in `docs/contracts/v2/bericht.schema.json` (Quelle); die Tabelle kommt mit AP-12 IP-4.

**Abgrenzung.** Nicht die Quellenbindung einer Messstelle (die verbindet Messstelle und Messkanal), nicht die Herkunft eines Werts (die erklärt eine einzelne Zahl).

## Werte

*Sicht: Zustand · Nachtrag AP-13 §4.1 (E9, E15)*

**Der Abschnitt einer Messstelle, in dem ihre Zahlen für einen Zeitraum stehen: Karte, Liste, Verlauf und Vergleich.**

Jede Zahl steht mit Zustand, Verlauf, Fassung, Kennzeichen und Version so, wie sie gebildet wurde; fehlt eine Zahl, steht ein Strich mit dem Satz ihres Grundes, nie eine 0. Die Zeiten stehen in der Zeitzone des Standorts, und der Kopf nennt sie. Jeder Weg zur Zahl einer Messstelle — aus dem Register, einer Übersicht, einer Kennzahl oder einem Bericht — endet hier, mit Zeitraum und Version.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-10 Netzbezug Halle 2 am 03.11.2026: 2.304 kWh · vollständig (Menge aus Zählerständen) · Verlauf 85 % · vorläufig — Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg).

**Heute im Code.** Die Tages- und Monatskarte öffnet als Dialog an der Messstelle (`frontend/portal/src/uemsWerteKarte.ts`); als Abschnitt der Messstellen-Seite kommt sie mit AP-13 IP-3. Das Wort: `frontend/portal/src/glossar.ts` (`UEMS_WERTE`).

**Abgrenzung.** Nicht der Reiter „Messwerte“ einer Anlage (Bestand, Verdichtung in Berlin-Zeit), nicht der Register-Verlauf eines Geräts.

## Verlauf

*Sicht: Zustand · Nachtrag AP-13 §4.1 (E5, E15)*

**Die Zeichnung der Werte über einen Zeitraum — Tag in Viertelstunden, Woche in Stunden, Monat in Tagen, Jahr in Monaten.**

Jeder Schritt zeigt Farbe und Wort seines Zustands; ein Schritt ohne Werte ist eine Lücke ohne Linie und ohne Null, eine Folge davon eine Fläche mit Satz. „Verlauf n %“ an einer Zahl sagt, welcher Anteil der erwarteten Werte angekommen ist — das ist nicht die Vollständigkeit der Menge: ein Tag kann vollständig gemessen sein und trotzdem „Verlauf 85 %“ tragen. Dasselbe Wort wie der Bereich „Verlauf“ einer Anlage, dieselbe Bedeutung.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-10 am 03.11.2026: 96 Viertelstunden, 14:00–17:31 als Lücke mit dem Satz „Lücke von 14:00 bis 17:31 — nie als 0 gerechnet“; die Karte sagt „vollständig (Menge aus Zählerständen) · Verlauf 85 %“.

**Heute im Code.** Das Wort und die Form des Abzeichens: `frontend/portal/src/glossar.ts` (`UEMS_VERLAUF`, `UEMS_VERLAUF_PROZENT` = `satz.abdeckung` in `docs/contracts/v2/ergebnis-zustand-vectors.json`); das Raster je Zeitraum: `frontend/portal/src/uemsOberflaechen.ts` (`verlaufRaster`). Die Zeichnung kommt mit AP-13 IP-4.

**Abgrenzung.** Nicht die „Abdeckung“ der Bestandsflächen (Viertelstunden einer Anlage), nicht eine Hochrechnung, nicht ein freier Von–Bis-Zeitraum.

## Vergleich

*Sicht: Zustand · Nachtrag AP-13 §4.1 (E6, E15)*

**Die Werte einer Messstelle neben ihrer Vorperiode oder ihrem Vorjahr — oder neben bis zu zwei weiteren passenden Messstellen.**

Gegen die eigene Vorperiode steht die Differenz in kWh und Prozent, gemessen an der neuesten Version des Vergleichswerts; fehlt der Vergleichswert, steht sein Grund, nie eine 0. Zwischen zwei Messstellen gibt es keine Differenz — ein Unterschied zweier Zähler sagt nichts über einen von beiden. Passend sind Messstellen mit gleicher Größe, Richtung, Einheit und Wertart; bei den anderen nennt die Auswahl, warum nicht.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-12 im November 2026 gegen Oktober 2026 (Version 2): +260 kWh (+4,3 %). MS-06 und MS-11 (Spritzguss) nebeneinander; MS-21 ist nicht passend (Volumen in m³).

**Heute im Code.** Die Regel „passend“: `frontend/portal/src/uemsOberflaechen.ts` (`passend`); die Differenz rechnet der Bericht-Zwilling `frontend/portal/src/uemsBericht.ts` (AP-12). Das Wort: `frontend/portal/src/glossar.ts` (`UEMS_VERGLEICH`, dasselbe Wort wie die Vergleichsquelle). Die Fläche kommt mit AP-13 IP-5.

**Abgrenzung.** Nicht die Vergleichsquelle (eine zweite Quelle derselben Größe an EINER Messstelle, AP-04), nicht ein Benchmark gegen andere Unternehmen.

## Datenlage

*Sicht: Zustand · Nachtrag AP-13 §4.1 (E13, E15)*

**Wie viele Messstellen einer Ebene Daten liefern — „15 von 16 Messstellen liefern Daten“, EINE Zählung je Ebene.**

Gezählt wird aus dem Messstellen-Register: berechnete Messstellen zählen mit, eine Messstelle ohne Datenquelle steht im Nenner, manuell abgelesene werden als Zusatz genannt („· 1 manuell abgelesen“). Schweigen ist nie rot: eine Messstelle, die nicht liefert, sagt seit wann.

**Beispiel (Referenzunternehmen Ahrenberg).** Unternehmen Ahrenberg, Oktober 2026: Werk Ahrenberg „15 von 16“, Werk Lindach „4 von 4“.

**Heute im Code.** Die Zählung: `frontend/portal/src/uemsZustand.ts` (`aggregatLiefertDaten`); die Wörter: `frontend/portal/src/glossar.ts` (`UEMS_DATENLAGE`, `UEMS_MANUELL_ABGELESEN`). Der Baustein der Übersicht und dieselbe Zählung an der Karte „Funktionen“ kommen mit AP-13 IP-7.

**Abgrenzung.** Nicht der Online-Status einer Anlage oder Box, nicht die Vollständigkeit einer Zahl, nicht „Verlauf n %“.

## Grund (einer fehlenden Zahl)

*Sicht: Zustand · Nachtrag AP-13 §4.10 (E11)*

**Der Satz, warum an einer Stelle keine Zahl steht — je Grund genau einer.**

Die Karte zeigt den Strich UND den Satz. Der Satz nennt nur, was das System weiß: keine Quelle, eine Quelle, die den Zeitraum nur zum Teil deckt, ein Zeitraum, der noch nicht gerechnet ist, eine Version, die es nicht gibt — nie eine Ursache, die niemand festgestellt hat, und nie eine Störung.

**Beispiel (Referenzunternehmen Ahrenberg).** MS-21 Gas Heizung Verwaltung, Oktober 2026: „— · keine Werte“ und „Keine Quelle: MS-21 Gas Heizung Verwaltung hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0.“

**Heute im Code.** Acht Sätze als Vertrag: `docs/contracts/v2/ergebnis-zustand.md` §9 (Block `grund`, 1.11), gesprochen von `frontend/portal/src/uemsErgebnis.ts` und `services/api/src/main/java/com/voltpilot/api/uems/ErgebnisZustand.java` (`grundSatz`). An der Karte sprechen sie mit AP-13 IP-6.

**Abgrenzung.** Nicht ein Fehler oder eine Störung, nicht der Zustand „keine Werte“ (der sagt, DASS keine Zahl da ist), nicht die Gründe einer Kennzahl (eigener Vertrag).
