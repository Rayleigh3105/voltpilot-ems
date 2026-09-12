# UEMS-Writer: die Herkunft je Messwert wird ZUR MESSZEIT nachgeschlagen

AP-07 **IP-7** — die Umschaltung, die IP-6 vorbereitet hat. Vertrag:
[`docs/contracts/v2/messwert-herkunft.md`](../../contracts/v2/messwert-herkunft.md) (IP-1),
Rohtabelle: [`uems-messwert-rohtabelle-reihe-herkunft.md`](uems-messwert-rohtabelle-reihe-herkunft.md)
(IP-6), Ereignisse: [`uems-messreihe-ereignis-tabelle.md`](uems-messreihe-ereignis-tabelle.md) (IP-8).
Captain-Entscheide E2, E3 und E4 vom 10.09.2026, alle Option A. **KEINE Migration** — dieses
Paket ist reiner Code.

## Der Kern: „zur Messzeit", nie „jetzt"

Jeder Nachschlag geht auf den Zeitpunkt der **Messung**. Ein gepufferter Wert, der Stunden später
eintrifft, sieht das Gerät, die Einstellungs-Fassung und die Zuständigkeit, die **damals** galten —
und wird deshalb führend, wenn seine Box damals zuständig war, auch wenn sie es heute nicht mehr
ist (Zeitstrahl AP-07 §5, 10.04.2027 07:31:40).

`services/timescale-writer`:

| Klasse | Rolle |
|---|---|
| `MesswertHerkunft` | der **Writer-Zwilling** der api-Klasse (`MesswertHerkunftZwillingTest` spielt alle Fälle von `messwert-herkunft-vectors.json` — dieselbe Datei, an der die api-Kopie hängt) |
| `HerkunftNachschlag` | die Fakten ZUR MESSZEIT: Komponente, Gerät-Einbau, Fassung, Wertart, Rolle |
| `MesswertEreignisse` | bündelt die Meldungen EINES Umschlags, damit sie sparsam bleiben |
| `MeasurementWriteRepository` | die zwei Spuren, das Schreiben, die Ereignisse |

## Zwei Spuren, und EIN Fakt entscheidet welche

**Hat die Komponente des Messkanals eine Datenquelle?**

- **Nein** (keine eindeutige Komponente in der Auswahl, oder keine `data_source_id`) → der Wert
  geht Zeichen für Zeichen den alten Weg: dieselben Spalten, der alte Schlüssel
  `(device_id, point_key, time, edge_sequence)`, dieselben Nachwirkungen, **kein Ereignis**.
- **Ja** → `MesswertHerkunft.stelleFest` urteilt, die Zeile trägt ihre sieben Herkunftsspalten und
  liegt im neuen Schlüssel `(tenant_id, entity_id, point_key, time)`.

⚠ Die Komponente ALLEIN reicht nicht: ohne Datenquelle gibt es keine Rolle, und eine Reihe ohne
Rolle wäre genau die stille Verdrängung, die E3 abschafft (der neue Index greift ab `entity_id IS
NOT NULL`). Darum bleibt `entity_id` in der Zeile leer, solange die Quelle fehlt.

## Was der Draht NICHT liefert

`measurements.raw` 1.0 trägt weder `entity_id` noch `applied_revision` (die Datenannahme entfernt
`entity_id` vor dem Schreiben, IP-5) — und dieses Paket ändert daran nichts. Für den Writer heißt
das: **Komponente und Fassung kommen IMMER aus dem Nachschlag**, also aus der Auswahl bzw. aus der
zur Messzeit angewendeten Fassung der Zustellung (`FassungQuelle.ZUSTELLUNG`). Das Durchreichen
der 2.1-Felder ist IP-18 (Core + Palette in EINEM Edge-Release).

⚠ Ein `device_measurement_selection_event` mit `event_kind = 'first_sample'` ist **keine
Zustellung** — es trägt die schon geltende Fassung mit der Messzeit des ersten Werts und würde als
Fassungs-Eintrag gelesen eine spätere Fassung zurückdrehen. Der Nachschlag schließt es aus.

## Die Nachlieferungs-Sperre (W8) — was fällt und was ausdrücklich stehen bleibt

- **Es bleibt** der Riegel `observed_at < enabled_at` (und `disabled_at + 30 s`, und das
  Purge-Wasserzeichen). Er prüft schon immer gegen die **Messzeit** und beantwortet die Frage
  „war der Punkt damals überhaupt gewählt?". Nichts daran ist gelockert — für beide Spuren.
