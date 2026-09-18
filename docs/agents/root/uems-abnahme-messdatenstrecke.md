# UEMS-Abnahme der Messdatenstrecke: A1…A16 und ihr Nachweis (AP-07 IP-21)

Die Schlussabnahme des Konzepts „Messdatenstrecke, Herkunft, Aufbewahrung" (AP-07 §7).
Sie baut keinen Test ein zweites Mal: die meisten Abnahmefälle haben ihr eigenes Paket
mitgebracht. Diese Seite ist die **Klammer** — je Fall genau die Klasse und die Methode,
die ihn beweist. `UemsAbnahmeKlammerTest` liest die Tabelle unten und lässt sie nicht
verrotten: eine Zeile, deren Klasse oder Methode es nicht mehr gibt, macht ihn rot.

Neu mit IP-21 sind nur drei Dinge:

1. **Die fünf Störungs-Szenarien des Simulators durch die echte Strecke** —
   `UemsStreckeAbnahmeTest` spielt die Zustellungen aus AP-07 IP-20 über ein echtes
   Redpanda in den echten Writer und vergleicht Zeilen und Ereignisse in einer echten
   TimescaleDB.
2. **Der Rohdatenablauf als Tat, nicht als Annahme** — `UemsRohdatenablaufAbnahmeTest`
   lässt einen Chunk älter als 90 Tage mit `drop_chunks` wirklich fallen und fragt
   danach A2, A7 und A8 gegen den Lesepfad.
3. **Der Bericht-Datenstand als Fixture für AP-12** — derselbe Lauf hält fest, woraus
   der Datenstand gebildet wird, nachdem die Rohwerte weg sind.

## Das Drehbuch ist erzeugt, nicht geschrieben

`tools/edge-simulator/abnahme/ap07-szenarien.json` trägt je Szenario die vollständigen
Zustellungen, die erwarteten `events.raw`-Nutzlasten, die erwarteten Zeilen je Messstelle
und die Stammdaten, ohne die die Strecke keine Rolle auflösen könnte. Der Java-Lauf
startet kein Python; damit beide nicht auseinanderlaufen, hängen **zwei** Wächter daran:

- `tools/edge-simulator/test_ap07_abnahme_fixture.py` erzeugt die Datei neu und
  vergleicht sie Zeichen für Zeichen mit der eingecheckten.
- `UemsStreckeAbnahmeTest#dasDrehbuchIstDasDesSimulators` rechnet die sha256 über die
  **Bytes** der Datei nach (`…json.sha256` daneben). Die Prüfsumme *im* Inhalt hängt an
  Pythons Schreibweise für Zahlen; die über die Bytes ist in jeder Sprache dieselbe.

Wiederherstellen mit `cd tools/edge-simulator && make abnahme`; danach die
Abnahme-Klassen erneut fahren.

⚠ **Die fünf Szenarien benutzen dieselben Ahrenberg-Kennungen** (Box E-2 liest in A1, A3
und A4). In EINER Datenbank würden sie sich Box und Komponente gegenseitig überschreiben
— `device.id` und `measurement_point.id` sind Primärschlüssel. Der Lauf bildet darum
`device_id` und `entity_id` je Szenario deterministisch auf eine eigene Kennung ab; an
der Strecke ändert das nichts, sie liest Kennungen und deutet sie nicht.

## Die Tabelle

