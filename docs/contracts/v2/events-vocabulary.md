# Ereignis-Vertrag Box → Cloud und das geschlossene Ereignis-Vokabular (UEMS AP-07 IP-3)

Stand 11.09.2026 · Umschlag 2.1 · `events.raw` 1.0 · Vokabular 1.0 · Bezug: AP-07 §4.5, §4.8,
§4.9, §5.2 und der Captain-Entscheid **E11 = A** vom 10.09.2026 („EIN Ereignis-Vertrag für
beide Pfade — nie gelöscht“), dazu AP-04 E2, AP-05 E6, AP-06 E5/E7/E9 und der
[Herkunftsvertrag](./messwert-herkunft.md).

Dieser Vertrag sagt, **welche Ereignisse es gibt** (ein geschlossenes Vokabular von 34 Arten),
**wer sie melden darf**, **worauf sie sich beziehen**, **wie ihre Zeit zu lesen ist**, **wie
eine VoltPilot-Box sie an die Cloud schickt** und **in welcher Form jedes Ereignis — von der
Box oder von der Cloud selbst — auf Redpanda liegt**, bevor es in die nie gelöschte
Ereignis-Tabelle je Mandant geht (IP-8).

| Datei | Rolle |
|---|---|
| [`mqtt-events-2.1.schema.json`](./mqtt-events-2.1.schema.json) | der Umschlag Box → Cloud auf `ems/{tenant_id}/{site_id}/{device_id}/v2/events` |
| [`events-raw.event.schema.json`](./events-raw.event.schema.json) | das Redpanda-Ereignis `events.raw` (beide Wege, ein Ereignis je Datensatz) |
| [`events-vocabulary-vectors.json`](./events-vocabulary-vectors.json) | das Vokabular (je Art Urheber, Bezug, Zeit, Felder, Fortschreibung, Kundensatz) und 132 Fälle im Referenzunternehmen Ahrenberg |
| [`events-vocabulary.schema.json`](./events-vocabulary.schema.json) | JSON Schema 2020-12 der Vektor-Datei |
| `services/api/.../uems/EreignisVokabular.java` | die reine PRÜFUNG: angenommen oder verworfen mit Grund |
| `services/api/.../uems/EreignisVokabularVectorsTest.java` | Schema, Vokabular ⟷ Klasse ⟷ beide Schemas, jeder Fall, Referenzunternehmen, Herkunfts- und Datenquellen-Vektoren, Bestand des Writers |
| `frontend/portal/src/uemsEreignis.ts` (+ `.test.ts`) | der KUNDENSATZ je Ereignis — dieselben Sätze wie die Vektor-Datei |
| `services/ingest/.../EventsContractSchemaTest.java` | Umschläge und Beispiele gegen beide Schemas (der Prüfnachweis „Schema-Tests Ingest“) |
| `services/timescale-writer/.../EreignisVokabular.java` (+ `EreignisVokabularZwillingTest`) | der WRITER-ZWILLING der Prüfung (IP-8): prüft jedes `events.raw`-Ereignis vor dem Anhängen; spielt alle Fälle dieser Datei |
| `services/api/.../V20260911260000__uems_messreihe_ereignis.sql` | der Speicher (IP-8): `messreihe_ereignis` mit dem Vokabular als `messreihe_ereignis_vokabular()` — `MessreiheEreignisMigrationTest` beweist die Gleichheit |
| `services/ingest/.../BoxEventsValidator.java` (+ `BoxEventsValidatorTest`) | die Laufzeit-Prüfung des Umschlags in der Datenannahme (IP-5) — Zwilling von `pruefeUmschlag`, dieselben Umschlag-Fälle, Tabellen gegen `vokabular` |
| `services/ingest/.../EventsRawEvent.java` (+ `DatenannahmeTest`) | die `events.raw`-Datensätze beider Wege, jeder im Test gegen das Schema geprüft (§7) |
| [`examples/`](./examples/) `mqtt-events-2.1.*`, `events-raw.*` | ≥ 2 gültige + 1 ungültiges Beispiel je Schema |

**Wer eine Art, ein Feld, eine Regel oder einen Satz ändert, ändert die Java-Klasse, den
TS-Zwilling, beide Schemas UND die Vektor-Datei** — der Java-Test prüft, dass die Schemas aus
genau diesem Vokabular gebaut sind. Seit IP-8 dazu den Writer-Zwilling und, mit einer neuen
Migration, `messreihe_ereignis_vokabular()`. Bei den Box-Arten, Feldtypen, Wörtern und Gründen
gehört `services/ingest` `BoxEventsValidator`/`Grund` dazu (`BoxEventsValidatorTest` hält sie an
der Vektor-Datei).

> ⚠ **Wer schon anruft (Stand IP-5 + IP-8).** Keine Box sendet Ereignisse (erst mit einem
> Edge-Release, IP-18/IP-19). Die Datenannahme verarbeitet `…/v2/events` und schreibt ihre
> eigenen Ablehnungen seit IP-5 auf `events.raw` (§7). Die Ereignis-Tabelle `messreihe_ereignis`
> steht (§7 „Der Speicher“): der Writer schreibt `device_measurement_event` (sechs Arten, siehe §4
> „Bestand“) unverändert weiter und spiegelt jedes davon hinein; `events.raw` hängt er an. Die
> bestehenden MQTT-Verträge 2.0 sind unverändert.

## 1. Zwei Wege, ein Vertrag

```
Box ──MQTT …/v2/events (2.1)──▶ Datenannahme ──┐
                                               ├──▶ Redpanda events.raw (1.0) ──▶ Ereignis-Tabelle (IP-8)
Datenannahme · Writer · Cloud · Kunde ─────────┘       ein Ereignis je Datensatz      append-only, nie gelöscht
```

- **Weg 1 — die Box meldet** (Urheber `box`): Neustart der Box, Neustart eines Geräts,
  eingefrorene Werte, Bereichsbegrenzung, geänderter Aufbau, die Lücke aus Puffer-Verdrängung.
  Die Datenannahme prüft den Umschlag und legt je Eintrag EIN `events.raw` ab, mit `box` =
  `device_id` aus dem Topic.
- **Weg 2 — die Cloud stellt fest** (Urheber `datenannahme`, `writer`, `cloud`, `kunde`):
  Lücken aus Kadenz und Herzschlag, Nachlieferung, Doppel-Zustellung, Sequenz, Zeitfehler,
  Übergabe, Gerätegrenze, Übergänge. Diese Arten reisen NIE über MQTT.
- **Additiv:** eine ältere Box sendet auf `…/v2/events` einfach nichts; bis zum Edge-Release
  erzeugt nur die Cloud Ereignisse — der Vertrag trägt beides.

## 2. Der Umschlag Box → Cloud (`mqtt-events-2.1.schema.json`)

| Feld | Regel |
|---|---|
| Topic | `ems/{tenant_id}/{site_id}/{device_id}/v2/events`, QoS 1, nicht retained; die drei Kennungs-Segmente sind byte-gleich den Feldern `tenant_id`, `site_id`, `device_id` (sonst `kennung_abweichend`) |
| `schema_version` | `"2.1"` — die Fassung des v2-Unterbaums, die Ereignisse trägt; eine andere Fassung wird nie geraten (`fassung_unbekannt`). Eine neue Art kommt mit einer neuen Fassung; die Cloud kennt sie, bevor eine Box sie sendet |
| `sequence` | die Umschlag-Sequenz DIESES Topics je Box (eigene Outbox, FIFO); ein Sprung wird wie bei `measurement-samples` als `sequence_gap`/`sequence_reset` mit `strom = events` ausgewertet |
| `observed_at` | wann die Box den Umschlag bildete — nach der Uhr der Box, UTC; die Zeit-Prüfungen des Herkunftsvertrags (`clock_ahead` > 300 s, `too_old` > 90 Tage, `clock_jump` > 300 s) gelten für ihn wie für eine Messzeit |
| `events` | 1 bis 64 Ereignisse der Arten, die eine Box melden darf (§4, Spalte „Box“), in der Reihenfolge, in der die Box sie sah; **ohne** `box` — die Box ist das Topic |

