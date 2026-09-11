# Ereignis-Vertrag Box → Cloud und das geschlossene Ereignis-Vokabular (UEMS AP-07 IP-3)

Stand 11.09.2026 · Umschlag 2.1 · `events.raw` 1.0 · Vokabular 1.0 · Bezug: AP-07 §4.5, §4.8,
§4.9, §5.2 und der Captain-Entscheid **E11 = A** vom 10.09.2026 („EIN Ereignis-Vertrag für
beide Pfade — nie gelöscht“), dazu AP-04 E2, AP-05 E6, AP-06 E5/E7/E9 und der
[Herkunftsvertrag](./messwert-herkunft.md).

Dieser Vertrag sagt, **welche Ereignisse es gibt** (ein geschlossenes Vokabular von 23 Arten),
**wer sie melden darf**, **worauf sie sich beziehen**, **wie ihre Zeit zu lesen ist**, **wie
eine VoltPilot-Box sie an die Cloud schickt** und **in welcher Form jedes Ereignis — von der
Box oder von der Cloud selbst — auf Redpanda liegt**, bevor es in die nie gelöschte
Ereignis-Tabelle je Mandant geht (IP-8).

| Datei | Rolle |
|---|---|
| [`mqtt-events-2.1.schema.json`](./mqtt-events-2.1.schema.json) | der Umschlag Box → Cloud auf `ems/{tenant_id}/{site_id}/{device_id}/v2/events` |
| [`events-raw.event.schema.json`](./events-raw.event.schema.json) | das Redpanda-Ereignis `events.raw` (beide Wege, ein Ereignis je Datensatz) |
| [`events-vocabulary-vectors.json`](./events-vocabulary-vectors.json) | das Vokabular (je Art Urheber, Bezug, Zeit, Felder, Fortschreibung, Kundensatz) und 61 Fälle im Referenzunternehmen Ahrenberg |
| [`events-vocabulary.schema.json`](./events-vocabulary.schema.json) | JSON Schema 2020-12 der Vektor-Datei |
| `services/api/.../uems/EreignisVokabular.java` | die reine PRÜFUNG: angenommen oder verworfen mit Grund |
| `services/api/.../uems/EreignisVokabularVectorsTest.java` | Schema, Vokabular ⟷ Klasse ⟷ beide Schemas, jeder Fall, Referenzunternehmen, Herkunfts- und Datenquellen-Vektoren, Bestand des Writers |
| `frontend/portal/src/uemsEreignis.ts` (+ `.test.ts`) | der KUNDENSATZ je Ereignis — dieselben Sätze wie die Vektor-Datei |
| `services/ingest/.../EventsContractSchemaTest.java` | Umschläge und Beispiele gegen beide Schemas (der Prüfnachweis „Schema-Tests Ingest“) |
| [`examples/`](./examples/) `mqtt-events-2.1.*`, `events-raw.*` | ≥ 2 gültige + 1 ungültiges Beispiel je Schema |

**Wer eine Art, ein Feld, eine Regel oder einen Satz ändert, ändert die Java-Klasse, den
TS-Zwilling, beide Schemas UND die Vektor-Datei** — der Java-Test prüft, dass die Schemas aus
genau diesem Vokabular gebaut sind.

> ⚠ **Noch ruft niemand an.** Keine Box sendet Ereignisse (erst mit einem Edge-Release,
> IP-18/IP-19), die Datenannahme verarbeitet `…/v2/events` noch nicht (IP-5), und es gibt noch
> keine Ereignis-Tabelle (IP-8). Bis dahin schreibt der Writer weiter
> `device_measurement_event` (sechs Arten, siehe §4 „Bestand“). Die bestehenden MQTT-Verträge
> 2.0 sind unverändert.

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
  mitgeschleppt (`schema_verletzt`). Die Typen stehen je Feld in `vokabular.felder`.

