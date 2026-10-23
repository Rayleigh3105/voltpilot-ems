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

## Alarme (EZ-11, EW-9 A)

- **Leserart `erzeuger`** im Werte-Katalog (`ueberwachung/ErzeugerWerteLeser`, Auswertung rein in `ErzeugerAlarme`):
  liest nur Messpunkte und ihre Frische (`juengste`, „aktuell“ = `good` und ≤ `AKTUELL_BIS_S`), nie `erzeuger_vorgabe`.
- **Sechs Vorlagen, Kennung = Wertart** (Katalog-Block `vorlage`, nie gesät): `erzeuger.fernsteuerung_nicht_bereit`,
  `erzeuger.daten_veraltet`, `erzeuger.anlage_folgt_nicht` (Schwellen `toleranz_prozent`, `toleranz_kw`),
  `erzeuger.netzbetreiber_abgeschaltet`, `erzeuger.fernwirk_verbindung_weg`, `erzeuger.programmstand_veraltet`
  (EZ-11b: Vergleich aus EZ-16 steht 24 h auf `aelter`, Soll der Fassung vor der Bibliothek). Anlegen nur an einer Anlage mit
  Anlagensteuerung (sonst 409), ohne 30-Tage-Probelauf.
- ⚠ **„Fernsteuerung nicht bereit“ gilt je Einheit:** die Regel hängt an der Anlage, der Takt fächert sie in
  `einheit:<Steuerung>;te=<n>` auf und bündelt wie eine Auswahl.
- ⚠ **Unbekannt hält:** ein ausgelöster Erzeuger-Alarm entwarnt nicht, solange die Werte veraltet sind.
- ⚠ **„Anlage folgt nicht“ zählt nur das Überschreiten** der wirksamen Grenze (plus das SPS-Urteil `s_bits`), nie
  weniger Erzeugung unter der Grenze.

## Vorgaben (EZ-7)

Der `VorgabenLaeufer` (`erzeuger/`, Schalter `voltpilot.erzeuger.vorgaben.enabled`, Minutentakt) leitet je
Anlagensteuerung aus den Proben `erzeuger.*` die Vorgaben ab (Konzept §4.6 auf die schlanke Fassung übersetzt; Regeln
und Wörter in `VorgabenAbleitung`): `erzeuger_vorgabe` (Urheber, Art, `te_nr` leer = ganze Anlage, Ende leer =
läuft), `erzeuger_vorgabe_luecke` („n weitere Wechsel während einer Datenlücke“) und der Stand
`erzeuger_vorgabe_lauf` (Migration `V20261022013700`, zehn Jahre, RLS + FORCE + Standortzaun). Routen
(`ErzeugerVorgabenController`, openapi): `GET /api/v1/sites/{siteId}/erzeuger/vorgaben` (Chronik), `…/{vorgabeId}`
(Detail mit Rohsignalen), `…/zaehlung?raster=tag|monat`, `…/heute` (Kachel „Wer hat heute geregelt?“: `je_urheber`),
`…/vorgaben.csv`.

- ⚠ **Die Box sendet nur Änderungen** (spätestens alle 60 s, „seit“ und Zähler nur im 60-s-Takt): Werte werden
  getragen, höchstens 90 s — ein ungültiger Wert kommt nie wieder. „Seit“ datiert einen Wechsel nur, wenn das
  Ergebnis zwischen der letzten und dieser Lesung liegt; nach einem Neustart nie (es zählt ab Programmstart).
- ⚠ **Nie erfundene Zeiten:** ohne „seit“ beginnt eine Vorgabe in der Lesung, in der sie zuerst galt, und endet in
  einer Lücke bei der letzten, in der sie galt — dann `unvollstaendig`. Ein Zählerrücksprung über mehr als 120 Schritte
  ist ein Neustart: die Zahl der Wechsel ist dann unbekannt (null), nie 0.
- ⚠ **Energie nur mit Grundlage:** PV aus der Prognose (30 Tage aufbewahrt — ein Nachlauf über ältere Werte schätzt
  nichts), BHKW aus der Nennleistung der bereiten Motoren bzw. dem DV-Sollwert davor; fehlt „verfügbar“ für einen Teil
  der bindenden Zeit, bleibt die Zahl leer. Euro nur für PV über `SlotEconomics` (Biogas mit EZ-12).
