# UEMS-Messwert-Rohtabelle: Reihe je Komponente, Herkunftsspalten, neuer Doppel-Schlüssel

AP-07 IP-6, Migration `V20260912140000__uems_messwert_rohtabelle.sql`. Vertrag:
[`docs/contracts/v2/messwert-herkunft.md`](../../contracts/v2/messwert-herkunft.md) (IP-1).
Captain-Entscheide E2 und E3 vom 10.09.2026, beide Option A.

## Der Schlüsselwechsel

Die **Reihe** eines Messwerts ist ab hier **Mandant + Komponente + Messkanal**
(`tenant_id`, `entity_id`, `point_key`) — nicht mehr die lesende Box. Gerät samt Einbau
(`device_install_id`), Einstellungs-Fassung (`applied_revision`), Wertart (`value_kind`),
Rolle (`role`) und Zustellart (`delivery`, `delay_s`) sind **Herkunftsspalten je Wert**. Der
Doppel-Erkennungsschlüssel ist **Reihe + Messzeit** (E3); die Sequenz ist Kennzeichen, nicht
Schlüssel.

```sql
CREATE UNIQUE INDEX uq_device_measurement_sample_reihe
    ON device_measurement_sample (tenant_id, entity_id, point_key, time)
    WHERE entity_id IS NOT NULL AND role IS DISTINCT FROM 'spiegel';
```

- **Der Spiegel liegt AUSSERHALB** (Vertrag §7.4, Abnahmefall A9): anders wäre E3 („Reihe +
  Messzeit") nicht zugleich mit E4 („nie in der führenden Reihe") zu halten. Ein Spiegelwert
  derselben Reihe und Messzeit verdrängt den führenden nicht und wird nicht von ihm verdrängt.
- **`entity_id IS NOT NULL`** hält den Index auf den Werten, die eine Reihe HABEN; eine Zeile
  ohne Komponente wäre darin ohnehin nie ein Konflikt (NULL ist verschieden von NULL).
- ⚠ **Der Box-Schlüssel `(device_id, point_key, time, edge_sequence)` BLEIBT** — auch nach der
  Umschaltung (IP-7): er ist der Schlüssel JEDES Bestandswerts ohne Komponente und JEDES Spiegels,
  denn beide liegen ausserhalb des partiellen Index oben. Seit IP-18b Teil 1b heißt er
  `uq_device_measurement_sample_box` (`WHERE edge_entity_id IS NULL`, für den Bestand dieselbe
  Semantik); der geteilte Punkt hat daneben `uq_device_measurement_sample_box_komponente`
  ([Box-Schlüssel des geteilten Punkts](uems-geteilter-punkt-box-schluessel.md)).
- ⚠ Die **Spiegel-Spur je lesender Box** hat weiter KEINEN eigenen Schlüssel: zwei Spiegelwerte
  derselben Reihe und Messzeit aus zwei Boxen sind beide erlaubt. Den Doppel-Schutz trägt für sie
  der alte Index (gleiche Box, gleiche Sequenz); IP-7 hat daran nichts geändert und entscheidet die
  Wiederholung zusätzlich im Code (E3, je Spur).

## Der Nachtrag im Bestand — nie geraten

Drei Schritte, in dieser Reihenfolge, danach entsteht der Index (so kann er nicht scheitern):