| Fall | Worum es geht | Nachweis |
|---|---|---|
| A1 | Wiederholtes Paket verdoppelt keinen Verbrauch | `WriterPipeTest#dasselbePaketZweimalIstEinWertEinWiderspruchIstEinEreignis` · `UemsStreckeAbnahmeTest#a1_dieWiederholungVerdoppeltKeinenVerbrauch` |
| A2 | Nach dem Rohdatenablauf bleibt der lange Auswertungsumfang | `UemsLesepfadTest#a2_jedeViertelstundeTraegtIhreHerkunft` · `UemsViertelstundeMigrationTest#a2NachDemRohdatenablaufTraegtDerViertelstundenwertNochAlles` · `UemsRohdatenablaufAbnahmeTest#a2_nachDemEchtenChunkDropTraegtJedeViertelstundeIhreHerkunft` |
| A3 | Ausfall und Nachlieferung | `UemsLueckenMelderTest#a3_rueckkehrUndNachlieferungSchliessenDieLuecken` · `UemsStreckeAbnahmeTest#a3_dieNachlieferungFuelltDenAusfall` |
| A4 | Nachlieferung unvollständig, der Puffer hat verdrängt | `UemsLueckenMelderTest#a4_unvollstaendigeNachlieferung_dieZaehlungNenntDenVerdraengtenTeil` · `UemsStreckeAbnahmeTest#a4_dieVerdraengtenMesszeitenBleibenLuecke` |
| A5 | Zählerwechsel MS-06 mit Lücke | `UemsViertelstundeMigrationTest#a5DerZaehlerwechselImIntervallNenntBeideEinbautenUndRechnetKeineDifferenz` · `UemsZaehlerbruecheTest#f4GeraetegrenzeMitAblesestaendenIstUeberDenWechselVollstaendig` |
| A6 | Edge-Wechsel DQ-3 mit Herkunftswechsel | `WriterPipeTest#derNachzueglerIstFuehrendUndDerSpaetereEinSpiegel` · `UemsViertelstundeMigrationTest#a6DieUebergabeImIntervallNenntBeideBoxen` · `UemsStreckeAbnahmeTest#a6_derNachzueglerIstFuehrendDerSpaetereEinSpiegel` |
| A7 | Wert nach 91 Tagen | `UemsLesepfadTest#a7_einZeitraumJenseitsDerFristLiefertWerteStattEinesFehlers` · `UemsRohdatenablaufAbnahmeTest#a7_dieRohwertAbfrageNachDemChunkDropSagtEsUndWirftNicht` |
| A8 | Bericht Oktober 2026 im Jahr 2031 | `BerichtAbzugBildungTest#dieBildungBrauchtKeineRohdaten_einZeitraumJenseitsDerNeunzigTageLiefertDenselbenAbzug` · `UemsRohdatenablaufAbnahmeTest#a8_derBerichtDatenstandIstNachDemChunkDropReproduzierbar` |
| A9 | Doppel-Lesen aus zwei Boxen ohne Bestätigung | `WriterPipeTest#derNachzueglerIstFuehrendUndDerSpaetereEinSpiegel` |
| A10 | Spiegel Kern-Kanal / Katalogpunkt desselben Registers | `KernSpiegelTest#a10NativeAndFanoutAnnotateOnlyTheCoreAndKeepItsValue` |
| A11 | Gleiche Messzeit, abweichender Wert | `WriterPipeTest#dasselbePaketZweimalIstEinWertEinWiderspruchIstEinEreignis` |
| A12 | Ungeordnete Zustellung | `UemsViertelstundeMigrationTest#a12DieUngeordneteZustellungErgibtDenselbenWert` |
| A13 | Uhr der Box geht vor | `DatenannahmeTest#a13DieUhrDerBoxLindachGeht14MinutenVor` · `UemsStreckeAbnahmeTest#a13_keinWertInDerZukunft` |
| A14 | Unclaim löscht keine gebundene Reihe | `UemsLoeschwegeApiTest#a14_abmeldenVerliertKeinenWertUndBelegeSperrenPurgeUndAnlage` |
| A15 | Kadenz als Fakt: Abdeckung ohne Auffüllung | `UemsViertelstundeMigrationTest#dieAbdeckungWirdNieAufHundertProzentGerundet` · `UemsViertelstundeMengeTest#dieDatenbankgrenzeWeistDasErfundeneAb` |
| A16 | Budget mit Benchkosten je Ziel und Familie | `MeasurementBudgetVectorsTest#releasedRuntimeCatalogKeepsEveryCloudCostAndVersion` · `MeasurementBudgetVectorsTest#unbenchedRegisterAtFiveSecondsWasAlreadyRejectedByTheCloud` |

## Befunde am Drehbuch (AP-07 IP-20)

Die Abnahme hat das Drehbuch zum ersten Mal gegen die echte Strecke gehalten. Fünf Stellen
sagen etwas anderes als der Vertrag. **Keine davon ist ein Fehler im Produktivcode** — der
Writer verhält sich jedes Mal nach seiner dokumentierten Regel. Die Abnahme rechnet deshalb
nach der REGEL, nicht nach der Aufzählung, und der Wächter im Lauf meldet jede NEUE Abweichung.

