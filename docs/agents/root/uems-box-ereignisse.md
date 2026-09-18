# UEMS: die Box meldet Ereignisse — `…/v2/events` auf der Box-Seite (AP-07 IP-19)

Neu angelegt am 18.09.2026. Gegenseite (schon gebaut, hier NUR erfüllt): Ereignis-Vertrag
[`events-vocabulary.md`](../../contracts/v2/events-vocabulary.md) §1–§4 und
[`mqtt-events-2.1.schema.json`](../../contracts/v2/mqtt-events-2.1.schema.json) (IP-3),
Datenannahme `services/ingest` `BoxEventsValidator` (IP-5), Senke/Writer (IP-8),
Lücken-Erkennung (IP-9). Box-Seite: `edge-app/core/internal/boxevents`.

- **Das Vokabular gehört der Cloud.** Eine Box darf GENAU SECHS Arten melden: `box_restart`,
  `device_restart`, `frozen_source`, `range_limit`, `layout_changed` und `data_gap` mit
  `erkannt_aus: verdraengung`. `boxevents.arten` ist der Spiegel von `$defs/box_*`; der Go-Test
  `TestVokabularIstDasDesVertrags` liest das Schema und vergleicht Pflicht- und erlaubte Felder
  Wort für Wort, `TestVertragsbeispieleEntscheidenGleich` die Beispiel-Umschläge.
- **⚠ `clock_jump` ist KEINE Box-Art.** Sein Urheber ist die `datenannahme` (§4, Spalte „Box“ =
  „—“), er liegt auf der EINGANGSZEIT-Achse und entsteht aus dem Vergleich zweier Umschläge
  derselben Box (§7). Eine Box, die ihn sendet, verliert den GANZEN Umschlag. Die Box tut
  stattdessen das Einzige, was ein Uhrsprung von ihr verlangt: sie stempelt nicht aus einer Uhr,
  die sie springen sah. `boxevents.ZeitWache` vergleicht Wanduhr gegen monotone Laufzeit
  (Schwelle 300 s wie `clock_ahead`), und `Startzeit` ist IMMER „jetzt minus Laufzeit“ — eine Box
  ohne Echtzeituhr meldet ihren Neustart also mit der nach NTP korrigierten Zeit, nicht mit 1970.
- **Zwei Outboxen, zwei Sequenzen.** `sequence` zählt die Umschläge DIESES Topics je Box
  (x-sequence-rule), deshalb hat der Ereignis-Strom seine eigene FIFO unter
  `<DataDir>/box-event-outbox`. Ein Uplink-Ausfall verliert nichts (QoS1, Datei erst nach PUBACK
  gelöscht), ein Replay verdoppelt nichts: `ereignis_id` wird EINMAL beim Ablegen vergeben, danach
  werden nur noch dieselben Bytes wiederholt.
- **Wer was melden darf.** Der Kern meldet `box_restart` (sein eigener Start, einmal je Start und
  erst, sobald es eine Kennung gibt) und die Puffer-Verdrängung. Ein Node-RED-Treiber liefert über
  den lokalen Bus `edge/events` die vier Geräte-Arten ein (`measurements/device-events.js`,
  Form wie `edge/data-sources/poll`: der Treiber sagt nur, WAS er sah). Ein Treiber-`box_restart`
  oder ein Treiber-`data_gap` wird abgewiesen — beides kann nur der Kern wissen.
- **⚠ Die Verdrängung wird EINMAL je Episode gemeldet, nicht je verworfenem Umschlag.** Solange
  der Uplink weg ist, verdrängt jeder Takt erneut; `measurements.Outbox` sammelt Fenster und Menge
  dauerhaft (`gap_von`/`gap_bis`/`gap_samples`/`gap_offen` in `state.json`) und gibt sie erst heraus,
  wenn ein Append NICHTS mehr verdrängt hat (`Verdraengung()`). Kommen danach gar keine Messwerte
  mehr, bleibt die Präzision aus — der Verlust selbst steht weiterhin als `gap`/`dropped_samples`
  am nächsten Mess-Umschlag.
- **`[von, bis)` halboffen:** `von` = `observed_at` des ältesten verworfenen Umschlags,
  `bis` = `observed_at` des ältesten ÜBERLEBENDEN. Ein Feld, das die Box nicht weiß, FEHLT —
  `erwartet_fehlend` wird nie 0, `datenquelle` nie erfunden.
- **Fähigkeit `events`** steht seit diesem Paket in `cloud.BuiltSupports()`, in
  `edge-supports-vectors.json` (`advertised: true`) und in `EdgeSupports.NAMES`; damit antwortet
  `BoxFaehigkeiten.kann(box, "events")` wahr, sobald eine Box es meldet. Die Regel aus AP-06 IP-18
  bleibt: gemeldet wird NUR, was gebaut ist.
- **Nicht hier:** die AUSLÖSER. Wann ein Statuswort-Bit `range_limit` bedeutet und wann ein
  stehender Herzschlag `frozen_source` wird, entscheidet der jeweilige Treiber — für WAGO ist das
  AP-05 IP-8. `device-events.test.js` zeigt nur, dass Befund und Herzschlag-Urteil der GEBAUTEN
  Kopf-Prüfung (`wago-kopf.js`, PR 945) ohne Umbau durch diesen Weg passen.
- **Kein Edge-Release.** `RUNTIME_VERSION`, Tags, Release-Register und Rollout unverändert; auf
  einer Box wirkt das alles erst mit einem späteren Release. Eine heutige Box sendet auf dem Topic
  nichts und meldet `events` nicht — die Cloud erwartet auch nichts.