**Der Umschlag ist die Einheit.** Eine unbekannte Fassung, eine abweichende Kennung, eine
verletzte Form oder ein verworfenes Ereignis verwirft den GANZEN Umschlag; die Datenannahme
hält das als ein `rejected` mit Grund fest (§5). Nichts wird still weggelassen, nichts auf eine
ähnliche Art abgebildet.

Zeiten sind UTC auf die Sekunde (`…Z`), die Messzeit-Semantik ist die des Herkunftsvertrags:
was die Box meldet, trägt die Uhr der Box; die Eingangszeit setzt die Datenannahme
(`events.raw.ingested_at`).

## 3. Das Ereignis

Jedes Ereignis trägt:

- **`ereignis_id`** (UUID, vom Urheber vergeben — auch von der Box). Eine Wiederholung
  (QoS-1-Zustellung, Replay) trägt dieselbe; eine **Fortschreibung** auch (unten).
- **`art`** aus dem Vokabular (§4).
- **die Zeit** — je Art eine von zwei Formen:
  - **Zeitpunkt:** `zeitpunkt`;
  - **Zeitraum:** `von` + `bis`, entweder **halboffen** `[von, bis)` (Lücke, Übergabe,
    Viertelstunde — das Ende gehört nicht dazu) oder **geschlossen** `[von, bis]` (erster und
    letzter betroffener Wert: Nachlieferung, nicht zuständige Box). `bis: null` heißt **offen**
    — nur, wo die Art es erlaubt (`data_gap`, `handover`), und **nie von einer Box**.
  - Jede Art liegt auf EINER **Achse**: **Messzeit** (was gemessen wurde, nach der Uhr der
    Box) oder **Eingangszeit** (was zugestellt wurde, nach der Uhr der Cloud — Sequenz,
    Zeitfehler, Ablehnung; AP-07 §4.5 E13 Nr. 2).
- **den Bezug** aus `box`, `datenquelle`, `komponente` + `messkanal` (= die Reihe) und
  `messstelle`. Je Art sind manche Pflicht, manche erlaubt (§4). Eine Messstelle nennt nur die
  Cloud (sie kennt die Quellenbindung zur Messzeit) — die Box kennt keine Messstellen; ein
  Messkanal ohne Komponente ist keine Reihe.
- **die Felder der Art** — geschlossen: ein Feld, das die Art nicht kennt, wird nicht still
  mitgeschleppt (`schema_verletzt`). Die Typen stehen je Feld in `vokabular.felder`. Ein
  **Messwert** (`gespeicherter_wert`, `abgewiesener_wert`) trägt immer `raw`, `decoded` und
  `qualitaet`; `decoded` ist `null`, wenn der Kanal keinen decodierten Wert liefert
  (`measurement-samples` 2.1 lässt ihn weg, etwa ein OCPP-Protokollwert) — nie weggelassen
  (`schema_verletzt`), damit ein Wert genau eine Schreibweise hat, und nie 0.

**Fortschreibung statt Änderung (append-only).** Ein offenes Ereignis wird fortgeschrieben,
nie geändert: dieselbe `ereignis_id`, dieselbe Art, derselbe Bezug, dasselbe `von`; ein
**fortschreibbares** Feld darf von leer auf einen Wert gehen — nie zurück, nie auf einen
anderen Wert, und kein Feld verschwindet (`fortschreibung_unzulaessig`). Fortschreibbar sind
bei `data_gap` `bis`, `erwartet_fehlend`, `nachgeliefert_am`, `ursache_ereignis` und der Zuwachs
(`zuwachs`, `einheit`, `stand_vor`, `stand_nach`, AP-08 IP-6), bei
`handover` `bis`. Der Speicher (IP-8) hängt die Fortschreibung an; die erste Meldung bleibt
lesbar. **Kein Ereignis wird gelöscht** (§4.9 Nr. 7) — `nie_geloescht` steht bei jeder Art.

## 4. Das Vokabular

„Box“ = die Art reist über `…/v2/events` (erst mit einem Edge-Release). „Fortschreibbar“ =
Felder, die eine Fortschreibung setzen darf.