| Stelle | Drehbuch | Vertrag und Wirklichkeit |
|---|---|---|
| A3 `data_gap`, `backfill` | `urheber: writer` | Schreibt der **Lücken-Melder** (IP-9, Takt in `services/api`, urheber `cloud`). Der Writer sieht beim Einlauf einen einzelnen Wert und kann eine Lücke nicht kennen. |
| A4 `late_arrival` | `urheber: writer` | Schreibt der **`SpaetankunftMelder`** (IP-13). Ob die Viertelstunde schon endgültig war, weiß erst die Verdichtung. |
| A4 `sequence_gap` | zählt **einen** Sprung auf (48 214 → 48 402) | `MesswertEreignisse`: EINMAL JE UMSCHLAG, dessen Sequenz springt. Gespielt werden **vier** Sprünge (7 → 48 402 → 52 002 → 55 601 → 62 001) — und ein Rücksprung 48 213 → 7, den das Drehbuch gar nicht nennt. |
| A6 `erwartete_reihen` | 7 führende Zeilen je Reihe | Der „Nachzügler mit Messzeit VOR dem Wechsel" (Sequenz 90 503) trägt **05:29:50 — genau die Messzeit des Umschlags 90 502**, der schon liegt. Die Idempotenz (E3) speichert ihn zu Recht kein zweites Mal: es sind **6**. Der Fall kann damit nicht zeigen, was er zeigen will; das tut `WriterPipeTest#derNachzueglerIstFuehrendUndDerSpaetereEinSpiegel` mit eigenen Messzeiten. |
| A6 `unassigned_reader` | **vier**, eine je Messstelle | EINMAL je Umschlag, Box und Datenquelle, gebündelt mit `anzahl`, gedrosselt auf höchstens einmal je Stunde. Gespielt wird EIN Umschlag mit gespiegelten Werten, also **eins** — so sagt es auch der Abnahmetext A9 selbst („≤ 1 je Stunde"). |

## Zwei Befunde an der Strecke

- **Die Datenannahme reicht die 2.1-Herkunftsfelder nicht weiter.** `MeasurementSamplesValidator`
  prüft `applied_revision` (Wurzel) und `entity_id` (je Sample) und **entfernt beide**, bevor der
  Umschlag nach `measurements.raw` geht; sein Kommentar nennt das Weiterreichen noch als offene
  Nacharbeit „needs the writer in the same step – IP-6/IP-7", **beide sind gebaut**. Sachlich ist
  es heute richtig: der Writer schlägt Komponente, Fassung und Rolle ZUR MESSZEIT selbst nach, und
  ein Umschlag mit Herkunft am Draht würde genau diese Auflösung umgehen. Veraltet ist nur der
  Kommentar.
- **Der Writer prüft Topic- und Umschlag-IDENTITÄT** (`ems/<mandant>/<anlage>/<box>/v2/measurement-samples`).
  Stimmt sie nicht, ist die Nachricht weg — eine `WARN`-Zeile, sonst nichts. Wer eine Abnahme
  baut, merkt das erst an leeren Tabellen; der Lauf hat darum einen Vorlauf, der genau das sagt.

## Was die Abnahme NICHT beweist

- **Die Naht zur Datenannahme.** `UemsStreckeAbnahmeTest` spielt ab `measurements.raw`,
  also Writer → Datenbank. Der Schritt davor (MQTT → Datenannahme → `measurements.raw`)
  gehört `services/ingest`; A13 lebt genau dort. Der Abnahmelauf spielt für A13 darum nur
  die angenommenen Zustellungen und belegt, dass die anderen nach derselben Grenze
  abzuweisen sind — dass sie es werden, zeigt `DatenannahmeTest`.
- **Der Bogen Box → Bericht in EINEM Lauf.** Er ist in zwei Hälften belegt, nicht in
  einer: gespielte Samples → Rohzeilen mit Herkunft (`UemsStreckeAbnahmeTest`) und
  Viertelstunde → Tag/Periode → Messstellen-Werte → gebildeter Abzug
  (`UemsRohdatenablaufAbnahmeTest`). Die beiden Hälften treffen sich an der
  Viertelstunden-Bildung, die als Takt läuft und im Test angestoßen wird — **kein
  einziger Lauf trägt heute von der Box bis in den freigegebenen Bericht durch**. Das ist
  der offene Befund aus dem AP-14-Fundament; er bleibt offen und wird hier nur benannt.
- **A6 und der Abnahmetext.** §7 A6 erwartet für 07:30–07:45 „beide Boxen als Anker".
  Mit dem letzten führenden Wert um 07:29:50 hat die Viertelstunde nur die NEUE Box als
  Anker; beide erscheinen erst in der Herkunfts-Karte, weil das Intervall eine
  Spiegelzeile der alten Box trägt. Die Zeitstempel entscheiden, nicht der Abnahmetext
  (Befund aus AP-07 IP-20).
