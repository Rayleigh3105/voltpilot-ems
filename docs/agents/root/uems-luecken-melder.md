# UEMS-Lücken-Melder: fehlende Werte je Reihe, und wenn die Box gar nichts mehr sagt (AP-07 IP-9)

Neu angelegt am 13.09.2026. Code: `services/api/.../uems/LueckenMelder` (Lauf), `LueckenRegeln`
(rein), `LueckenLaeufer` + `LueckenSchedulingConfig` (Takt). Migrationen
`V20260913130000__uems_luecken_vokabular.sql` (Vertrag geweitet) und
`V20260913130500__uems_luecken_melder.sql` (Stand + Zeiger). Er **erkennt und schreibt fest**,
dass Werte fehlen — Alarm, Benachrichtigung, Route, Portal-Fläche, Ersatzwerte, Korrektur und
Löschen sind NICHT hier.

## ⚠ Die Lücke ist nicht „liefert keine Daten“

| | Beobachtung „liefert Daten“ | Lücke (`data_gap`) |
|---|---|---|
| Schwelle | `min(max(3 × Kadenz, 300 s), 86 400 s)` | über `2 × Kadenz` (strikt), **ohne Boden, ohne Deckel** |
| zeigt | ein Abzeichen (Zustand) | kein Abzeichen — ein Ereignis, das fehlende Werte zählt |
| wer | `ZustandAbleitung.liefertDaten` (Register) | dieser Melder |

Eine Reihe darf „liefert Daten“ tragen UND eine offene Lücke haben (900 s Kadenz, 30 min + 1 s
still), und umgekehrt (Tageszähler nach 30 h). Die Schwelle steht NICHT im Melder:
`LueckenRegeln.reiheOffen` fragt `ZustandAbleitung.liefertDaten(...).lueckeOffen()` — Faktor
`LUECKE_FAKTOR`, Vertrag `uems-zustand-vectors.json` `toleranz.luecke_faktor`.

## Zwei Wege, ein Ergebnis

1. **Je Reihe aus der Kadenz** (Komponente + Messkanal, Spur ohne `spiegel`, nur Qualität `good`,
   nur mit eingeschalteter Mess-Auswahl): die Kadenz ZUM ZEITPUNKT des letzten guten Werts
   (Fassungen der Quellenbindungen → Auswahl → Katalog → 300 s, `KadenzRegeln.wirksam`; bei
   mehreren Bindungen die schnellste). `von` = letzter guter Wert + EINE Kadenz (MS-06: 10:39 →
   10:40). Ein Loch zwischen zwei Takten, das schon wieder zu ist, wird geschlossen gemeldet
   (Lochsuche ab `geprueft_bis`, nur Eingänge vor der Sicherheit, ab dem ersten Blick auf die
   Reihe — nie rückwirkend). Bezug: Box des letzten Werts, Datenquelle der Komponente,
   Komponente + Messkanal, Messstelle der Bindung zu `von` (führend vor Vergleich).
2. **Je Box aus dem letzten Eingang** („Box meldet sich nicht“, Toleranz
   `max(2 × 15 s, 300 s)` = 300 s strikt, 14:00 still → 14:05:01 erkannt): EINE Lücke je Box
   (Bezug nur `box` — **der Kern-Pfad**) und EINE je Datenquelle, für die die Box zu `von`
   zuständig war (`data_source_assignment` — der UEMS-Pfad), `von` = letzter Eingang,
   `erkannt_aus = herzschlag`, `fehlerklasse = box_meldet_sich_nicht`. ⚠ „Eingang“ = die
   Ankunft von Daten: `telemetry.received_at` (dieselbe Grundlage wie die Live-Flächen) und
   `device_measurement_sample.received_at`. Ein eigener Herzschlag-Speicher (AP-06 IP-15
   `device_status_seen_at`) und der Block `data_sources[]` (AP-06 E5) sind nicht gebaut — kommt
   einer, ist er eine weitere Eingangsquelle, keine neue Regel. `telemetry_v2` wird nicht gelesen.

„Eine statt einer Flut“: je Einheit höchstens EINE offene Lücke (`luecke_seit` im Stand); die
Kennungen sind abgeleitet (`LueckenRegeln.*Kennung`, auf die Sekunde von `von`).

## Schließen

Append-only: Schließen ist eine **Fortschreibung** (dieselbe `ereignis_id`, der gespeicherte
Bezug wird übernommen, nie neu nachgeschlagen), geprüft mit `EreignisVokabular.pruefeFortschreibung`.

- **Reihe:** `bis` = Messzeit des ersten guten Werts NACH `von`, der RECHTZEITIG einging (Zustellart
  des Writers, `delivery IS DISTINCT FROM 'nachgeliefert'`) — ⚠ bei 900 s Kadenz sind die jüngsten
  Pufferwerte (Verzögerung ≤ 45 min) rechtzeitig, die Reihen-Lücke endet dann VOR der Rückkehr der
  Box (A4). Abgewählt → `bis` = `disabled_at`. Dazu `erwartet_fehlend` (je angefangene Kadenz, mit
  der Kadenz der offenen Lücke).