| Art | Überschrift | Urheber | Box | Zeit · Achse | Bezug (Pflicht, + erlaubt) | Pflichtfelder | Fortschreibbar |
|---|---|---|---|---|---|---|---|
| `data_gap` | Lücke | writer · box · cloud | ja | [von, bis) · offen erlaubt · Messzeit | box (+ datenquelle, komponente, messkanal, messstelle) | `erkannt_aus` | `bis`, `erwartet_fehlend`, `nachgeliefert_am`, `ursache_ereignis`, `zuwachs`, `einheit`, `stand_vor`, `stand_nach` |
| `backfill` | Nachlieferung | writer · cloud | — | [von, bis] · Messzeit | box, datenquelle | `eingang_von`, `eingang_bis`, `anzahl` | — |
| `duplicate_conflict` | Abweichender Wert | writer | — | Zeitpunkt · Eingangszeit | box, komponente, messkanal (+ messstelle) | `messzeit`, `gespeicherter_wert`, `abgewiesener_wert`, `sequenzen` | — |
| `sequence_gap` | Datenpakete fehlen | writer | — | Zeitpunkt · Eingangszeit | box | `strom`, `sequenz_erwartet`, `sequenz_erhalten`, `anzahl` | — |
| `sequence_reset` | Paketzählung neu begonnen | writer | — | Zeitpunkt · Eingangszeit | box | `strom`, `sequenz_erwartet`, `sequenz_erhalten` | — |
| `late_arrival` | Nach Abschluss eingegangen | writer · cloud | — | [von, bis) · Messzeit | komponente, messkanal (+ box, messstelle) | `eingangszeit`, `anzahl` | — |
| `counter_reset` | Zähler zurückgesetzt | writer | — | Zeitpunkt · Messzeit | komponente, messkanal (+ box, messstelle) | `stand_alt`, `stand_neu` | — |
| `counter_overflow` | Zähler übergelaufen | writer | — | Zeitpunkt · Messzeit | komponente, messkanal (+ box, messstelle) | `stand_alt`, `stand_neu`, `messzeit_alt`, `wertebereich_modul`, `hoechstzuwachs_je_kadenz`, `kadenz_s` | — |
| `device_boundary` | Gerätegrenze | kunde | — | Zeitpunkt · Messzeit | komponente (+ messkanal, messstelle) | `anlass`, `einbau_alt`, `einbau_neu`, `eingetragen_am` | — |
| `handover` | Übergabe | cloud | — | [von, bis) · offen erlaubt · Messzeit | datenquelle | `anlass`, `box_alt`, `box_neu` | `bis` |
| `unassigned_reader` | Nicht zuständige Box | writer | — | [von, bis] · Messzeit | box, datenquelle, komponente (+ messkanal) | `anzahl` | — |
| `rejected` | Abgewiesen | datenannahme · writer | — | Zeitpunkt · Eingangszeit | box | `strom`, `grund` | — |
| `clock_ahead` | Uhr geht vor | datenannahme | — | Zeitpunkt · Eingangszeit | box | `strom`, `vor_s` | — |
| `too_old` | Zu alt | datenannahme | — | Zeitpunkt · Eingangszeit | box | `strom`, `alter_s` | — |
| `clock_jump` | Uhrsprung | datenannahme | — | Zeitpunkt · Eingangszeit | box | `strom`, `sequenz`, `sprung_s` | — |
| `box_restart` | Neustart der Box | box | ja | Zeitpunkt · Messzeit | box | — | — |
| `device_restart` | Neustart des Geräts | box | ja | Zeitpunkt · Messzeit | box, datenquelle | — | — |
| `frozen_source` | Werte eingefroren | box · writer | ja | Zeitpunkt · Messzeit | box, datenquelle (+ komponente, messkanal) | — | — |
| `range_limit` | Bereichsbegrenzung | box | ja | Zeitpunkt · Messzeit | box, datenquelle (+ komponente) | — | — |
| `layout_changed` | Aufbau geändert | box | ja | Zeitpunkt · Messzeit | box, datenquelle | — | — |
| `error_change` | Fehlermeldung | writer | — | Zeitpunkt · Messzeit | komponente, messkanal (+ box, messstelle) | `alt`, `neu` | — |
| `state_change` | Zustand | writer | — | Zeitpunkt · Messzeit | komponente, messkanal (+ box, messstelle) | `alt`, `neu` | — |
| `bitfield_change` | Statusbits | writer | — | Zeitpunkt · Messzeit | komponente, messkanal (+ box, messstelle) | `alt`, `neu` | — |
| `text_change` | Text | writer | — | Zeitpunkt · Messzeit | komponente, messkanal (+ box, messstelle) | `alt`, `neu` | — |
| `substitute` | Ersatzwert | kunde | — | [von, bis) · Messzeit | komponente, messkanal (+ messstelle) | `ersatzwert`, `methode`, `status` | — |
| `correction` | Korrektur | cloud · kunde | — | [von, bis) · Messzeit | GENAU EINER: komponente, messkanal (+ messstelle) ODER bezugsgroesse (mit `fassung_alt`, `fassung_neu`) | `korrektur`, `korrektur_art`, `status` | — |
| `verteilung_geaendert` | Verteilung geändert | kunde | — | Zeitpunkt · Messzeit | messstelle | `eingetragen_am` | — |
| `bilanz_neu_berechnet` | Bilanz neu berechnet | cloud | — | [von, bis) · Messzeit | messstelle | `ausloeser` | — |
| `bericht_freigegeben` | Bericht freigegeben | kunde | — | Zeitpunkt · Messzeit | bericht | `nr`, `datenstand`, `pruefsumme` | — |
| `bericht_revision_angestossen` | Revision angestoßen | cloud | — | Zeitpunkt · Messzeit | bericht | `nr`, `anstoss_art`, `anlass_kennung` | — |
| `bericht_entwurf_neu_gebildet` | Entwurf neu gebildet | cloud | — | Zeitpunkt · Messzeit | bericht | `datenstand` | — |
| `bericht_abgerufen` | Bericht abgerufen | kunde | — | Zeitpunkt · Messzeit | bericht | `nr`, `format` | — |
| `kennzahl_neu_gebildet` | Kennzahl neu gebildet | cloud | — | [von, bis) · Messzeit | kennzahl | `ausloeser`, `version` | — |
| `einstufung_gesetzt` | Einstufung gesetzt | kunde | — | Zeitpunkt · Messzeit | energieeinsatz | `fassung`, `einstufung`, `gruende` | — |

Die optionalen Felder, die Regeln je Art (Anzahl aus den Sequenzen, Einbau je Anlass, Schwellen
der Zeitfehler …) und die Kundensätze stehen je Art in der Vektor-Datei. Die Teil-Vokabulare:
`strom` = `telemetry` · `measurement-samples` · `events` (das Blatt des Topics); `erkannt_aus` =
`kadenz` (writer, seit AP-07 IP-9 auch cloud) · `verdraengung` (box) · `herzschlag` (cloud); Anlass einer Gerätegrenze =
`zaehlerwechsel` · `kartenwechsel` · `controllerwechsel` · `zaehler_zurueckgesetzt`; Anlass einer
Übergabe = `uebergabe` · `box_tausch`; `fehlerklasse` = die neun Klassen aus
[`data-source-vectors.json`](./data-source-vectors.json).

**Bestand.** `state_change`, `error_change`, `bitfield_change`, `text_change`,
`counter_reset` und `data_gap` schreibt der Writer HEUTE schon in `device_measurement_event`
(`V20260848000000__additional_measurement_pipeline.sql`) — das Vokabular übernimmt sie in
derselben Schreibweise; der Java-Test liest den CHECK aus der Migration.

**Überlauf (AP-08 IP-4, additiv).** `counter_overflow` ist das 24. Wort: der Writer meldet es,
wenn ein Zählerstand fällt, die Reihe Wertebereich UND Höchstzuwachs deklariert hat und der
Zuwachs plausibel ist (AP-08 Z6, E4) — dieselbe Entscheidung wie `VerbrauchRegeln.ueberlauf`.
Die Meldung trägt die Rechnung (`stand_alt`, `stand_neu`, `messzeit_alt`, `wertebereich_modul`,
`hoechstzuwachs_je_kadenz`, `kadenz_s`); die Menge bildet der Verdichtungs-Lauf trotzdem aus den
Werten und der Deklaration, nie aus der Meldung. Kein Box-Umschlag ändert sich (Writer-Art, kein
Edge-Release); die Bestandstabelle `device_measurement_event` kennt das Wort nicht und schreibt
für denselben Sprung weiter `counter_reset` (Spiegel `aus_bestand`). Migration
`V20260912220000__uems_zaehler_ueberlauf.sql`.

**Lücken-Melder (AP-07 IP-9, additiv).** Die Kadenz-Lücke und die Nachlieferung stellt der
Lücken-Melder der api fest (`uems/LueckenMelder`) — dort heißt Weg 2 `cloud`, wie schon bei
`late_arrival` (IP-13). Darum darf `backfill` auch von `cloud` kommen und `erkannt_aus = kadenz`
auch von `cloud` (`auch_urheber` in der Vektor-Datei); `writer` bleibt zulässig, keine Bedeutung
ändert sich. Schmal: `verdraengung` bleibt der Box, `herzschlag` der Cloud. Migration
`V20260913130000__uems_luecken_vokabular.sql`.

**Zuwachs über eine Lücke (AP-08 IP-6, E2 = A, additiv).** Der Zähler hat weitergezählt, während
die Werte fehlten: die Differenz der Stände um die Lücke ist GEMESSEN, aber auf keine Viertelstunde
VERTEILBAR. `data_gap` trägt sie darum als Nutzlast — `zuwachs`, `einheit`, `stand_vor`,
`stand_nach`, optional und fortschreibbar (der Lücken-Melder setzt sie mit dem Schließen). Die
vier Felder stehen **nur zusammen**, **nur an einer geschlossenen Lücke EINER Reihe**
(`komponente` + `messkanal`) und **nie von einer Box** (ihr Drahtschema kennt sie nicht);
`zuwachs` = `stand_nach` − `stand_vor` ≥ 0, `einheit` aus `vokabular.einheit_zuwachs` — die
Zählerstand-Einheiten des Größen-Katalogs der Messstellen mit ihren umrechenbaren Einheiten
(`messstelle-vectors.json`), kein freier Text. Der Zusatz im Kundensatz: „· der Zähler hat
weitergezählt: Zuwachs 337,6 kWh — nicht auf Viertelstunden verteilbar“. Die Meldung ist die
Rechnung zum Nachlesen, nie die Quelle der Menge: in welcher Periode der Zuwachs zählt, entscheidet
`VerbrauchRegeln.zaehltZu` im Verbrauchsvertrag (`verbrauch.md` §9). Migration
`V20260913170000__uems_luecken_zuwachs.sql`.

