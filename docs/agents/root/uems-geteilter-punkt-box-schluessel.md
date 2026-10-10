# UEMS AP-07 IP-18b Teil 1b — Box-Schlüssel des geteilten Punkts

Ein **geteilter Punkt** ist derselbe `point_key` einer Box für zwei Komponenten, jede mit ihrer
`entity_id` am Sample ([Vertrag §2/§3](../../contracts/v2/mqtt-measurement-samples-2.1.md)).
Teil 1a (Datenannahme, Writer-Nachschlag) steht in
[uems-measurement-samples-2-1-herkunftsfelder.md](uems-measurement-samples-2-1-herkunftsfelder.md).

## Speicherschlüssel (`V20260922236000` Spalte, `V20260922236500` Schlüssel)

- `device_measurement_sample.edge_entity_id`: die Komponente, die die **Box genannt** hat —
  Wortlaut vom Draht. Das Ergebnis des Nachschlags steht getrennt davon in `entity_id`. Jede
  Bestandszeile hat NULL, keine wurde umgeschrieben.
- `uq_device_measurement_sample_box (device_id, point_key, time, edge_sequence) WHERE
  edge_entity_id IS NULL` ersetzt `uq_device_measurement_sample_idempotency`: dieselbe
  Spaltenfolge, für alles Heutige dieselbe Semantik.
- `uq_device_measurement_sample_box_komponente (device_id, point_key, edge_entity_id, time,
  edge_sequence) WHERE edge_entity_id IS NOT NULL`: beide Komponenten desselben Ticks liegen.
- ⚠ Kein Schlüssel über `entity_id`: er kollidiert, wenn beide Komponenten unaufgelöst sind, und
  kann zwischen zwei Zustellungen desselben Umschlags wechseln.
- Gebaut werden die Schlüssel sperrarm in `V20260922236500` (ohne Flyway-Transaktion,
  `….sql.conf`): `device_measurement_sample` ist eine Hypertable, `CREATE INDEX CONCURRENTLY`
  lehnt TimescaleDB ab, `timescaledb.transaction_per_chunk` gibt es nicht für UNIQUE (2.17.2).
  Darum Wurzel mit `ON ONLY`, dann je Chunk eine Transaktion mit Eintrag in
  `_timescaledb_catalog.chunk_index` (wie Timescale selbst), der alte Schlüssel fällt je Chunk
  erst danach; jede Sperre mit 5 s Frist und Wiederholung. Nach jedem Abbruch wiederholbar, auch
  mit INVALID-Rest (`UemsBoxSchluesselBauenMigrationTest`). Drehbuch:
  [uems-erste-freigabe.md §2.7](../../rollout/uems-erste-freigabe.md).
