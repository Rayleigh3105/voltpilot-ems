# UEMS-Speicherklasse Viertelstundenwerte: Tabelle, Arbeitsliste und der Fünf-Minuten-Lauf

**AP-07 IP-12.** Migration `V20260912170000__uems_messreihe_viertelstunde.sql`; Regeln
`uems/ViertelstundeRegeln`, Lauf `uems/ViertelstundeVerdichter`, Takt `uems/ViertelstundeLaeufer`
(+ `ViertelstundeSchedulingConfig`). Tests: `UemsViertelstundeMigrationTest` (Testcontainers, 20
Fälle), `ViertelstundeRegelnTest`, `ViertelstundeWiringTest`, `DataRetentionPolicyTest`.

## Was entsteht

Drei Tabellen, alle neu und additiv — an keiner bestehenden Tabelle ändert sich eine Zeile
(bewiesen per Fingerabdruck vor und nach dem ganzen Lauf):

| Tabelle | Was sie ist |
|---|---|
| `messreihe_viertelstunde` | Hypertable, Chunk 30 Tage, **Aufbewahrung 3 653 Tage** (zehn Jahre, E6), RLS + FORCE, **ohne Kompression** (E7). Die Felder sind §4.4 des Konzepts, Feld für Feld. |
| `messreihe_viertelstunde_arbeit` | die **durable Arbeitsliste** der betroffenen Intervalle |
| `messreihe_viertelstunde_lauf` | der Laufzustand: der Eingangs-Zeiger und der Stand der Rückrechnung (nicht mandantengebunden, darum ohne RLS) |

Dazu ein TEILWEISER Index auf der Rohtabelle,
`idx_device_measurement_sample_eingang (received_at) WHERE entity_id IS NOT NULL AND role IS
DISTINCT FROM 'spiegel'` — ohne ihn läse der Lauf alle fünf Minuten jeden Chunk der 90 Tage voll.
Preis: ein Index-Eintrag mehr je geschriebenem Rohwert.

## ⚠ Die Grenze zu IP-13 — seit IP-13 GESCHLOSSEN

Dieser Lauf schreibt **nur vorläufige** Werte und rührt eine `endgueltig`e Zeile nie an — auch
nicht, wenn neue Rohwerte für ihr Intervall eintreffen (`ON CONFLICT … WHERE zustand =
'vorlaeufig' AND version = 1`). `endgueltig_ab` wird hier **angelegt und gefüllt** (Intervallende
+ 7 Tage, E5 — der CHECK hält das an der Datenbankgrenze).

**Vollzogen wird es seit AP-07 IP-13** (`V20260912190000`, Wegweiser
[`uems-endgueltigkeit-tageswerte.md`](./uems-endgueltigkeit-tageswerte.md)): dort wohnen der
Stundenlauf, der Werte umschaltet, die Spätankunft (`late_arrival` + Korrektur-Vorschlag an AP-08)
und die Tageswerte. Zwei Dinge an DIESEM Lauf hat IP-13 dafür geändert:

- **`verdichteEinenStapel(jetzt)`** bekommt die Uhr des Laufs. Findet er für einen
  `eingang`-Eintrag einen NACHZÜGLER (einen Rohwert, dessen Eingangszeit nach der Frist des
  Intervalls liegt), **bildet er das Intervall nicht**, sondern meldet und schlägt vor —
  *speichern, melden, vorschlagen, nicht anwenden*. Ohne Nachzügler bildet er wie bisher.
- **`berechnet_am` ist die Uhr des Laufs**, nicht mehr `Instant.now()`: der Tageslauf hängt seinen
  Zeiger an diese Spalte, und ein Lauf muss eine einzige Zeit haben.

## Die Rechenregeln werden AUFGERUFEN, nie nachgebaut

Menge aus Zählerständen, Rücksprung, Ersatzwerte und Zeitumstellung sind AP-08 und leben in
`uems/VerbrauchRegeln` (Vertrag mit Python-Zwilling, `docs/contracts/v2/verbrauch-vectors.json`).
Der Lauf ruft `VerbrauchRegeln.ergebnis(...)` und `periodenstand(...)` — er rechnet selbst nichts.

Die Brücke zwischen den Vokabularen steht an EINER Stelle (`ViertelstundeRegeln.regelWort`):
`counter → zaehlerstand`, `gauge → momentanwert`; `state`/`bitfield`/`text` haben **keine** Regel
(dann nur erster/letzter Wert, Qualitätszähler, Abdeckung — nie ein erfundenes Mittel).
**⚠ Befund:** AP-08 kennt eine dritte Wertart `intervallmenge`, für die das AP-07-Vokabular der
Rohwerte (`device_measurement_sample.value_kind`, IP-6) **kein Wort hat**. Die Spalte `summe`
steht bereit und der Weg dorthin ist verdrahtet; heute entsteht keine solche Reihe.