- ⚠ **Stand statt Neuberechnung:** eine Vorgabe kann Jahre laufen (feste 70-%-Grenze), Proben halten 90 Tage — darum
  liegen offene Vorgaben und getragene Werte als JSON im Stand. Eine Probe, die nach dem Lauf über ihre Zeit kommt,
  bleibt eine Lücke.

## Portal-Ansichten (EZ-10)

- **Steuerung › Geräte (nur messen):** `steuerung/AnlagensteuerungKarte.tsx` — Satz „VoltPilot liest diese Anlage
  nur …“, je Einheit Soll/Ist, „folgt“ (`s_bits` der Anlage; folgt sie nicht, heißt die Einheit mit Ist > Soll
  „folgt nicht“), Bereitschaft für den Direktvermarkter mit Grund aus `t_bits` Bit 4–9 — nur mit Direktvermarkter
  (`d_kanal` ≠ 0, sonst Stammdaten).
- **Geräteseite `as-<Entität>`** (`geraetAdresse.ts`): `plantModel` gibt der Komponente ein eigenes Gerät, bevor der
  erste Wechselrichter die unverankerten Komponenten nimmt; `geraetSeite` liest Weg und Zustand aus der
  Anlagensteuerung, `geraetGesicht` nennt sie „Anlagensteuerung“ (Gattung `geraet`). Die Einheiten stehen an der
  Karte „Gerät“ (`AnlagensteuerungEinheiten`), `geraetKarte` zählt sie nie als Energiekarten.
- ⚠ **Kein Ersatzgerät „Wechselrichter“ (EZ-20):** an einer Anlage mit Anlagensteuerung bekommen die über die Box
  zusammengesetzten Netz und Haus (`grid-meter`/`house-load` ohne Pin) in `plantModel` kein Gerät `dev:<Box>`, wenn
  die Box keinen Wechselrichter meldet und kein Speicher daran hängt — der Aufbau zeigt dann nur die Steuerung.
  Die Komponenten bleiben (Energiefluss, Cockpit), ebenso ihre UEMS-Geräte `zaehler`/`sonstiges`
  (`AnlagensteuerungAnlegewegDbTest`).
- **Strom & Geld** (`NetzVermarktungFormen.tsx`): beide PUT ersetzen alles — jedes Formular schickt das Übrige
  unverändert mit.
- **Verlauf › Messwerte:** `GET …/anlagensteuerungen/{geraetId}/verlauf` (Rohwerte, Frist 90 Tage, Eimer der
  Historie); Ast `erzeuger-<geraetId>` im Explorer, Kanal = Punktschlüssel.
- ⚠ **Kein funktionales Anhängen an den Explorer-Baum aus einem Promise:** im vollen Testlauf wurde
  `setGroups((g) => [...g, …])` bei jedem Render neu angewendet (neue Identität → Abruf-Effekt ohne Ende). Die Äste
  stehen in eigenem Zustand; bis ihre Antwort da ist, behält die Auswahl einen Deep-Link auf eine ihrer Kurven.

## Einheiten als Geräte (GE-3, Konzept „Ein Gerät, ein Eintrag“, GD-2 A)

Jede Erzeugungseinheit (`geraet_teil`, `GET …/anlagensteuerungen`) steht im Aufbau als Gerät unter ihrer Steuerung
(`aufbauBaum` `einheitenUnter`, `AufbauGeraet.einheit`) und hat eine Seite im Geräteseiten-Rahmen
(`pages/EinheitSeiteSection.tsx`, Ableitung `einheitSeite.ts`, Adresse und Zustand `erzeugungseinheit.ts`). Darstellung,
kein Modell: keine Komponente, keine Messpunkte, keine Migration — die Werte kommen über die Routen der Steuerung.

- **Adresse `as-<Entität>~te-<n>`** (`geraetAdresse.einheitGeraetId`): ohne „/“, weil der Pfad am Schrägstrich trennt;
  „~“ kommt in keiner Entitäts-Kennung vor und bleibt in `encodeURIComponent` stehen. Die Entität, nicht `geraet_id`:
  die Messreihen hängen an der Komponente, nicht am Einbau. ⚠ `anlagensteuerungIdOf` gibt für eine Einheit `null`.
- **Zustand je Einheit** aus `…/werte`: ohne Antwort „unbekannt“, ohne Lesung „noch keine Daten“ und „—“ (nie 0),
  älter als 120 s „meldet sich gerade nicht“, ohne `t_bits` Bit 0 „Werte ungültig“. „aus“/„bereit“ ist in Ordnung —
  nachts stehen PV-Wechselrichter so; nur Störung, Hand/Wartung und Not-Aus brauchen Aufmerksamkeit.