- **Box:** `bis` = erster Eingang nach dem Schweigen (`erste_nach`). **Quelle:** ebenso — endete die
  Zuständigkeit vorher (Box-Tausch), `bis` = `effective_to`, auch während die Box noch schweigt.
- **`nachgeliefert_am`** = Eingang des ersten nachgelieferten Werts im Zeitraum (Messwerte:
  `delivery = 'nachgeliefert'`; Kern-Telemetrie: Eingang > Messzeit + 300 s) — mit dem Schließen
  oder als eigene spätere Fortschreibung.
- **`backfill`** je Box und Quelle, sobald die Welle 300 s ruht: Messzeit erster/letzter
  nachgelieferter Wert (geschlossen, `bis` aufgerundet), Eingangszeiten, `anzahl`; `erwartet` NUR,
  wenn jede Reihe der Welle eine geschlossene Kadenz-Lücke mit `erwartet_fehlend` hat, die ihre
  Messzeiten umfasst (sonst weggelassen, nie geschätzt). Werte ohne Datenquelle an der Komponente:
  kein `backfill` (der Vertrag braucht `datenquelle`), nur ein Log. Eine spätere Welle = ein neues
  Ereignis (`nachlieferung_gemeldet_bis`).

## Vertrag (additiv geweitet)

`backfill` darf auch von `cloud` kommen (DB-Funktion, beide Java-Zwillinge, Vektoren, Schema-Text),
`erkannt_aus = kadenz` auch von `cloud` (`EreignisVokabular.ERKANNT_AUS_AUCH` ⟷ Vektor-Datei
`auch_urheber`; die DB prüft Urheber je Art, nicht je `erkannt_aus`). Vier neue Vektor-Fälle (68).
Der Writer-Test fährt die Vokabular-Migration mit (`EreignisTabelleImTest.LUECKEN`).

Seit AP-08 IP-6 schreibt der Melder beim Schließen einer Reihen-Lücke den gemessenen Zuwachs
(`zuwachs`, `einheit`, `stand_vor`, `stand_nach`) — Regeln und Fallen in `uems-luecken-zuwachs.md`.

## Arbeitsweise

`lauf(jetzt)` = `eintragen` (Eingänge seit dem Zeiger `messreihe_luecke_lauf`, Zeile unter
`FOR UPDATE SKIP LOCKED`, Sicherheit 2 min, Überlappung 2 min; der erste Lauf liest einen Tag
zurück und holt den jüngsten Telemetrie-Eingang JEDER Box über den Index — auch eine Box, die
schon vorher schwieg, bekommt ihre Lücke) + `pruefen` (fällige Einheiten aus
`messreihe_luecke_stand` stapelweise unter `FOR UPDATE SKIP LOCKED`, Reihen vor Boxen, jede Einheit im eigenen Savepoint — ein Fehler kostet
nur sie, `faellig_ab` + 1 h). Hält ein anderer Melder den Zeiger, entfällt der GANZE Takt (ein
Prüfen auf altem Stand sähe eine Box schweigen). Takt 5 min; Schalter
`voltpilot.uems.luecken.enabled` — `application.yml` AN, surefire AUS, `LueckenWiringTest`. Der
Stand ist RLS + FORCE, nur die BYPASSRLS-Rolle darf ihn; Offboarding räumt ihn
(`TenantRepository`).

⚠ Legt eine Migration eine Tabelle MIT Startzeile an (hier `messreihe_luecke_lauf`), fällt sie in
älteren Bestandsschutz-Tests ohne `messreihe_%`-Ausnahme auf — `UemsViertelstundeMengeTest` nennt
sie darum ausdrücklich.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='LueckenRegelnTest,LueckenWiringTest,UemsLueckenMelderTest')
(cd services/api && ./mvnw test -Dtest='EreignisVokabularVectorsTest,MessreiheEreignisMigrationTest')
(cd services/timescale-writer && ./mvnw test -Dtest='EreignisVokabularZwillingTest,EventsRawConsumerTest,WriterPipeTest')
```

`UemsLueckenMelderTest` (Testcontainers) fährt EINE Zeitachse: A3 (Box Halle 2 03.11.2026
14:00–17:30, Nachlieferung), A4 (acht Tage, drei verdrängt, Kadenz 900 s → Kante bei 30 min),
Loch zwischen zwei Takten, Box-Tausch, Sperre mit Überspringen, Abbruch nach dem Eintragen,
Mandantenzaun, Kern-Box ohne Datenquelle, Fingerabdruck. Maven braucht JDK 21.