**Diese Stufe hatte KEINE `menge`-Spalte.** Gespeichert werden `stand_anfang`/`stand_ende` (Z1:
letzter guter Wert in `(t − Kadenz, t]`, nie fortgeschrieben), `summe`, `mittel`/`min`/`max` und
immer erster und letzter Wert. Die Differenz über die Intervallgrenze bildete AP-08 (A5: „die
Strecke rechnet keine Differenz") — **seit AP-08 IP-2 (`V20260912180000`) tut sie das, und die
Spalten `menge`/`menge_zustand`/`kennzeichen`/`faktor` stehen da**: `uems-viertelstundenmenge.md`.
Ebenso wird der **Faktor** einer Einstellungs-Fassung hier nie angewendet — auch in IP-2 nicht, weil
er beim Erfassen wirkt: gespeichert ist der Wert, wie die Box ihn geliefert hat, und `fassung` ist
der Anker dazu.

Die **Abdeckung** kommt aus der Kadenz, die **ZUM INTERVALL** galt (`KadenzRegeln.wirksam` mit der
Fassung zu `intervall_beginn`, IP-10) — nie der von „jetzt"; `kadenz_s` und `kadenz_herkunft`
stehen in der Zeile, damit `erwartet` erklärbar ist. Sie wird **nie auf 100 % gerundet** (Lauf und
CHECK).

## Die Arbeitsliste: wer füllt, wer leert, was bei gleichzeitigen Läufen

* **Gefüllt** aus zwei Quellen: der **Eingang** (jeder Rohwert, dessen `received_at` seit dem
  Zeiger dazugekommen ist — so findet der Lauf eine Nachlieferung von selbst, §4.5 Nr. 3, ohne
  festes Fenster) und die **Rückrechnung**. Der Zeiger läuft mit 2 min Sicherheitsabstand und
  2 min Überlappung: eine Transaktion, die später festschreibt, geht nicht verloren.
* **Geleert** vom Lauf: er ENTNIMMT einen Stapel und schreibt die Intervalle **in derselben
  Transaktion**.
* **Wächst nicht unbegrenzt:** der Primärschlüssel IST der Eintrag (dasselbe Intervall steht
  höchstens einmal darin), und die Rückrechnung pausiert oberhalb von `arbeit-hochwasser`
  (200 000), damit sie die Verdichtung nie überholt.
* **Gleichzeitige Läufe:** die Entnahme greift unter `FOR UPDATE SKIP LOCKED` — jeder bekommt
  einen anderen Stapel, keiner wartet, keiner verliert einen Eintrag.
* **Abbruch:** die Entnahme rollt mit der Transaktion zurück; der Eintrag steht wieder da und
  keine halbe Zeile in der Tabelle (geprüft, indem dem Lauf mitten im Stapel das INSERT-Recht
  entzogen wird).

## Wiederholbarkeit

Ein Intervall entsteht aus der **Menge** seiner Rohwerte, nie inkrementell fortgeschrieben (§4.5
Reihenfolge Nr. 3) — ungeordnete Zustellung ergibt darum Zeichen für Zeichen dasselbe Ergebnis
(A12). Ein zweiter Lauf über dieselben Intervalle schreibt **gar nichts**: der Vergleich im
`ON CONFLICT … DO UPDATE … WHERE` spart `berechnet_am` aus, eine unveränderte Zeile bleibt
unberührt.

## Die Anker (§4.4)

`geraet_einbau` / `box` kommen aus den **Werten** und aus den **Ereignissen, die einen Wechsel
nennen** — `device_boundary` (`einbau_alt`/`einbau_neu`, über das Einbau-Kennzeichen aufgelöst) und
`handover` (`box_alt`/`box_neu`). Sonst stünde der zweite Anker nicht da, wenn der Nachfolger im
Intervall noch gar nicht liefert (A5: Z-5b erst um 10:47; A6: Box Halle 2 erst um 07:31:10). Die
Reihenfolge ist die der **Zeit**. Ein dritter Anker wird in `*_weitere` **gezählt**, nicht
verschwiegen.

## Das vorbereitete Kompressions-Layout (E7)

TimescaleDB 2.17 lässt Kompression auf einer FORCE-RLS-Hypertable nicht zu. „Vorbereitet" heißt
darum: das Layout steht fest und ist abrufbar —
`SELECT * FROM messreihe_viertelstunde_kompression_layout()` liefert
`segmentby = 'tenant_id, entity_id, messkanal'`, `orderby = 'intervall_beginn DESC'` —, und die
Tabelle ist schon so geordnet (der Unique-Index führt mit der Reihe). Ein späterer Umbau (E7-B,
nach der Messung aus IP-16) ist ein `ALTER TABLE` mit genau diesen zwei Zeichenketten, ohne
Wanderung der Daten.

## Rückrechnung und Takt

Die einmalige Rückrechnung der letzten 90 Tage läuft **in Tagesscheiben** nebenher im Fünf-Minuten-
Takt, je Scheibe eine Transaktion: eine Unterbrechung kostet höchstens die angefangene Scheibe,
der Stand steht in `messreihe_viertelstunde_lauf` (`notiz = 'fertig'`, wenn durch). Sie fragt über
die **Messzeit** (Chunk-Ausschluss), das Eintragen aus dem Eingang über die **Eingangszeit**.

Schalter: `voltpilot.uems.viertelstunde.enabled` — Vorgabe **AN** (`application.yml`), im Testlauf
AUS (surefire). Wer den Lauf prüft, ruft `ViertelstundeVerdichter.lauf(...)` selbst.

## Rechte

App-Rolle: **nur SELECT** auf `messreihe_viertelstunde`, gar nichts auf Arbeitsliste und
Laufzustand. Geschrieben wird über die BYPASSRLS-Rolle — derselbe Weg wie beim Bestands-Rollup-Job
(`V20260848000000`). Das Offboarding räumt beide Mandanten-Tabellen ab
(`TenantRepository.offboard`).