**Ersatzwert und Korrektur (AP-08 IP-12, E7/E8/E14, additiv).** `substitute` und `correction` sind
das 25. und 26. Wort — beide nur aus der Cloud, beide an EINER Reihe (`komponente` + `messkanal`),
[von, bis) auf dem Viertelstunden-Raster. **Ein Ersatzwert ist kein Messwert:** `substitute`
meldet ein Mensch (`kunde`) mit Kennung `EW-<Jahr>-<lfd. Nr.>`, Methode aus
`vokabular.ersatzwert_methode` (a `gleichmaessig_verteilen` · b `profil_vorperiode` · c
`profil_vergleichsquelle` · d `ablesestand_nachtragen` · e `wert_eingeben` · f
`vorperiode_uebernehmen` · g `vergleichsquelle_uebernehmen`) und Status `wirksam` ·
`zurueckgenommen`. `correction` trägt `K-<Jahr>-<lfd. Nr.>`, `korrektur_art`
(`nachlieferung_nach_endgueltigkeit` · `ablesestaende_nachgetragen` · `umklassifizierung` ·
`ersatzwert` · `wert_berichtigt` · `menge_nachgetragen` — der Nachtrag der Tagesmenge an einem Tag, der vor
AP-08 IP-5 schon endgültig war, nur als Vorschlag des Systems über den Korrekturweg) und Status `vorschlag` · `freigegeben` · `abgelehnt` ·
`zurueckgenommen`; `ersatzwert` genau bei der Art `ersatzwert`. **Nie automatisch (E14):** die
Cloud meldet nur `vorschlag`. **Jeder Statuswechsel ist eine NEUE Meldung** mit eigener
`ereignis_id` — nie eine Fortschreibung, denn ein Status wird nicht nachgetragen, sondern
entschieden. Welche Methode einen gemessenen Zuwachs verteilt (a–c, Summe = Zuwachs) und welche
nur ohne ihn steht (e–g), trägt das Vokabular als Merkmal `zuwachs`; erzwungen wird es in der
Tabelle `messreihe_ersatzwert` (die Meldung nennt nur Methode und Stand). Kundensatz etwa
„Ersatzwert EW-2026-0003 für 03.11.2026 14:00 bis 04.11.2026 09:30: Zuwachs gleichmäßig verteilen —
kein gemessener Wert“; die Namen der Methoden und Arten stehen in der Vektor-Datei, der Satz
spricht nie das Vertragswort. Dieselben Wörter prüfen die Tabellen über
`messreihe_korrektur_vokabular()`. Migration `V20260913190000__uems_korrektur_ersatzwert.sql`.

**Berichtigung eines Bezugsgrößen-Werts (AP-09 IP-7, F4, additiv).** `correction` trifft seitdem GENAU
EINEN Bezug: die Reihe (`komponente` + `messkanal`, wie bisher) ODER die Bezugsgröße — `bezugsgroesse`
(ihr Kennzeichen zur Zeit der Meldung) mit `fassung_alt` und `fassung_neu` (die wirksame Fassung des Werts
vorher und nachher, `fassung_neu` > `fassung_alt`) und optional `import` (`I-<Jahr>-<lfd. Nr.>`, erst mit
AP-09 IP-13). Die Kennung ist dann der Vorgang der Berichtigung `BK-<Jahr>-<lfd. Nr.>` (Tabelle
`bezugsgroesse_berichtigung`), die Art immer `wert_berichtigt`, [von, bis) die Periode des Werts
(Mitternacht in der Zeitzone des Standorts — auf dem Viertelstunden-Raster). Gemeldet wird NUR die wirksame
Fassung ≥ 2 (`freigegeben`, Urheber `kunde`): ein Erstwert meldet nichts, ein offener Vorschlag auch nicht.
Die Listen des Vokabulars nennen darum keinen der beiden Bezüge als Pflicht; was dem gewählten Bezug fehlt,
ist `schema_verletzt` wie zuvor („Pflichtfeld komponente“), beides zugleich oder Fassungen an einer Reihe sind
`regel_verletzt` — jede Meldung, die vorher angenommen oder verworfen wurde, bleibt es mit demselben Grund.
Kundensatz etwa „Korrektur BK-2026-0001 freigegeben für 01.10.2026 00:00 bis 01.11.2026 00:00: Wert berichtigt
(mit Beleg) · Bezugsgröße BZ-2, Fassung 1 → 2“. Migration `V20260915010000__uems_bezugswert_berichtigung.sql`,
Schreibweg `uems-bezugswert-eingeben.md` (Wegweiser).

**Verteilung geändert (AP-10 IP-8, E11/E12, additiv).** `verteilung_geaendert` ist das 27. Wort und
das erste, dessen Bezug NUR die Messstelle ist — eine Verteilung auf Kostenstellen hängt an keiner
Reihe, darum stehen `komponente` und `messkanal` nie darin (die Regel „Messstelle nur mit der ganzen
Reihe“ gilt für jede Art, deren Pflicht-Bezug die Messstelle nicht ist). Nur `kunde`; `zeitpunkt` =
Beginn des ersten Tags der neuen Verteilung (00:00 in der Zeitzone des Unternehmens), `eingetragen_am`
davor oder danach. Eine Meldung je Schreibvorgang von `PUT …/messstellen/{id}/verteilung`, derselbe
Satz noch einmal meldet nichts; die Zeilen stehen in `messstelle_verteilung`
(`V20260913230000__uems_messstelle_verteilung.sql`, [`verteilung.md`](./verteilung.md)).

**Bilanz neu berechnet (AP-10 IP-11, additiv).** `bilanz_neu_berechnet` ist das 28. Wort: die
Korrektur-Kaskade (AP-08 IP-17) hat die Bilanz-Werte EINER Messstelle für [von, bis) neu berechnet — die
Versionen einer berechneten Messstelle oder die verteilten Werte einer gemessenen, die in diesen Tagen auf
Kostenstellen verteilt ist. Nur `cloud` (gerechnet hat das System; die Entscheidung eines Menschen meldet
`correction`), Bezug NUR die Messstelle, Pflicht `ausloeser` = die Korrektur `K-…` oder der Ersatzwert
`EW-…`. Eine Meldung je Messstelle und Anlass-Fassung, in derselben Transaktion wie die Versionen; die
Kennung ist abgeleitet, eine Wiederholung schreibt nichts. Gelesen werden die Werte über
`GET /api/v1/unternehmen/kostenstellen/{id}/energie` (Migration `V20260914140000__uems_bilanz_neu_berechnet.sql`).

