# Erzeuger: Anlagensteuerung als Gerät mit Erzeugungseinheiten (EZ-6 „Cloud-Modell“)

Neu am 21.10.2026, Paket EZ-6 aus dem Konzept „Erzeuger am Wago-Modbus-Server“ (Fassung 12, §4.2/§4.4/§4.11,
Entscheide EW-3 A, EW-11 A, EW-17 A). Eine PV- oder Biogas-BHKW-Anlage, deren Steuerung (z. B. WAGO PFC200) das
VoltPilot-Registerbild Erzeuger trägt, ist **keine neue Anlagenart und bekommt keinen Reiter**: die Steuerung
ist ein Gerät wie heute die WAGO-Steuerung der Energiekarten, Wechselrichter und Motoren sind ihre Teile.

## Was es gibt

- **Migration `V20261021193000__erzeuger_anlagensteuerung.sql`:** `geraet_teil.teilart` `erzeugungseinheit`
  (Identität Gerät + `te_nr` 1 … 10, `einheit_art`, `nennleistung_kw`, `registry_unit_id` = MaStR-SEE, `typ_bild`);
  `registerbild_fassung` (Soll je Steuerung, zeitgültig, Bildart `erzeuger`: Basis, FC, Wortfolge, `te_anzahl`,
  `anlagenart`, `steuerung_kennung`, `rse_stufen`, `veraltet_netzpunkt_s`); `anlage_netz_vermarktung`
  (Direktvermarkter + Kanal, Einspeisemanagement, Namen aus dem Bild). Je RLS, FORCE RLS, Standortzaun, Offboarding.
- **Komponententyp `anlagensteuerung`** (`entitytypes/catalog.json`): nur messen, nicht composed, ohne
  Standardkanäle — EINE Komponente bindet die Punkte an die Datenquelle (`measurement_point.data_source_id`).
- **Katalog:** Familie `voltpilot.erzeuger_registerbild_v1`, Quelle `sources/voltpilot/erzeuger-registerbild-v1.json`
  (Katalog-README „Erzeuger-Registerbild“); Java-Zwilling des Vokabulars `erzeuger/ErzeugerRegisterbild`.
- **Routen** (`AnlagensteuerungController`, openapi): `GET/POST /api/v1/sites/{siteId}/anlagensteuerungen`,
  `GET …/{geraetId}/werte`, `PUT /api/v1/geraete/{id}/anlagensteuerung/einheiten/{teNr}`,
  `POST /api/v1/geraete/{id}/anlagensteuerung/namen`, `GET/PUT /api/v1/sites/{siteId}/netz-vermarktung`.
- **Publisher:** `mqtt-measurement-config` Feld `erzeuger_registerbilder` (`ErzeugerRegisterbilder`,
  Vektoren `docs/contracts/v2/erzeuger-registerbilder-vectors.json`).
- **Fähigkeitswort** `erzeuger_registerbild` (seit EZ-5 gemeldet, `advertised: true`) und **Anwendung**
  `netz-und-vermarktung` (Klasse `basis`, `nav_gruppe: false`, abgeleitet aktiv mit einer Anlagensteuerung).

## Fallen

- ⚠ **Seit EZ-5 an der Box (Laufzeitstand 2026.10.21.1).** Die Familie kam als Inhaltsstand mit
  `NOCH_NICHT_AN_DER_BOX`; mit dem Box-Leser fiel der Eintrag, Palette und Metadaten-Migration
  (`V20261021234700`) führen die 33 Punkte, die api bietet sie an. Wirksam mit dem Box-Release: ab dem
  api-Deploy lehnt eine Box mit älterer Palette jede Mess-Konfiguration ab (`unsupported_catalog`) — api-Deploy
  und Box-Release gehören zusammen · [Box-Leser](uems-erzeuger-registerbild-box.md).