- **Energie heute** aus `t_e` (Zähler, kWh): seit GE-3 liefert `…/verlauf` die Kurve additiv mit (`einheit` kWh);
  letzte minus erste Lesung des Tages, „seit HH:MM“ bei spätem Beginn, ein Rücksprung macht sie unbekannt.
- **Verweise:** Cockpit „Erzeugung im Detail“ (Blatt, `ErzeugerJetzt.einheiten[].bezeichnung` additiv),
  Steuerung › Geräte, Alarm „Fernsteuerung nicht bereit“ (`einheit:<Steuerung>;te=<n>` → `meldungEinheitLink`),
  Verlauf-Ast (`VerlaufGroup.sprunge`) und der Abschnitt Einheiten der Steuerungsseite. Wo die Fläche keine
  Geräteliste hat, holt `useBoxRef` die Box-Referenz (dieselbe Regel wie `boxRefOf`).
- ⚠ **Grenzen (GE-7, nicht beauftragt):** Tausch eines einzelnen Wechselrichters schneidet die Historie nicht (sie hängt
  an der TE-Nr.); Einheiten nachtragen oder entfernen hat keine Route.

## Anlege-Schritt „Steuerung verbinden“ (EZ-15, EW-14 A)

- **Ort:** Aufbau › Gerät hinzufügen › Katalog-Weg `anlagensteuerung` (`geraeteKatalog.ts`, Gruppe „Weitere Geräte“)
  öffnet `components/AnlagensteuerungAssistent.tsx` (nachgeladen); Regeln rein in `anlagensteuerungAssistent.ts`,
  schreibende Routen in `anlagensteuerungApi.ts` (nicht in `api`, Einstiegs-Bündel), lesend `api.anlagensteuerungen`/
  `api.netzVermarktung` (EZ-10); Wahl-Zeilen `EINSPEISEMANAGEMENT_OPTIONEN`/`KANAL_OPTIONEN` teilt er mit
  `NetzVermarktungFormen`. Bühne `e2e/anlagensteuerung-verbinden.html`.
- **Kopfprüfung:** `POST …/data-sources/{id}/reachability-check` mit `op: erzeuger_kopf` (Registerart ohne Angabe
  `input`); die Cloud reicht den Block `erzeuger_kopf` unverändert in `antwort` durch, gewertet wird nur die
  Erreichbarkeit. Weiter erst, wenn der Herzschlag zwischen ZWEI Lesungen läuft (Überlauf 65535 → 0 zählt als Lauf).
- ⚠ **Angelegt wird erst am Ende** über `POST …/anlagensteuerungen`; Netz und Vermarktung reisen dort als
  `netz_vermarktung` mit (Recht `geraet.einrichten`) und belegen NUR leere Felder — `PUT …/netz-vermarktung` verlangt
  `anlage.verwalten`, das ein Unterstützer mit „einrichten“ nicht hat. Danach Namen (`…/anlagensteuerung/namen`) und
  Alarme; scheitert eines davon, bleibt die Steuerung angelegt und der Grund steht im Abschluss.
- ⚠ **Alarme nur mit `ueberwachung.verwalten`** (gemeldet an die Rolle Kundenadministrator): ein Unterstützer sieht
  die Vorlagen nur als Vorschlag. Die Liste sind die Katalog-Vorlagen mit `nur_mit_anlagensteuerung`.
- Offen: `n_kanal`/`d_kanal` stehen nicht in der Probe — Einspeisemanagement und Direktvermarkter-Weg trägt man ein;
  „Betrieb“ im Anlage-anlegen-Fluss entfällt nur im Modus „nur messen“ (der auch die Veräußerungsform streicht).

## Messplan automatisch (EZ-18)

Ohne Mess-Auswahl kein Plan an die Box (`MeasurementConfigPublisher` liest nur `device_measurement_selection`) —
darum wählt `AnlagensteuerungMessplan` alle Punkte des Bilds (`ErzeugerRegisterbild.punkte`) für die Box, die die
Komponente ausführt (`EinmalAuftragZiel.komponente`, dieselbe Box wie `forPublishing`), mit dem Katalog-Takt und gegen
das harte Budget (`MeasurementSelectionService.automatischAuswaehlen`, Akteur `system:messplan-automatisch`).