**Berichte (AP-12 IP-4, additiv).** `bericht_freigegeben`, `bericht_revision_angestossen`,
`bericht_entwurf_neu_gebildet` und `bericht_abgerufen` sind das 29. bis 32. Wort — eingelöst aus dem Block
`reserviert` (unten). Alle vier: Zeitpunkt auf der Messzeit-Achse, Bezug NUR der Bericht (`bericht` =
`BR-<Jahr>-<Nr.>`, sechster Schlüssel von `kennungen`). Freigabe (Pflicht `nr`, `datenstand`, `pruefsumme` =
`sha256:` + 64 Hex-Ziffern) und Abruf (Pflicht `nr`, `format` = ein Wort von `bericht_format`: `pdf` · `csv`)
meldet eine Person (`kunde`); den Anstoß (Pflicht `nr`, `anstoss_art` = ein Wort von `anstoss_art`, Zeile für
Zeile `bericht-vectors.json`, `anlass_kennung`; optional `anlass_fassung`) und die Neubildung des Entwurfs
(Pflicht `datenstand`, optional `anlass_kennung`) erkennt das System (`cloud`). Der Datenstand liegt nie nach dem
Zeitpunkt. Person und Teilansicht eines Abrufs stehen in der Tabelle `bericht_abruf`, nicht in der Meldung.
Geschrieben werden sie erst von AP-12 IP-7 bis IP-11 (Migration `V20260915050100__uems_bericht_ereignisse.sql`).

**Kennzahl neu gebildet (AP-11 IP-8, additiv).** `kennzahl_neu_gebildet` ist das 33. Wort und löst die
Reservierung aus AP-11 IP-1 ein: die Korrektur-Kaskade (später auch der Nenner- und der Definitions-Auslöser,
AP-11 IP-9) hat einen ENDGÜLTIGEN Kennzahl-Wert als Version n + 1 neu gebildet; [von, bis) ist die Periode dieses
Werts (erster Tag 00:00 bis zum Tag nach dem letzten Tag 00:00 in der Zeitzone des Unternehmens). Nur `cloud`,
Bezug NUR die Kennzahl — `kennzahl` ist der siebte Schlüssel von `kennungen` (Kennzeichen `KZ-…`), eine
Messstelle nennt die Meldung nie —, Pflicht `ausloeser` = die Korrektur `K-…` oder der Ersatzwert `EW-…` (seit AP-11
IP-9 auch die Berichtigung eines Bezugsgrößen-Werts `BK-…`, die rückwirkend geänderte Berechnung als Kennzahl mit
Fassung `KZ-0004/Fassung-2` oder das rückwirkende Stammdatum als Bezugsgröße mit Tag `BZ-8/ab-2027-01-01`; ein bloßes
Kennzeichen wie `MS-12` bleibt `regel_verletzt`) und
`version` = die neue Version (mindestens 2, sonst `regel_verletzt`). Version 1 bildet der Regellauf ohne Meldung;
vorläufige Werte, die ohne neue Version nachziehen, meldet niemand. Kundensatz etwa „Kennzahl KZ-0001 neu gebildet
für 01.10.2026 00:00 bis 01.11.2026 00:00: Version 2 nach K-2026-0007“ (Migration
`V20260915061500__uems_kennzahl_neu_gebildet.sql`).

**Reserviert (AP-11 IP-1, additiv — KEIN Wort des Vokabulars).** Der Block `reserviert` der
Vektor-Datei nennt, was spätere Pakete anlegen: `correction` mit Bezug `bezugsgroesse` (AP-09 IP-7 —
eine wirksame Fassung ≥ 2 oder die Rücknahme eines Bezugsgrößen-Werts; gelesen vom Nenner-Auslöser der
Kennzahl-Kaskade AP-11 IP-9, der NUR Kennzahlen und Berichte neu bildet, keine Messreihen-Stufe) und
`kennzahl_neu_gebildet` (Urheber `cloud`, Bezug die Kennzahl; AP-11 IP-8 — ein endgültiger Kennzahl-Wert
wurde als Version n + 1 neu gebildet, Pflicht der Anlass). `correction` mit Bezug `bezugsgroesse` ist seit AP-09 IP-7 angelegt (siehe
„Berichtigung eines Bezugsgrößen-Werts“), `kennzahl_neu_gebildet` seit AP-11 IP-8 (siehe „Kennzahl neu gebildet“; bis dahin
kannte es weder `vokabular.arten` noch die Tabelle noch eine Prüfung, eine Meldung damit wurde abgelehnt). Wer einen Eintrag anlegt, trägt
ihn in `vokabular.arten` ein (Migration nach dem höchsten ausgelieferten Stand); `KennzahlVectorsTest`
prüft, dass Reservierung und Anlage sich nicht widersprechen. Vertrag der Kennzahl:
[`kennzahl.md`](./kennzahl.md).

**Reserviert für die Berichte (AP-12 IP-1, additiv — KEIN Wort des Vokabulars).** Vier Einträge im Block
`reserviert`, alle mit Bezug `bericht` (die Kennung BR-…, beim Stand mit seiner Nummer): `bericht_freigegeben`
(Urheber `kunde` — eine Person gibt einen Entwurf frei, Berichtsstand Nr. n), `bericht_revision_angestossen`
(`cloud` — ein gültiger Stand bekommt einen Anstoß, bleibt aber byte-gleich), `bericht_entwurf_neu_gebildet`
(`cloud` — Pfad 1 oder 2 hat den Entwurf neu gebildet; ein Abruf, der neu bildet, meldet nichts) und
`bericht_abgerufen` (`kunde` — PDF oder CSV eines Stands, nie eines Entwurfs). Seit AP-12 IP-4 sind sie
angelegt (siehe „Berichte“); die Reservierung bleibt als Herkunft stehen. `BerichtVectorsTest` hält die Liste gleich
`BerichtRegeln.EREIGNISSE_RESERVIERT`; `KennzahlVectorsTest` prüft weiter nur die Reservierungen der Kennzahl.
Vertrag des Berichts: [`bericht.md`](./bericht.md).

**Energetische Bewertung (AP-16 IP-3/IP-11).** `einstufung_gesetzt` ist seit IP-11
angelegt: Bezug `energieeinsatz` (EE-…), Urheber `kunde`, Pflicht Fassung,
Einstufung und Gründe K1–K4. Der unveränderliche Herkunftssatz und die Begründung
stehen an der Fassung; Zahlen allein erzeugen nie die Meldung. `messbedarf_erfasst` und
`messbedarf_eingeloest` (Bezug `messbedarf`, Anlage IP-19/IP-20) haben jeweils Urheber
`kunde`. Eine Person erfasst/löst einen Messbedarf ein. Diese beiden stehen weiter nur
im Block `reserviert`; bis zu ihrer Anlage lehnen die bestehenden Prüfer sie ab.

**Reserviert für die Bezugsbasis (AP-17 IP-6).** `bezugsbasis_freigegeben` (Urheber `kunde`,
Anlage IP-8), `bezugsbasis_beendet` (`kunde` oder `cloud` — die Archivierung der Kennzahl
beendet die Basis; Anlage IP-8/IP-17) und `bezugsbasis_anstoss` (`cloud`, Kaskade oder
Struktur-Läufer; Anlage IP-15), alle mit Bezug `bezugsbasis` (BB-…). Sie stehen nur im Block
`reserviert`; noch kein Schreiber und kein Eintrag in `vokabular.arten` oder der
Ereignis-Tabelle. Bis zur Anlage lehnen die bestehenden Prüfer diese Wörter ab.

**Der Kundensatz** je Art (Überschrift + Satz, gewählt nach Anlass bzw. danach, ob der Zeitraum
offen ist, plus Zusätze gesetzter Felder) spricht Zeiten in der Zeitzone des Standorts, Zahlen
deutsch und Namen aus dem, was die Fläche kennt — etwa „Zählerwechsel am 18.11.2026 10:40:
Z-5a → Z-5b, Endstand 1.083.415,2 kWh, Anfangsstand 0 kWh“ oder „Übergabe von Box Halle 1 an
Box Halle 2 (neu): keine Werte von 10.04.2027 07:30 bis 07:31“. Eine Ursache nennt er nur, wenn
ein Feld sie trägt: `counter_reset` sagt „(Ursache unbekannt)“, bis der Kunde sie mit einer
Gerätegrenze bestätigt.