**Fortschreibung statt Änderung (append-only).** Ein offenes Ereignis wird fortgeschrieben,
nie geändert: dieselbe `ereignis_id`, dieselbe Art, derselbe Bezug, dasselbe `von`; ein
**fortschreibbares** Feld darf von leer auf einen Wert gehen — nie zurück, nie auf einen
anderen Wert, und kein Feld verschwindet (`fortschreibung_unzulaessig`). Fortschreibbar sind
bei `data_gap` `bis`, `erwartet_fehlend`, `nachgeliefert_am`, `ursache_ereignis`, bei
`handover` `bis`. Der Speicher (IP-8) hängt die Fortschreibung an; die erste Meldung bleibt
lesbar. **Kein Ereignis wird gelöscht** (§4.9 Nr. 7) — `nie_geloescht` steht bei jeder Art.

## 4. Das Vokabular

„Box“ = die Art reist über `…/v2/events` (erst mit einem Edge-Release). „Fortschreibbar“ =
Felder, die eine Fortschreibung setzen darf.

| Art | Überschrift | Urheber | Box | Zeit · Achse | Bezug (Pflicht, + erlaubt) | Pflichtfelder | Fortschreibbar |
|---|---|---|---|---|---|---|---|
| `data_gap` | Lücke | writer · box · cloud | ja | [von, bis) · offen erlaubt · Messzeit | box (+ datenquelle, komponente, messkanal, messstelle) | `erkannt_aus` | `bis`, `erwartet_fehlend`, `nachgeliefert_am`, `ursache_ereignis` |
| `backfill` | Nachlieferung | writer | — | [von, bis] · Messzeit | box, datenquelle | `eingang_von`, `eingang_bis`, `anzahl` | — |
| `duplicate_conflict` | Abweichender Wert | writer | — | Zeitpunkt · Eingangszeit | box, komponente, messkanal (+ messstelle) | `messzeit`, `gespeicherter_wert`, `abgewiesener_wert`, `sequenzen` | — |
| `sequence_gap` | Datenpakete fehlen | writer | — | Zeitpunkt · Eingangszeit | box | `strom`, `sequenz_erwartet`, `sequenz_erhalten`, `anzahl` | — |
| `sequence_reset` | Paketzählung neu begonnen | writer | — | Zeitpunkt · Eingangszeit | box | `strom`, `sequenz_erwartet`, `sequenz_erhalten` | — |
| `late_arrival` | Nach Abschluss eingegangen | writer | — | [von, bis) · Messzeit | komponente, messkanal (+ box, messstelle) | `eingangszeit`, `anzahl` | — |
| `counter_reset` | Zähler zurückgesetzt | writer | — | Zeitpunkt · Messzeit | komponente, messkanal (+ box, messstelle) | `stand_alt`, `stand_neu` | — |
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

Die optionalen Felder, die Regeln je Art (Anzahl aus den Sequenzen, Einbau je Anlass, Schwellen
der Zeitfehler …) und die Kundensätze stehen je Art in der Vektor-Datei. Die Teil-Vokabulare:
`strom` = `telemetry` · `measurement-samples` · `events` (das Blatt des Topics); `erkannt_aus` =
`kadenz` (writer) · `verdraengung` (box) · `herzschlag` (cloud); Anlass einer Gerätegrenze =
`zaehlerwechsel` · `kartenwechsel` · `controllerwechsel` · `zaehler_zurueckgesetzt`; Anlass einer
Übergabe = `uebergabe` · `box_tausch`; `fehlerklasse` = die neun Klassen aus
[`data-source-vectors.json`](./data-source-vectors.json).

**Bestand.** `state_change`, `error_change`, `bitfield_change`, `text_change`,
`counter_reset` und `data_gap` schreibt der Writer HEUTE schon in `device_measurement_event`
(`V20260848000000__additional_measurement_pipeline.sql`) — das Vokabular übernimmt sie in
derselben Schreibweise; der Java-Test liest den CHECK aus der Migration.

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

## 8. Die Fälle

61 Fälle, jede Art mit mindestens einem angenommenen, jeder Grund mit mindestens einem
verworfenen Fall; A = mit `annahme` (siehe §9).