- **Zwei Wege:** beim Anlegen in dessen Transaktion (der Controller stößt danach die Zustellung an) und im Takt des
  `MeasurementConfigReconciler` (`nachholen`, Start + 30 s, nur mit `voltpilot.provisioning.enabled`) für jede
  Steuerung, deren gerade zuständige Box für sie keine Auswahl hat — so liefern vor EZ-18 angelegte Steuerungen
  (Gore) nach dem Deploy, und nach „Zuständige Box wechseln“ bekommt die neue Box den Plan. Box-Tausch trägt die
  Zeilen selbst mit (`BoxTauschService`).
- ⚠ **Nur ohne jede Zeile:** hat die Box für die Komponente eine Auswahl (auch eine abgewählte), bleibt sie, wie
  sie ist. Je Box und Steuerung einmal: der Eintrag `messwerte_ausgewaehlt` im Protokoll der Datenquelle
  (V20261022160000) nennt gewählt/angefragt und jeden ausgelassenen Punkt mit Grund (`budget`, `nicht_im_katalog`)
  und hält das Nachholen für diese Box an.
- ⚠ **Budget knapp:** gewählt wird in Bildreihenfolge (Kopf, Anlage/Netzpunkt, NB, DV, Wirkung, Einheit 1 … n); ein
  Punkt, der das Budget überschritte, fällt aus, spätere werden weiter geprüft (10 Einheiten: 83 von 96, 600/min).
- Ohne ausführende Box (offene Übergabe) oder ohne `erzeuger_registerbild` geschieht nichts; der nächste Takt holt nach.
  Die Auswahl der bisherigen Box nach einem Wechsel bleibt stehen; `forPublishing` lässt sie dort nicht mehr durch.

## Box-Quelle der Anlagensteuerung (EZ-21)

Ohne Quelle auf der Box bindet die Palette die Komponente nicht (`binding_unavailable`, `measurement-binding.js`),
und ein Plan aus EZ-18 greift ins Leere. Darum trägt der Registry-Push an eine Box mit `anlagensteuerung_quelle` je
Steuerung einen Treiber mit dem Transport ihrer Datenquelle und den Pin `edge_source_id`
([Vertrag](../../contracts/v2/edge-entity.schema.json) `x-anlagensteuerung-driver-rule`,
[Vektoren](../../contracts/v2/anlagensteuerung-quelle-vectors.json)); `componentapply` leitet daraus eine Quelle der
Rolle `plant-controller` in `edge/sources/config` ab, ohne Katalog, und keine Bilanz, Hülle oder Selbstverdrahtung
liest sie.

- **Beim Push entstanden:** `AnlagensteuerungQuelle.fuerBox` (hinter `PushAnbindungen`, von `composePush` je Box
  gefragt) rechnet Treiber und Pin aus `data_source.adresse` und `geraet.geraete_id` — sie folgen damit einer neuen
  Adresse und der Box, die die Quelle gerade liest.
- ⚠ **Nur mit dem Wort:** eine Box ohne `anlagensteuerung_quelle` bekommt die Steuerung ohne Pin, der Treiber höchstens
  mit `data_source_id` — ein älterer Applier verweigerte sonst den GANZEN Push („nennt keine Marke“). Keine Zeile in
  `edge-capabilities.json`; nur die eigene Meldung der Box zählt.
- **Pin an der Komponente:** sonst stünde die von der Box gemeldete Quelle als „Neues Gerät gefunden“ da
  (`komponenten.ts`). Gesetzt beim Anlegen (`pinsSetzen`), nachgeholt im Takt des `MeasurementConfigReconciler`
  (`nachholen`, nur fehlende oder veraltete Pins) und sofort, wenn eine Box das Wort neu meldet
  (`nachFaehigkeitsmeldung`); danach geht der Push an die Box. Der Controller stellt nach „Steuerung verbinden“ den
  Push zu (`createEntity` pushte vor der Bindung an die Datenquelle).
- ⚠ **Zwilling des Pins:** `AnlagensteuerungQuelle.kennung` ↔ `sources.DeterministicID`; die Box setzt keinen Port und
  keine Geräte-ID ein, sonst passte die Kennung nicht mehr zum Pin.
- ⚠ **Nur portal-verwaltete Anlagen:** eine box-verwaltete Anlage wendet keinen Portal-Plan an
  (`componentapply.IsPortalManaged`) — dort braucht es erst die Übernahme.

## Zustand „liefert Daten“ (EZ-22)