## 5. Die Prüfung — Reihenfolge und Gründe

`EreignisVokabular.pruefe(ereignis, urheber)` · `pruefeUmschlag(topic, umschlag)` ·
`pruefeFortschreibung(alt, neu, urheber)`:

1. **Umschlag** (nur über MQTT): Fassung → Form → Kennung → jedes Ereignis wie unten, mit
   `box` aus dem Topic und nur den Feldern, die eine Box senden darf.
2. **Art** bekannt — sonst `wort_unbekannt`.
3. **Urheber** darf die Art melden — sonst `urheber_unzulaessig`.
4. **Felder**: Pflicht da, nichts Fremdes, jeder Wert von seinem Typ — sonst `schema_verletzt`.
5. **Wörter** der Teil-Vokabulare bekannt — sonst `wort_unbekannt`.
6. **Zeit**: Ende nach bzw. nicht vor dem Beginn, offen nur wo erlaubt und nie von der Box,
   volle Minute (Gerätegrenze, Übergabe), Viertelstunden-Raster (`late_arrival`) — sonst
   `zeit_ungueltig`.
7. **Regeln der Art** — sonst `regel_verletzt`.
8. **Fortschreibung** — sonst `fortschreibung_unzulaessig`.

Dieselben Wörter trägt `rejected.grund`; der Kundentext vollendet „Datenpaket von … abgewiesen: …“:

| Grund | stellt fest | Kundentext |
|---|---|---|
| `herkunft_unvollstaendig` | Writer | Herkunft unvollständig — Gerät oder Einstellung zur Messzeit unbekannt |
| `fassung_unbekannt` | Datenannahme | unbekannte Fassung des Datenpakets |
| `kennung_abweichend` | Datenannahme | es nennt eine andere Box, Anlage oder einen anderen Kundenbereich |
| `schema_verletzt` | Datenannahme | Aufbau des Datenpakets nicht lesbar |
| `wort_unbekannt` | Datenannahme | unbekanntes Wort — verworfen, nie geraten |
| `urheber_unzulaessig` | Datenannahme | diese Meldung kommt nie von diesem Absender |
| `zeit_ungueltig` | Datenannahme | unmögliche Zeitangabe |
| `regel_verletzt` | Datenannahme | die Angaben widersprechen sich |
| `fortschreibung_unzulaessig` | Datenannahme | es würde eine frühere Meldung ändern |

`herkunft_unvollstaendig` ist das Wort des Herkunftsvertrags (§4 dort) — dieser Vertrag schließt
das Grund-Vokabular, das jener offengelassen hat, und übernimmt es unverändert.

## 6. Ereignis oder Zustand?

Die Bausteine aus AP-04/05/06, einzeln eingeordnet:

- **Fehlerklassen je Quelle (AP-06 E5)** sind **Zustand** — sie reisen im Herzschlag je
  Datenquelle (`data_sources[]`, IP-13) und beantworten „warum liefert diese Quelle gerade
  nichts?“. Zwei tragen zusätzlich ein Ereignis: **`layout_changed`** ist Klasse UND Ereignis
  (der Augenblick, in dem die Box den geänderten Aufbau sah — dasselbe Wort); **`box_meldet_sich_nicht`**
  ist die einzige Ursache, die eine Herzschlag-Lücke (`data_gap`, `erkannt_aus = herzschlag`)
  tragen darf — solange die Box schweigt, kennt niemand ihren Grund. Eine Kadenz-Lücke mit
  dieser Klasse wird verworfen. Die Einordnung aller neun steht in `fehlerklassen_einordnung`.
- **`data_gap` je Box UND je Quelle UND je Reihe (AP-06 §6.2, E11):** dieselbe Art, der Bezug
  sagt die Ebene — nur `box` (der Kern bekommt so seine Lücke je Box), `box` + `datenquelle`,
  `box` + Reihe (+ Messstelle). Die heutige `_pipeline`-Zeile des Writers bleibt für
  Bestandskunden lesbar.
- **Übergabe „Box A → Box B“ (AP-06 E9)** ist `handover` mit `anlass = uebergabe`; der
  **Box-Tausch (AP-06 E7)** derselbe Zuständigkeitswechsel mit `anlass = box_tausch`. Die kurze
  Lücke ist der Zeitraum [Wechsel, Quittung).
- **Gerätegrenze (AP-04 E2)** ist `device_boundary`, vom Kunden eingetragen, rückwirkend
  erlaubt, nie im Voraus. **Kartenwechsel und Zählerrücksetzung (AP-05 E6)** sind Grenzen OHNE
  Gerätewechsel: derselbe Einbau vorher und nachher; eine bestätigte Rücksetzung verweist mit
  `bestaetigt_ereignis` auf das `counter_reset`, das der Writer gesehen hat.
- **Box-Neustart** ist `box_restart`; der **Neustart eines Geräts** (Herzschlag im Registerbild
  springt klein) `device_restart` — beide nur von einer Box mit Edge-Release.
- **Nachlieferung (E5)** ist zweifach sichtbar: `backfill` je Box und Quelle, und das
  Lücken-Ereignis bekommt `nachgeliefert_am` — es bleibt stehen. **`late_arrival`** heißt:
  der Rohwert kam nach der Endgültigkeit des Viertelstundenwerts, der unverändert bleibt.
- **Wiederholung** (dasselbe Paket zweimal) ist KEIN Ereignis — sie wird nur gezählt (§4.5
  Duplikate Nr. 1).

## 7. Das Redpanda-Ereignis `events.raw` (`events-raw.event.schema.json`)

Ein Datensatz je Ereignis, Schlüssel `{tenant_id}:{site_id}` (die Ereignisse einer Anlage
bleiben geordnet), `schema_version` 1.0 (ein neuer Ereignis-Vertrag). `event_id` ist die
Kennung des Datensatzes (Nachverfolgung), die Identität des Ereignisses ist
`ereignis.ereignis_id`. `urheber` sagt den Weg; bei `box` sind `device_id`, `source_topic`,
`sequence` und `observed_at` des Umschlags Pflicht und `ereignis.box` = `device_id`.
`ingested_at` ist die Eingangszeit.

**Der Speicher (IP-8).** `messreihe_ereignis` hängt jedes angenommene Ereignis als EINE Zeile je
Meldung an — eine Fortschreibung ist eine weitere Zeile mit derselben `ereignis_id`, die jüngste
(`eingang` = `ingested_at`) ist der Stand. Idempotenz-Schlüssel ist der Fingerabdruck der ganzen
Meldung ohne Eingangszeit: ein erneut zugestellter Datensatz (neue `event_id`, gleiches Ereignis)
erzeugt keine zweite Zeile. Der Bezug steht wörtlich (`kennungen`) und, wo eindeutig, aufgelöst
(UUID-Form wörtlich, `DQ-n`/`MS-n` über die Kennzeichen des Kundenbereichs; Komponenten haben dort
kein Kennzeichen — auf `events.raw` sollte `komponente` die `entity_id` sein, sonst bleibt nur die
Kennung). Verworfen wird, was diese Prüfung verwirft — gezählt mit dem Grund, nie gespeichert.

**Was die Datenannahme schreibt (IP-5, `services/ingest`).** Weg 1: je Eintrag eines
angenommenen Umschlags ein Datensatz wie oben (`BoxEventsValidator`, Zwilling von
`EreignisVokabular.pruefeUmschlag` über dieselben Umschlag-Fälle). Weg 2 mit Urheber
`datenannahme` für alle drei Uplinks (`telemetry`, `measurement-samples`, `events`):