- ⚠ **Mischbetrieb über das Fähigkeitswort, zweimal.** Angelegt wird nur, wenn die Box, die die Datenquelle
  liest, `erzeuger_registerbild` meldet (sonst 409; `GET` sagt `einrichtung.moeglich`). Der Publisher sendet
  `erzeuger_registerbilder` nur an so eine Box: der Go-Core liest mit `DisallowUnknownFields` und verwürfe das
  ganze Dokument. Darum liegt das Beispiel-Dokument in der Vektor-Datei, NICHT unter
  `examples/mqtt-measurement-config.valid*.json` (die liest `geteilter_punkt_test.go`).
- ⚠ **`erzeuger.te[*]` mit index = TE-Nr. (1-basiert).** Offset `28+index*10+feld` = 38 + (TE-Nr. − 1) · 10.
  Konkrete Schlüssel `erzeuger.te[2].t_p_ist_w`; die Feldnamen sind die der Vorlage, unverändert.
- ⚠ **Kopf ist kein Messwert** außer `te_anzahl`, `programmstand`, `steuerung_id`, `anlagenart`; Signatur,
  Prüfwert, Version, Herzschlag prüft die Box. Namen ab `beschreibung_ab` sind keine Messpunkte.
- ⚠ **Vorbelegung, nie Überschreiben.** Namen aus dem Bild landen in `typ_bild` bzw. `*_bild`; nur eine leere
  Anzeige wird gefüllt. Der Netzbetreiber bleibt am Netzanschluss — eine Abweichung ist ein Hinweis
  (`netzbetreiber_abweichung`, `netzbetreiber_nicht_eingetragen`), keine Schreibung.
- ⚠ **Controllerwechsel:** Karten brauchen die Entscheidung `karten_uebernommen`, Erzeugungseinheiten ziehen
  ohne sie mit allen Angaben um (`ZaehlerwechselService`, `GeraetRepository.karteWechseln`).
- ⚠ **Nicht in die Energiebilanz:** der Typ hat keine Kanäle; die Werte gehen weder in Topologie noch Hausbilanz
  (wie ein Selbstbau-Gerät), bis EZ-17 das ausdrücklich koppelt.
- ⚠ **`werte` ohne Wert = `keine_daten`, nie 0;** `aktuell` nur mit Qualität `good` und höchstens 120 s alt.

## Programmstand (EZ-16)

- Ist = Messpunkt `erzeuger.kopf.programmstand` (Kopf-Register 7, JJMM), Soll = `registerbild_fassung.programmstand_soll`
  (Migration `V20261021233000`); NULL heißt „folgt der Bibliothek“ = `erzeuger/Programmstand.BIBLIOTHEK`. Diese
  Konstante bei jeder freigegebenen Fassung der SPS-Bibliothek anheben, bis EZ-3 (eigenes Repository, EW-13 B) sie liefert.
- Vergleich nur im Server (`Programmstand.vergleiche`): `aktuell` · `aelter` · `unbekannt` (kein Wert, `0xFFFF`,
  kein JJMM — nie 0). Route: Feld `programmstand` an jeder `Anlagensteuerung`; `warnen` ist der Kandidat für EZ-11.
- Portal: `src/programmstand.ts` (nur Sätze), Zeile in der Karte „Gerät“ (`GeraetHerkunft`, nur Controller, die
  in `…/anlagensteuerungen` stehen) und Grund „Programm“ in `SteuerWarum` (Prop `programmstand`; ein aktueller
  Stand spricht dort nicht; beim Erzeuger hinter „Daten“). `AnlagenPage` lädt ihn einmal je Steuerung
  (`erzProgrammstand`, nicht im Takt) und reicht ihn über `ErzeugerZeile.programmstand` durch.

## Nachfolger

EZ-5 (Box-Leser, gebaut: Laufzeitstand 2026.10.21.1, `advertised: true`, Budget-Klasse in
`measurement-budget-vectors.json`, Go-`Config.Erzeugerbilder` für `erzeuger_registerbilder`), EZ-7 (`erzeuger_vorgabe`), EZ-8/EZ-10
(Portal-Ansichten auf diesen Routen), EZ-15 (Anlege-Schritt mit Probe `erzeuger_kopf`), EZ-16 (Programmstand).