Eine Steuerung hat keinen Kanal in `telemetry_v2` (`default_measure: []`), und ihre Quelle `plant-controller` liest
keine Selbstverdrahtung: die Lebendigkeit der Topologie und der Quellstatus der Box sagten deshalb immer `never`,
während die Werte ankamen. `AnlagensteuerungLesung` nimmt die jüngste Lesung der festen Abschnitte des Bilds (ohne
Spiegel) mit der Frist `AKTUELL_BIS_S` (120 s, dieselbe wie `werte` und der Kopf der Geräteseite) und setzt damit
`health` der Komponente in `TopologyService` (Aufbau, Zentrale, Kopfsatz, „braucht Aufmerksamkeit“) und `health`/
`readAt` ihrer Quelle in `/sources` (Box-Seite).

- ⚠ **Ein Gerät, eine Seite:** auch mit Pin bleibt die Steuerung das Gerät `as-<Entität>` — `plantModel` macht die
  gemeldete Quelle nicht zum Gerät, die Box-Seite zählt über dieselbe Kette (`boxGeraete.aufbauDerAnlage`, GE-4),
  `GeraetSeiteSection` leitet eine Adresse
  auf den Pin um. Sonst trug die Quelle das Gesicht eines Zählers (Katalog-Kategorie `meter`).
- **Gesicht:** Erzeugung, Netzpunkt, Anlage (`a.anlage_zustand`), wirksame Grenze mit ihrer Quelle (`wirkung.quelle_p`).

## Verlauf: Vorgaben als Ereignisse (EZ-9)

`HistoryService` hängt bei einer Anlage mit Anlagensteuerung (`VorgabenRepository.hatSteuerung`) die Vorgaben als
Ereignisarten `netzbetreiber`, `direktvermarkter`, `nicht-bereit` an (`Ereignisse.vorgaben`, Feld `vorgabe` je
Ereignis) und zählt sie „Nach Art“ (`HistoryDto.vorgaben`). Portal: `historieEreignisse.ts` (Chronik-Zeile, „Nach
Art“, je Einheit/Monat), Detail `VorgabeDetail.tsx`, Routen und CSV in `erzeugerVorgabenApi.ts`.

- ⚠ **Bytegleich für alle anderen:** `vorgabe` und `vorgaben` stehen nur bei Erzeugeranlagen in der Antwort
  (`@JsonInclude(NON_NULL)`, `UemsVerbrauchBestandsschutzTest`).
- ⚠ **Zählen nur über die Zählung:** „Nach Art“ liest `vorgaben.zaehlung` (`VorgabenZaehlung` über EINEN Abschnitt);
  die Ereignisse ab der Woche sind Tagesbündel — ihre Summe zählte eine Vorgabe über Mitternacht doppelt.
- ⚠ **Was in die Spur kommt:** Netzbetreiber und Direktvermarkter der ganzen Anlage, „nicht bereit“ je Einheit; die
  Abrufe je Einheit nur unter „je Einheit“, Automatik/Hand/Ersatzwert/Schutz nur in Chronik-Route und CSV.
- ⚠ **Zwilling:** `Ereignisse.VORGABEN_ARTEN` ↔ `historieEreignisse.ts` `VORGABEN_ARTEN`; der Client verwirft eine
  unbekannte Art still — `historieEreignisse.test.ts` liest die Arten aus `openapi.yaml`.
- ⚠ **Ohne Hausbilanz:** eine Erzeugeranlage hat meist keine Messreihe für Verlauf › Energie; `MesswerteSection`
  zeigt die Karte „Ereignisse“ trotzdem unter „Keine Messwerte“.
- ⚠ **Einstiegs-Bündel:** die Vorgaben-Routen liegen in `erzeugerVorgabenApi.ts` (lazy); die Kachel „Wer hat heute
  geregelt?“ abonniert `…/heute` über das Erzeuger-Stück (`erzeuger.ts` `heuteAbonnieren`).

## Nachfolger

EZ-5 (Box-Leser, gebaut: Laufzeitstand 2026.10.21.1, `advertised: true`, Budget-Klasse in
`measurement-budget-vectors.json`, Go-`Config.Erzeugerbilder` für `erzeuger_registerbilder`), EZ-8
(Cockpit auf diesen Routen), EZ-9 (Vorgaben im Verlauf, gebaut), EZ-15 (Anlege-Schritt, gebaut), EZ-18 (Messplan
automatisch, gebaut), EZ-21 (Box-Quelle, gebaut; wirkt erst mit dem Box-Release, das `anlagensteuerung_quelle` meldet).