- ⚠ Ein Chunk-Index ohne Katalog-Eintrag bricht `ON CONFLICT (…)` mit Ziel („could not find
  arbiter index") und bleibt bei `DROP INDEX` an der Wurzel liegen. Wer einen Schlüssel auf
  einer Hypertable von Hand je Chunk baut, trägt ihn ein.
- Der Writer (`MeasurementWriteRepository#schreiben`) nennt `edge_entity_id` nur an einem
  geteilten Punkt. Ohne Komponente bleibt die Anweisung Zeichen für Zeichen die bisherige.
  Ein älterer Writer schreibt NULL und trifft damit den alten Schlüssel.

## Box-Verlauf: der geteilte Punkt erscheint dort nicht (Entscheid firstmate 22.09.2026)

Auf Box-Ebene zählen nur Zeilen mit `edge_entity_id IS NULL`. Die Werte der Komponenten zeigt
nur ihre Reihe (`entity_id`), also Messstelle, Viertelstunde und Kennzahl.

- `MeasurementHistoryService`: `rawData`, `prependRawState` und `rawAvailable` filtern auf
  `edge_entity_id IS NULL`. Dieser Filter macht eine Partition von `lag` nach `edge_entity_id`
  überflüssig. Die Bestands-CSV bleibt Byte für Byte gleich (`UemsKennzahlenBestandsschutzTest`,
  `UemsBerichteBestandsschutzTest`).
- Box-Verdichtung `refresh_device_measurement_rollup`: dieselbe Prozedur mit demselben Filter.
- Punktzustand `device_measurement_point_state`: siehe den nächsten Abschnitt — er wird
  fortgeschrieben, aber als Wert einer Komponente gekennzeichnet.
- Beweis: `UemsGeteilterPunktBoxSchluesselMigrationTest` (Migration, Bestand und Box-Verlauf) und
  `WriterPipeTest#einGeteilterPunktFindetJeKomponenteSeineReihe` (Writer).

## Punktzustand am geteilten Punkt (`V20260923241500`, Pflicht vor dem Einschalten)

Der Punktzustand trägt die letzte Beobachtung über ALLE Komponenten, damit „zuletzt gelesen" der
Geräteseite nicht stillsteht; ein stehender Wert sähe aus wie ein aktueller.

- Spalte `component_read_at`: Messzeit der letzten Beobachtung mit Komponente. Die Zeile gilt als
  „je Komponente", solange `component_read_at >= last_read_at`. Ein späterer Wert ohne Komponente
  rückt `last_read_at` weiter und hebt das Kennzeichen damit auf, OHNE die Spalte zu nennen: die
  Writer-Anweisung eines heutigen Punkts bleibt Zeichen für Zeichen die bisherige
  (`MeasurementWriteRepository#punktzustandSql`, `PunktzustandBestandTest` mit wörtlicher Kopie).
- Warum keine Zeile je Komponente: die Löschwege `uems_messwerte_der_anlage_entfernen` und
  `uems_messwerte_des_kundenbereichs_entfernen` nehmen die Punktzustands-Zeile schon mit; eine
  eigene Tabelle hätte beide Funktionen umschreiben müssen. Die Werte je Komponente stehen in ihrer
  Reihe — dieselbe Lesart wie der Box-Verlauf.
- Geräteseite (`MeasurementSelectionRepository#latestObservations`, `Observation#jeKomponente`):
  gelesen, `lastReadAt` aktuell, aber `rawValue`/`decodedValue`/`quality` leer und der Grund
  „Von diesem Gerät gelesen, je Komponente: der Wert steht in der Reihe der Komponente." — der
  gespeicherte Wert gehört EINER Komponente und wäre für jede andere falsch (Summenwert-Assistent
  liest `decodedValue` je Komponente). Kein neues Feld, keine Portal-Änderung.
- Vergleichs-Auswahl der Anlage (`MeasurementHistoryService#comparisonOptions`) bietet einen
  Punkt „je Komponente" nicht an: er hat keinen Box-Verlauf.
- ⚠ Randfall: ein Wert ohne Komponente auf GENAU derselben Messzeit wie der letzte mit Komponente
  (höhere Sequenz) gilt bis zum nächsten Box-Wert noch als „je Komponente". Tritt nur beim
  Planwechsel geteilt → zusammengelegt auf und heilt mit der nächsten Kadenz.
- Beweise: `WriterPipeTest#einGeteilterPunktFindetJeKomponenteSeineReihe` (Zustand bewegt sich),
  `UemsPunktzustandJeKomponenteMigrationTest` (Bestand zeilengleich, Geräteseite, Vergleich),
  `MeasurementSelectionApiTest#catalogZeigtEinenGeteiltenPunktGelesenJeKomponenteOhneWertDerBox`.

## Offen / Fallen

- `MessstelleFormelWerteRepository#frischester` (Live-Wert eines Formel-/Rest-Terms) liest nur Zeilen der
  Box (`edge_entity_id IS NULL`) und der EIGENEN Komponente des Terms, nie den Wert der anderen
  (`BilanzApiTest#amGeteiltenPunktLiestJederTermDenWertSeinerKomponente`). `verlauf15m` (Lesart A): liest
  weiter die Box-Verdichtung; nur ein Bucket, den sie nicht hat, kommt aus den Zeilen der EIGENEN Komponente
  (`edge_entity_id`, Regel der Verdichtung: gut, Kadenz 900 s, gauge-Mittel/letzter Stand/counter-Differenz).
  Ohne geteilten Punkt gibt es keine solche Zeile, das Ergebnis ist das von vorher
  (`BilanzApiTest#verlaufEinesMesskanalTermsAmGeteiltenPunktLiestSeineKomponente`). ⚠ Die erste Differenz im
  Zeitraum zählt ab dem ersten Wert (wie jeder Refresh der Verdichtung), keine Migration.
- `appendTransitions` (Wechsel-Ereignisse) eines einfachen Punkts vergleicht weiter mit der
  letzten Zeile seines `point_key`, auch mit einer, die eine Komponente genannt hat. Das betrifft
  nur einen Punkt, der von geteilt zu einfach wechselt.
- Teil 2, Cloud-Schnitt: `MeasurementConfigPublisher` fragt `BoxFaehigkeiten.kann(…,
  "measurement_config_per_component")`; nur dann steht ein Punkt mehrerer Komponenten einmal je
  Komponente im Plan (`MeasurementPlan#composeJeKomponente`, Vertrag `x-point-key-rule`, bleibt
  2.0). Jede andere Box bekommt den zusammengelegten Plan byte-gleich
  (`MessplanJeKomponenteBestandTest`, wörtliche Kopie von vorher).
- Box-Schritt, EINGESCHALTET: Core `measurements.geteiltePunkte` ist die eine
  Duplikat-Regel für `ParseConfig`, `parseBatch` und `WrapStatus` (Paar zulässig, dieselbe
  Komponente zweimal oder ein Vorkommen ohne Komponente = Duplikat). `BuiltSupports` meldet das
  Wort (Einschalt-Commit nach Entscheid firstmate 23.09.2026 A, `cloud/geteilter_punkt_gemeldet_test.go`,
  Vektor `advertised: true`); wirksam erst mit einem Box-Release, eine Box ohne das Wort bekommt weiter
  den zusammengelegten Plan. Gebaut sind
  Punktzustand, Cloud-Status je Komponente, Revisions-Anstoß (Abschnitt unten), der Summen-Wächter
  an Bilanz, Formel und Kennzahl samt Portal-Anzeige, `frischester` und `verlauf15m` je Komponente
  (oben) — Entscheid firstmate 23.09.2026 A: erst das Folgepaket „Summen-Wächter komplett“, dann der
  Einschalt-Commit (`BuiltSupports`, Vektor `advertised: true`, Ruhend-Test umdrehen). Node-RED `buildPlan` plant Anfragen aus `lesungenJeZiel` (ein Lesen je Ziel und Punkt,
  schnellste Kadenz), Samples je Komponente; die Laufzeit taktet Lesen (`due`) und Sample
  (`probenDue`) getrennt und dekodiert je Lesen einmal (Decoder halten Vorwerte). Beweise:
  `geteilter_punkt_test.go`, `measurement-geteilter-punkt.test.js` (Budget über jeden
  Katalogpunkt).
- Status je Komponente (`x-rejection-entity-rule`): `MeasurementConfigStatusListener` nimmt
  `rejected[].entity_id` an (Punkt darf dann zugleich in `accepted` stehen; dasselbe Paar zweimal,
  Komponente neben ganzem Punkt oder keine UUID = ganze Quittung verworfen, wie `WrapStatus`).
  Mit Komponente schreibt `applyAcknowledgementJeKomponente` je `(point_key, entity_id)`; ohne
  bleibt es beim unveränderten `applyAcknowledgement` (`MeasurementContractsTest`).
- Mit dem Box-Release endet an einer Box mit bisher zusammengelegtem Punkt dessen Box-Verlauf
  (gewollt, Werte in den Reihen der Komponenten); „zuletzt gelesen" der Geräteseite läuft weiter
  (Punktzustand, Abschnitt oben).
- Revisions-Anstoß: der Core weist dieselbe Revision mit anderem Inhalt als `stale revision` ab
  (`agent/measurements.go`) und kann keine erzeugen. `BoxFaehigkeiten#record` liest die alte Liste
  `FOR UPDATE` und veröffentlicht `Gemeldet(vorher, nachher)`; `MessplanRevisionsAnstoss` (nach dem
  Commit) ruft bei gewonnenem ODER verlorenem Wort `MeasurementSelectionService#planNeuAusliefern`:
  nur mit geteiltem Punkt EIN `selection_requested` (Akteur `system:plan-je-komponente`) an der
  ersten aktiven Zeile, Revision + 1, keine Auswahlzeile geändert; der Reconciler liefert aus.
  Ein Fehler dort nimmt der Box nie ihre Fähigkeiten, der Anstoß ist dann verloren (kein Schaden).
- Summen-Wächter (`GeteiltesRegister`): benennt, nie blockieren (Muster `KostenstelleDoppelzaehlung`) —
  die Cloud kann „dasselbe Gerät“ nicht von „zwei Geräte hinter demselben Katalogpunkt“ trennen.
  Bilanz: `abschnitte[].geteilte_register` (fehlt ohne Fund), je Rolle zwei Messstellen, deren
  führende Quelle der Hauptgröße zeitgleich denselben `point_key` derselben Box über zwei
  Komponenten liest (`BilanzApiTest`, `GeteiltesRegisterTest`). Formel (`GET …/formel`):
  `geteilte_register[{register, positionen}]`, je Vorzeichen eine Summe; ein Messkanal-Term über
  seine Komponente, ein Messstellen-Term über die führende Quelle; fehlt immer mit
  `ausserhalb_zugriff` (Positionen verrieten verborgene Terme). Kennzahl (`GET …/werte`, nur
  `zusammenfassung`): `geteilte_register[{rolle zaehler|nenner, register, messstellen}]`, Paare der
  Fassung am letzten Tag (`KennzahlWerteApiTest`). Portal: eine Zeile
  `components/GeteiltesRegisterHinweis.tsx` (Wörter `UEMS_GETEILT_*`/`uemsGeteiltSatz` in
  `glossar.ts`) im Energiebilanz-Abschnitt, im Formel-Dialog (`SummenwertFormelDialog`, es gibt
  keine lesende Formel-Fläche) und auf der Kennzahl-Seite über dem Verlauf; nie der `point_key`.