| Gruppe | Fälle |
|---|---|
| Ausfall Box Halle 2, 03.11.2026 (Referenz) | Lücke je Box / je Quelle DQ-4 / je Reihe MS-10 (offen) · geschlossen am 04.11. 09:40 ohne Nachlieferung · Box-Tausch E-2 → E-2′ (A) · Fehlerklasse ohne Herzschlag verworfen · Fortschreibung verschiebt Beginn/Ende verworfen |
| Rückkehr-Variante A1/A3/A4 (A) | Nachlieferung 3 640 Werte · Lücke MS-10 nachgeliefert 17:31 · 188 Datenpakete fehlen (falsche Anzahl verworfen) · Paketzählung neu · MS-10 nach Abschluss eingegangen (Raster verletzt verworfen) |
| Zählerwechsel MS-06, 18.11.2026 10:40 (Referenz) | Z-5a → Z-5b mit Ständen · Lücke 10:40–10:47 mit Ursache · gleicher Einbau / nicht auf der Minute / im Voraus / von der Box verworfen · abweichender Wert 10:39 (gleicher Wert verworfen) |
| Übergabe DQ-3, 10.04.2027 07:30 (Referenz) | offen bis zur Quittung · Quittung schließt · an dieselbe Box / nicht auf der Minute / Ende vor Beginn verworfen · Rückgabe 12.04. (A) · nicht zuständige Box 07:32 (über eine Stunde verworfen) |
| Kartenzähler-Rücksetzung EK-3 (A) | `counter_reset` 6 184,37 → 0 · bestätigt als Grenze ohne Gerätewechsel · mit Gerätewechsel / steigender Stand verworfen |
| Box-Umschläge (A) | Neustart bei Wandlertausch 01.02.2027 · neue Karte EK-7 01.03.2027 · Bereichsbegrenzung EK-3 · Werte eingefroren · Puffer verdrängt · Übergabe von der Box / unbekannte Art / Kennung / Fassung 2.0 / ohne Kennung / offene Lücke / leer verworfen |
| Datenannahme | Box Lindach 14 min vor · genau 300 s ist kein Ereignis · 91 Tage alt · Uhrsprung · ohne Einbau (Writer) · unbekanntes Wort · unbekannter Grund / `herkunft_unvollstaendig` von der Datenannahme verworfen |
| Übergänge (A) | Statusbits EK-3 · Zustand, Fehlermeldung, Text am Ladepunkt · unverändert / fremdes Feld verworfen |

## 9. Widersprüche und Annahmen

Wo Konzept und Referenzdatei auseinanderlaufen, gewinnt für Kennzeichen, Seriennummern und
Zeitpunkte die Referenzdatei; eine Erfindung steht im Fall als `annahme` (und ein erfundenes
Kennzeichen oder ein erfundener Messkanal zusätzlich in `erfunden`).

1. **Ausfall Box Halle 2 am 03.11.2026 — zwei Erzählungen** (wie im Herkunftsvertrag §7 Nr. 1).
   Die Referenz erzählt den Box-Tausch: die Lücke schließt am 04.11.2026 09:40 OHNE
   `nachgeliefert_am`. Die Nachlieferung (`backfill`, 17:31), die Sequenz-Fälle und
   `late_arrival` folgen der Rückkehr-Variante der Abnahmefälle bzw. §4.8 („Puffer der
   reparierten Box“) — als `annahme`, Kennzeichen und Zuständigkeiten aus der Datei.
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

Die Verarbeitung von `…/v2/events` in der Datenannahme (IP-5), die Lücken-Erkennung aus
Kadenz und Herzschlag (IP-9), den Writer (IP-7), die Ereignis-Tabelle mit RLS, Grants und
Offboarding (IP-8), die Endgültigkeit der Viertelstundenwerte (IP-12/IP-13), die Blöcke
`data_sources[]` (IP-13) und `supports[]` (IP-18) und das Senden auf der Box (IP-18/IP-19,
Edge-Release). Die Kern-Telemetrie 2.0 und `measurement-samples` 2.0 bleiben unverändert.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='EreignisVokabularVectorsTest')      # rein, kein Docker
(cd services/ingest && ./mvnw test -Dtest='EventsContractSchemaTest')       # rein, kein Docker
(cd frontend/portal && npx vitest run src/uemsEreignis.test.ts)
```