- Die Umschlag-Felder (`device_id`, `source_topic`, `sequence`, `observed_at`) FEHLEN — der Bezug
  steht im Ereignis: `box` = `device_id` aus dem Topic (die mTLS-geprüfte Identität, auch wenn der
  Umschlag eine andere nennt), `strom` = Blatt des Topics, `sequenz` = Sequenz des Umschlags, wenn
  lesbar (nie geraten). `zeitpunkt` = Eingangszeit auf die Sekunde.
- **Gebündelt je Umschlag, Art und Grund:** ein `rejected` je Grund, ein `clock_ahead`, ein
  `too_old` — mit `anzahl` = nicht weitergereichte Werte (Samples, Kern-Kanäle, Box-Ereignisse;
  fehlt, wenn der Umschlag unlesbar war) und bei Zeitfehlern der GRÖSSTEN Abweichung als
  `vor_s`/`alter_s`. Eine Box mit falscher Uhr hinterlässt so ein Ereignis je Umschlag, nicht je Wert.
- **Die Einheit:** Fassung, Form und Kennung des Umschlags verwerfen den ganzen Umschlag (ein
  `rejected`); bei `telemetry`/`measurement-samples` verwirft ein fehlerhafter oder unplausibler
  WERT nur sich selbst, der Rest geht weiter; bei `events` bleibt der Umschlag die Einheit (§2).
  Ist die Messzeit des Umschlags selbst unplausibel, geht die Uhr der Box falsch — dann wird kein
  Wert angenommen.
- **`ereignis_id`** ist eine Namens-UUID aus Topic, Umschlag-Bytes, Art und Grund: dieselbe
  Zustellung zweimal (QoS 1, Wiederholung nach einem Redpanda-Fehler) trägt dieselbe Kennung;
  `zeitpunkt`/`ingested_at` sind die der jeweiligen Zustellung. ⚠ Der Speicher (oben) erkennt
  eine Wiederholung nur an der GLEICHEN Meldung — die zweite Zustellung unterscheidet sich im
  `zeitpunkt` und wird als `fortschreibung_unzulaessig` verworfen und gezählt; gespeichert bleibt
  genau die erste.
- **Belegt gegen den Verbraucher:** [`datenannahme-events-vectors.json`](./datenannahme-events-vectors.json)
  — je Art und Grund, den die Datenannahme erzeugt, ein Umschlag und die Nachrichten daraus;
  `services/ingest` `DatenannahmeVektorenTest` erzeugt genau sie, `services/timescale-writer`
  `DatenannahmeNachrichtenTest` nimmt jede mit Rahmen und Vertrag an.
- **Fehlt das Topic `events.raw`** (vergessen beim Deploy), sendet die Datenannahme nicht blind
  dorthin: auf `telemetry`/`measurement-samples` stehen die Ablehnungen nur im Log (Zähler
  `voltpilot.ingest.events.undelivered`), die Werte laufen weiter; der Box-Umschlag wird erst
  angenommen, wenn es das Topic gibt (die persistente Sitzung hält ihn beim Broker).
- **`clock_jump` schreibt die Datenannahme NICHT:** er vergleicht aufeinanderfolgende Umschläge
  derselben Box, die zustandslose Datenannahme sieht immer nur einen. Offen für den Writer, der
  die Sequenz je Box ohnehin auswertet (IP-7/IP-9) — mit einer Erweiterung der Urheber dieser Art.

## 8. Die Fälle

132 Fälle, jede Art mit mindestens einem angenommenen, jeder Grund mit mindestens einem
verworfenen Fall; A = mit `annahme` (siehe §9).

| Gruppe | Fälle |
|---|---|
| Ausfall Box Halle 2, 03.11.2026 (Referenz) | Lücke je Box / je Quelle DQ-4 / je Reihe MS-10 (offen) · Box-Tausch E-2 → E-2′ am 04.11. (A: Quittungszeit) · Fehlerklasse ohne Herzschlag verworfen · Fortschreibung verschiebt Beginn/Ende verworfen · Variante ohne Rückkehr: geschlossen am 04.11. 09:40 ohne Nachlieferung (A) · vom Lücken-Melder der api (`cloud`, IP-9): Reihen-Lücke offen, geschlossen mit Nachlieferung, `backfill` (A), `verdraengung` von der Cloud verworfen |
| Rückkehr 17:30 und Nachlieferung, A1/A3/A4 (Referenz) | Nachlieferung 3 640 Werte · Lücke MS-10 nachgeliefert 17:31 · 188 Datenpakete fehlen (falsche Anzahl verworfen) · Paketzählung neu · MS-10 nach Abschluss eingegangen (A: Puffer der reparierten Box; Raster verletzt verworfen) |
| Zählerwechsel MS-06, 18.11.2026 10:40 (Referenz) | Z-5a → Z-5b mit Ständen · Lücke 10:40–10:47 mit Ursache · gleicher Einbau / nicht auf der Minute / im Voraus / von der Box verworfen · abweichender Wert 10:39 (gleicher Wert verworfen) |
| Abweichender Wert am Ladepunkt MS-14 (A) | zweiter OCPP-Zählerstand ohne decodierten Wert (`decoded: null`) · `decoded` fehlt ganz verworfen |
| Übergabe DQ-3, 10.04.2027 07:30 (Referenz) | offen bis zur Quittung · Quittung schließt · an dieselbe Box / nicht auf der Minute / Ende vor Beginn verworfen · Rückgabe 12.04. (A) · nicht zuständige Box 07:32 (über eine Stunde verworfen) |
| Kartenzähler-Rücksetzung EK-3 (A) | `counter_reset` 6 184,37 → 0 · bestätigt als Grenze ohne Gerätewechsel · mit Gerätewechsel / steigender Stand verworfen |
| Überlauf Impulszähler K-6/MS-07, 20.10.2026 (F7, AP-08 IP-4) | `counter_overflow` 64 954 → 185 (767 ≤ 1 667) · Sprung 12 457 → 100 über dem Höchstzuwachs verworfen |
| Ersatzwert und Korrektur MS-10/MS-11 (F10, F11, F12, F21, AP-08 IP-12) | EW-2026-0003 gleichmäßig verteilt · zurückgenommen · EW-2026-0005 nach Profil der Vergleichsquelle · K-2026-0007 vorgeschlagen (cloud) · freigegeben · K-2027-0002 Ablesestände vorgeschlagen · Korrektur zum Ersatzwert (A: K-2026-0008) · Freigabe von der Cloud / Wochentagsmittel / vom Writer / neben dem Raster / Art Ersatzwert ohne Ersatzwert verworfen |
| Verteilung MS-07 ab 15.01.2027 (F13, AP-10 IP-8) | 60/40 rückwirkend eingetragen am 20.01. · im Voraus eingetragen · von der Cloud / an einer Reihe verworfen |
| Korrektur MS-17, 18.10.2026 (F14, AP-10 IP-11) | Rest MS-22 neu berechnet · verteilte Werte MS-17 neu berechnet (A: K-2026-0011) · von einem Menschen / ohne Korrektur-Kennung / an einer Reihe verworfen |
| Korrektur MS-12, Oktober 2026 (K7, AP-11 IP-8) | KZ-0001 Version 2 · KZ-0003 Version 2 in derselben Kaskade (A: K-2026-0007) · von der Box / vom Writer / von einem Menschen / ohne Auslöser / Version 1 / ohne Kennzahl / an einer Messstelle / ohne Korrektur-Kennung verworfen |
| Box-Umschläge (A) | Neustart bei Wandlertausch 01.02.2027 · neue Karte EK-7 01.03.2027 · Bereichsbegrenzung EK-3 · Werte eingefroren · Puffer verdrängt · Übergabe von der Box / unbekannte Art / Kennung / Fassung 2.0 / ohne Kennung / offene Lücke / leer verworfen |
| Datenannahme | Box Lindach 14 min vor · genau 300 s ist kein Ereignis · 91 Tage alt · Uhrsprung · ohne Einbau (Writer) · unbekanntes Wort · unbekannter Grund / `herkunft_unvollstaendig` von der Datenannahme verworfen |
| Übergänge (A) | Statusbits EK-3 · Zustand, Fehlermeldung, Text am Ladepunkt · unverändert / fremdes Feld verworfen |