1. **Komponente aus der Auswahl, nur wo sie EINDEUTIG folgt**: zu `(device_id, point_key)`
   steht **genau eine** Zeile in `device_measurement_selection`, und die nennt eine Komponente.
   Zwei Zeilen (zwei baugleiche Geräte hinter einer Box) oder eine Zeile mit `entity_id IS NULL`
   (die Box-Semantik von `V20260855000000` — „die Auswahl gehört dem Gerät als Ganzem",
   ausdrücklich nicht „unbekannt") lassen offen, für welche Komponente gelesen wurde. Eine
   abgewählte Auswahlzeile zählt mit: der Grabstein ist der Fakt, der den Punkt angefordert hat.
2. **E3 auf den Bestand.** Der alte Schlüssel ließ zu derselben Messzeit mehrere Zeilen zu,
   sobald die Sequenz sich unterschied (AP-07 §2.4 „stille Verdrängung"). Nach Schritt 1 können
   sie in EINER Reihe liegen — E3 sagt, welche die Reihe trägt: **der zuerst entgegengenommene**
   (`received_at`, ein gespeicherter Fakt). Jeder weitere gibt die Komponente wieder ab.
   **Gelöscht wird nichts**: Wert, Sequenz und Eingangszeit bleiben vollständig stehen.
3. **Was keine Komponente hat, bekommt `role = 'spiegel'`** — die Spur außerhalb der
   zuständigen Reihe, die nie in Verbrauch, Bilanz, Kennzahl oder Bericht fließt.

**Die übrigen Herkunftsspalten bleiben im Bestand LEER.** `null` heißt „nicht nachgeschlagen",
nie ein erfundener Einbau und keine erfundene Fassung. Insbesondere wird `value_kind` **nicht**
aus `aggregation_kind` abgeschrieben: die Verdichtungsart kennt zusätzlich `event` und `none`
und ist nicht die Wertart des Vertrags (E12). Nachgeschlagen wird ab IP-7, **zur Messzeit**.

## Was offen ist (IP-7 und IP-11)

- **Umgeschaltet hat IP-7** ([`uems-writer-herkunft-zur-messzeit.md`](uems-writer-herkunft-zur-messzeit.md)):
  der Writer schlägt die Herkunft ZUR MESSZEIT nach und schreibt sie, die Box und `services/ingest`
  bleiben unberührt. Der ALTE Index bleibt trotzdem stehen — jeder Bestandswert ohne Komponente und
  jeder Spiegel liegt ausserhalb des neuen partiellen Index, und für sie ist er der einzige
  Doppel-Schutz.
- **Kein Fremdschlüssel** auf `entity_id`/`device_install_id`: die Löschwege der Messreihen
  gehören **IP-11** (`ON DELETE RESTRICT`, Unclaim/Purge — gebaut, [`uems-loeschwege.md`](uems-loeschwege.md);
  auch dort bekam `entity_id` keinen Verweis). Ein CASCADE-Verweis würde HEUTE einen
  neuen Löschweg für Kundenmesswerte aufmachen, ein RESTRICT-Verweis das heutige Löschen einer
  Komponente brechen. Es ist dasselbe Muster wie bei `device_measurement_selection_event`.
- Aufbewahrung (90 Tage) und Verdichtung sind **unberührt**; die Tabelle ist wegen RLS nie
  komprimiert.

## Fallen

- ⚠ **`max(uuid)` gibt es in Postgres 16 nicht.** Die eine Zeile einer Gruppe liefert ihre
  Komponente über `(array_agg(entity_id))[1]`.
- ⚠ **Die App-Rolle hat auf dieser Tabelle auch UPDATE und DELETE** — nicht aus einem GRANT der
  Messwert-Migrationen, sondern aus `ALTER DEFAULT PRIVILEGES` in `V2__row_level_security.sql`.
  Wer „nur SELECT + INSERT" behauptet, prüft das erst an
  `information_schema.role_table_grants`.
- ⚠ **TimescaleDB meldet einen von RLS abgewiesenen INSERT und einen verbotenen UPDATE auf einer
  Hypertable mit `XX000 variable not found in subplan target list`**, nicht mit `42501`. Ein Test
  prüft dort „wird abgewiesen UND es bleibt nichts liegen", nicht den SQLSTATE.
- Eine Unique-Verletzung nennt den Index des **Chunks** (`_hyper_x_y_chunk_…`); Tests prüfen den
  Namen mit `contains`.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='UemsMesswertRohtabelleMigrationTest')   # 30 Tage Bestand
(cd services/api && ./mvnw test -Dtest='DataRetentionPolicyTest,MesswertHerkunftVectorsTest')
(cd services/timescale-writer && ./mvnw test -Dtest=WriterPipeTest)   # Writer: IP-7
```

Der Migrationstest vergleicht die Messwert- und Auswahl-Tabellen per **Fingerabdruck vor und
nach** der Migration (die Rohtabelle ohne ihre neuen Spalten) und lässt den Verdichtungslauf
beidseitig laufen — das ist der Bestandsschutz von Cockpit, Erlöse, Fahrplan, Verlauf und
Registry-Push.