- **Es fällt** die Versuchung, die Zuständigkeit zur **Eingangszeit** zu prüfen. Der Writer prüft
  sie zur Messzeit, und sie **verwirft nie**: sie entscheidet nur die Rolle. Nachlieferung bis
  90 Tage zurück ist willkommen, auch über eine Übergabe hinweg (Abnahmefall A6; Test
  `nachlieferungBis90TageIstWillkommenUeberEineUebergabeHinweg` spielt die angenommene Kante
  „genau 90 Tage").

## Der ALTE Index bleibt — an den Daten entschieden

`uq_device_measurement_sample_idempotency (device_id, point_key, time, edge_sequence)` bleibt
stehen. Der Grund ist kein Wunsch, sondern eine Zeile, die es weiter gibt: **jeder Bestandswert
(ohne Komponente) und jeder Spiegel liegt ausserhalb des neuen partiellen Index** (der greift nur
bei `entity_id IS NOT NULL AND role IS DISTINCT FROM 'spiegel'`), und für sie ist der alte Index
der einzige Doppel-Schutz, den es gibt. Er darf erst fallen, wenn keine Zeile mehr ohne Komponente
entsteht — also wenn jede Komponente jeder Flotten-Anlage ihre Datenquelle und ihr Gerät hat
(Bestandsübernahme + IP-18) — und wenn die Spiegel-Spur ihren eigenen Schlüssel hat
(`(tenant_id, entity_id, point_key, time, device_id)` bei `role = 'spiegel'`, offen).

## ⚠ Ein Fehler im Nachschlag kostet NIE einen Messwert

Jeder Nachschlag läuft in einem **eigenen Savepoint** innerhalb der Schreib-Transaktion (das
Muster von `MessreiheEreignisRepository.spiegeln`). Scheitert er, wird nur er zurückgerollt,
geloggt und gezählt, und der Wert wird als **Bestandswert** gespeichert — ohne Herkunftsspalten.
Dasselbe gilt für jede Meldung: ein vom Vokabular abgelehntes oder fehlgeschlagenes Ereignis
rollt allein zurück. *Ein Wert ohne nachgeschlagene Herkunft ist richtig; ein verlorener Wert wäre
Datenverlust beim Kunden.* Auch `rejected` (Herkunft unvollständig) ist deshalb nur eine MELDUNG:
der Wert wird trotzdem als Bestandswert gespeichert. Nur E3 schreibt wirklich nichts — derselbe
Schlüssel mit abweichendem Wert.

## Ereignisse: sparsam, und nur die eigenen

Sie gehen über den **vorhandenen** Weg (`MessreiheEreignisRepository.anhaengen`, Urheber `writer`),
also durch `EreignisVokabular` als Tor — im Writer neu verpackt als `vomWriter(...)` (eigener
Savepoint, wirft nie, zählt `voltpilot_writer_events_writer_total{ergebnis,grund}`).

| Art | Bündelung |
|---|---|
| `sequence_gap` / `sequence_reset` | EINMAL je Umschlag (es ist die Sequenz des Umschlags, nicht die eines Werts) |
| `rejected` | EINMAL je Umschlag und Grund, mit `anzahl` |
| `unassigned_reader` | EINMAL je Umschlag, Box und Datenquelle (Zeitraum über die Messzeiten, mit `anzahl`) — dazu die Drossel des Vertrags: höchstens einmal je Stunde je Box und Datenquelle |
| `duplicate_conflict` | je Wert — er nennt zwei konkrete Werte und zwei Sequenzen |

⚠ `clock_ahead`, `too_old` und `clock_jump` gehören laut Vokabular der **Datenannahme**. Der
Writer verwirft sie und zählt sie, er meldet sie nie.

⚠ Der zuletzt gesehene Umschlag je Box lebt im **Speicher** des Writers (keine Abfrage). Nach
einem Neustart urteilt der erste Umschlag einer Box deshalb gar nicht über die Sequenz — lieber
kein Ereignis als eine erfundene Lücke.

⚠ **Bekannte Grenze:** ein `duplicate_conflict` an einem Kanal OHNE `decoded` reist heute nicht —
`EreignisVokabular` verlangt in einem Messwert drei Skalare (`raw`, `decoded`, `qualitaet`). Die
Meldung wird abgelehnt und gezählt (`ergebnis="verworfen"`), der WERT ist davon unberührt. Die
Weitung gehört in den Ereignis-Vertrag (Klasse `MESSWERT`, Vektor-Fall, beide Zwillinge), nicht in
den Writer.

## Die Abfragezahl wächst nicht mit der Zahl der Werte

Gecacht wird die **Zeitleiste**, nicht die Antwort (ein Cache auf „Antwort zur Messzeit" träfe
nie). Je Komponente, Datenquelle und Messkanal liegt die ganze Zeitleiste im Speicher (TTL 60 s,
LRU), und die Messzeit wird dort aufgelöst. Fünf Nachschläge je **Messkanal**, nicht je Wert;
gezählt in `voltpilot_writer_herkunft_nachschlag_total{nachschlag,ergebnis}` (`abfrage` ·
`treffer` · `fehler`). Die einzige Abfrage, die je WERT entstehen kann, ist der Blick auf schon
Gespeichertes — und sie entsteht nur, wenn der Einfügeversuch wirklich abgewiesen wurde.

## Prüfen

```bash
(cd services/timescale-writer && ./mvnw test -Dtest=MesswertHerkunftZwillingTest)   # rein
(cd services/timescale-writer && ./mvnw test -Dtest=WriterPipeTest)                 # Docker
```

`WriterPipeTest` trägt die Abnahmefälle A1, A6, A9, A11 und A12, den Zeitstrahl 07:31:40, die
90-Tage-Kante, den Mandantenzaun, die Abfragezahl, den Fingerabdruck der Bestandsspalten und den
Nachschlag-Fehler (er entzieht dem Writer mitten im Lauf das Leserecht auf `geraet_komponente`).
Die Zeitleisten stehen in `src/test/resources/writer-schema.sql` — gespiegelt sind nur die
Spalten, die `HerkunftNachschlag` anfasst.

Maven braucht JDK 21 (`JAVA_HOME` auf ein 21er setzen, sonst „release version 21 not supported").