## 9. Widersprüche und Annahmen

Wo Konzept und Referenzdatei auseinanderlaufen, gewinnt für Kennzeichen, Seriennummern und
Zeitpunkte die Referenzdatei; eine Erfindung steht im Fall als `annahme` (und ein erfundenes
Kennzeichen oder ein erfundener Messkanal zusätzlich in `erfunden`).

1. **Ausfall Box Halle 2 am 03.11.2026 — aufgelöst (Referenzdatei 1.1, wie Herkunftsvertrag §7
   Nr. 1).** Die Referenz erzählt jetzt EINE Folge: Ausfall 14:00, Rückkehr 17:30 mit
   Nachlieferung 17:31–17:34, Tausch E-2 → E-2′ am 04.11.2026 09:38. Nachlieferung
   (`backfill`), Lücke mit `nachgeliefert_am` und die Sequenz-Fälle stehen damit ohne
   `annahme`. Als `annahme` bleiben die Lücke „bis 04.11. 09:40 ohne Nachlieferung“ (die
   Variante ohne Rückkehr aus dem Wortlaut von AP-06 A5) und `late_arrival` am 12.11. (§4.8
   „Puffer der reparierten Box“).
2. **Übergabe DQ-3 an „Box Halle 2“** — die Referenz nennt E-2′ (E-2 ist seit 04.11.2026
   ausgebaut); die Fälle folgen der Datei. Die Quittungszeiten (09:40 beim Box-Tausch, 16:01 bei
   der Rückgabe) nennt die Referenz nicht; 09:40 ist dort die erste Lesung.
3. **Kartenzähler-Rücksetzung: EK-2 oder EK-3?** AP-07 §4.8 schreibt „EK-2“, AP-05 A8 und der
   Referenzdatensatz nennen EK-3 (K-8.3, MS-12); die Fälle folgen AP-05. Den Tag nennt keine
   Quelle — angenommen ist der 02.11.2026 (der Stand passt zum Oktoberwert von MS-12).
4. **Urheber von `counter_reset`.** AP-05 §6.3 nennt „Urheber Box“, AP-07 §4.8 „Writer (wie
   heute)“; das Vokabular folgt §4.8 — der Writer sieht den fallenden Stand an der Reihe, eine
   Box-Meldung wäre ein zweiter Beleg desselben Sprungs.
5. **Ein fünfter Urheber.** Der Auftrag nennt Box/Writer/Cloud/Kunde; §4.8 und der
   Herkunftsvertrag nennen die Datenannahme (Ingest) als Urheber der Uhr- und
   Ablehnungs-Ereignisse. Das Vokabular führt sie als `datenannahme` — sie ist Cloud, aber nicht
   der Writer. Die Herzschlag-Lücke hat §4.8 unter „Writer“; ihr Fakt (`box_meldet_sich_nicht`,
   AP-06 E5 „von Cloud“) liegt aber in der übrigen Cloud — deshalb `cloud` mit `erkannt_aus =
   herzschlag`.
6. **„Anteil vollständig“** (§4.8 `backfill`) reist als `anzahl` und `erwartet`; der Anteil
   ist `anzahl / erwartet` und wird nie gerundet (§4.9 Nr. 6).
7. **C-1-Neustart 12.05.2026** (§4.8, AP-05 Bogen C2) liegt vor der Einrichtung von AN-2
   (01.10.2026); der Box-Neustart-Fall liegt deshalb am 01.02.2027 (Wandlertausch EK-2, Referenz)
   mit angenommener Uhrzeit.
8. **Messkanäle ohne Referenz** (Statuswort, Zustand, Fehlercode, Anzeigetext) nennt die
   Referenz nicht — sie führt je Komponente nur Energie- und Leistungskanäle; die Übergangs-Fälle
   nennen sie in `erfunden`.
9. **Technische Kennungen.** Die Referenz nennt keine UUIDs; `kennungen` in der Vektor-Datei
   legt sie für Kundenbereich, Anlagen und Boxen fest (nur für Umschläge und Beispiele).

## 10. Was dieser Vertrag nicht regelt

Die Lücken-Erkennung aus Kadenz und Herzschlag (IP-9), `clock_jump` (§7), den Writer (IP-7), die Ereignis-Tabelle mit RLS, Grants und
Offboarding (IP-8), die Endgültigkeit der Viertelstundenwerte (IP-12/IP-13), die Blöcke
`data_sources[]` (IP-13) und `supports[]` (IP-18) und das Senden auf der Box (IP-18/IP-19,
Edge-Release). Die Kern-Telemetrie 2.0 und `measurement-samples` 2.0 bleiben unverändert.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='EreignisVokabularVectorsTest')      # rein, kein Docker
(cd services/ingest && ./mvnw test -Dtest='EventsContractSchemaTest,BoxEventsValidatorTest,DatenannahmeTest')  # rein
(cd frontend/portal && npx vitest run src/uemsEreignis.test.ts)
```

### Ablesungen: Lücke und Berichtigung (AP-09 IP-8)

`data_gap` darf bei einer manuell abgelesenen Messstelle ohne Box, Komponente und
Messkanal stehen: Urheber ausschließlich `cloud`, Bezug `messstelle`, `erkannt_aus = kadenz`.
Die monatliche Ablesung wird strikt nach zwei Kalendermonaten überfällig. Eine spätere
Ablesung schließt dasselbe Ereignis; es entstehen keine Nullwerte oder Tagesmengen.
Kanalgebundene Lücken behalten ihre bisherigen Pflichtbezüge und Urheberregeln.

`correction` erlaubt zusätzlich den Bezug `messstelle` ohne Komponente/Messkanal,
wenn `korrektur_art = ablesestaende_nachgetragen` ist. Die Kennung bleibt `K-…`;
`fassung_alt` und `fassung_neu` dürfen gemeinsam die Rohwertfassungen nennen.
Die bestehende Freigabe-/Rücknahmekette und ihre nachgelagerten Periodenversionen gelten.

### Import-Korrekturen (AP-09 IP-13)

Bei einer Bezugsgröße darf `korrektur` zusätzlich
`I-<Jahr>-<Nr.>/Zeile-<n>/Fassung-<m>` tragen. `import` muss dieselbe
Import-Kennung und `fassung_neu` dieselbe Fassung nennen. Jede Zeile ist damit
für die Kaskade ein eigener Anlass; Import, Wert-Fassung und Ereignis werden
in einer Transaktion geschrieben. Bestehende `BK-…`-Meldungen bleiben unverändert.
Die Fälle `import-zeile-eigener-korrektur-anlass` und `import-anlass-…-widerspricht`
pinnen die Annahme und beide Identitätswidersprüche für API und Writer; der
Portal-Zwilling prüft den vorhandenen Kundensatz mit Import-Zusatz.
