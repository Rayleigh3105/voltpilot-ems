# Heizstab über eine Shelly-Ausgangsmenge (Vertrag)

Ein Heizstab mit einem Heizelement je Phase hängt an mehreren Ausgängen eines Shelly (Shelly Pro 3: Ausgang 0, 1, 2 = L1, L2, L3). VoltPilot führt ihn als **ein** Gerät und schaltet ihn in **Stufen**. Eine Stufe ist die Zahl der Ausgänge, die zusammen an sind; „alle zusammen“ ist die oberste Stufe, „eine Phase“ die unterste. Herkunft: Heizstab-Konzept V1, entschieden am 31.10.2026 (HZ-1 bis HZ-10).

Gemeinsame Vektoren für Box und API: [heizstab-stufen-vectors.json](heizstab-stufen-vectors.json). Die Box liest sie in `edge-app/core/internal/shelly/group_vectors_test.go`.

**Nur Stern mit N.** Der Pro 3 schaltet höchstens 240 V je Kontakt. Die Box schaltet die Ausgänge nacheinander, eine Anfrage je Ausgang. Liegen die Elemente im Dreieck oder im Stern ohne N, stehen dabei 345 bis 400 V über einem offenen Kontakt. Eine Ausgangsmenge entsteht deshalb nur für einen Stab in Stern mit N. Die Box sieht den Anschluss nicht, sie bekommt nur die Ausgangsmenge.

## Treiberblock (Registry-Push → Box)

Der Treiber bleibt `communication: "shelly_http"`. In `driver.connection` kommen additiv vier Felder hinzu:

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `channels` | ja | Die Ausgänge in Phasenfolge, je 0–3, höchstens vier, keiner doppelt. Fehlt das Feld, gilt der bisherige Weg mit einem Ausgang (`channel`), byte-gleich. |
| `output_kw` | ja | Leistung des Elements hinter jedem Ausgang in kW, in der Reihenfolge von `channels`, jeweils > 0 (Typenschild). |
| `stages` | nein | Erlaubte Zahl gleichzeitig eingeschalteter Ausgänge, aufsteigend, je 1 bis Zahl der Ausgänge. Fehlt das Feld, gilt nur „alle zusammen“. |
| `rotation` | nein | Phasenwahl einer Teilstufe: `daily` (Vorgabe, HZ-3 = A: der Startausgang wandert täglich L1 → L2 → L3) oder `fixed` (immer der erste Ausgang). |

Die übrigen Felder bleiben wie bisher: `ip`, `port`, `on_timer_s`.

Die Cloud legt einen solchen Stab als Gerät vom Typ `heating-rod` an (`POST …/components` mit `consumerType: heating-rod`). In der Verbindung steht dann zusätzlich `anschluss` (`stern_mit_n` | `ohne_n` | `dreieck` | `unbekannt`); die Box überliest dieses Feld. Mehrere Ausgänge gibt es nur bei `stern_mit_n`. Bei `unbekannt` schaltet der Stab nicht, weder automatisch noch von Hand, bis der Anschluss bestätigt ist. Die Cloud prüft außerdem, dass jeder Ausgang genau einem Gerät gehört und die Box `heizstab_regler` meldet. Das Verbraucherprofil wird ein Stufenprofil: `stepped`, `levels_kw = [0, kW je Stufe …]`, `storage_first`. Ein Handeingriff wählt eine dieser Stufen (`stufe`, 1-basiert), nie einen Wert dazwischen.

Die Box lehnt eine ungültige Menge mit einem deutschen Satz ab und schaltet dann nichts. Die Sätze stehen in den Vektoren unter `validate`. Teilstufen gibt es nur mit Elementen bis 4,6 kW, sonst entstünde mehr Schieflast, als VDE-AR-N 4100 erlaubt.

Für den Lesepfad (Quelle der Box) zählt nur `channels`. Die Quelle eines Stabs bekommt eine eigene Identität (`set:0,1,2`) und teilt sie nie mit einem einzelnen Ausgang desselben Geräts.

## Stufenwahl (Box, rein)

- **Nie mehr als befohlen.** Ein Sollwert wählt die höchste erlaubte Stufe, deren Leistung hineinpasst. Gemessen wird mit den größten Elementen, damit auch ein Stab mit ungleichen Elementen nie mehr zieht.
- **Ausdrücklich „an“ ohne Sollwert** ist die höchste erlaubte Stufe. „Aus“ und ein Sollwert unter der kleinsten Stufe sind aus.
- **Ohne frischen Befehl** sind alle Ausgänge aus (§4.2).
- **Ein Lauf wechselt nie mitten im Betrieb die Phase.** Ausgänge, die schon laufen, behalten Vorrang; die Rotation wirkt erst beim nächsten Start.
- **Erst AUS, dann EIN.** Schlägt ein AUS fehl, geht in diesem Durchlauf kein EIN hinaus. Jedes EIN trägt seinen eigenen Totmann-Timer (`toggle_after`, 180 s).
- **Der Re-Assert alle 60 s** schreibt alle Ausgänge neu, auch die ausgeschalteten.
- **Abweichung (HZ-4 = B, keine Sperre):**
  - Ein Ausgang, der nicht eingeschaltet hat, wird beim nächsten Re-Assert erneut geschrieben.
  - Ein Ausgang, der an ist, obwohl er aus sein soll, bekommt sofort AUS, noch im selben Durchlauf. Bis dahin zählt er zur Stufe; die übrigen Ausgänge halten die Summe ≤ befohlen.

## Rücklesung `edge/entities/{id}/readback`

Eine Anfrage liest alle Ausgänge: Gen2 `Shelly.GetStatus`, Gen1 `/status`. Die v1-Form bleibt, mit drei Zusätzen:

- **`registers`**: ein Eintrag je Ausgang (`role: "relay"`, `key: "output"` bzw. `"ison"`) mit `channel`, `commanded`, `actual` und `match`. Bei einer Abweichung steht dort `mismatch_since` (RFC 3339), der Zeitpunkt, seit dem dieser Ausgang vom Befehl abweicht.
- **`stage`**:
  - `commanded` und `commanded_kw`: die Ausgänge, die der Plan laufen lässt, einschließlich eines mitgezählten Ausgangs, der fälschlich an ist.
  - `confirmed` und `confirmed_kw`: was das Gerät meldet.
  - `outputs_on`: die Ausgänge, die das Gerät als eingeschaltet meldet.
  - `counted`: Ausgänge, die an sind, obwohl sie aus sein sollen.
  - Ist ein Ausgang ungelesen, sind `confirmed` und `confirmed_kw` `null`. Unbekannt ist nie „aus“.
- **`on`**: der Stab heizt, d. h. mindestens ein Ausgang ist an.

`all_match` ist nur wahr, wenn jeder Ausgang seinen Befehl meldet. Gemessene Leistung (`power_kw`) gibt es nur, wenn **jeder** Ausgang misst; dann ist sie die Summe. Der Pro 3 misst nicht.

## Herzschlag: Verbraucherblock

Zu `consumers.{id}` kommt additiv `stage` hinzu:

- `commanded` und `commanded_kw`
- `confirmed` und `confirmed_kw` (fehlen, solange unbekannt)
- `outputs_on`
- `mismatch_since`: Beginn der ältesten noch laufenden Abweichung
- `at`: Zeitpunkt der Lesung

Das ist der Beleg, mit dem das Ledger die Energie aus den kW der **bestätigten** Stufe rechnet statt aus Nennleistung × Zeit. Die Cloud schreibt dafür je Herzschlag die Laufzeit-Differenz der Box × kW der zuvor gemeldeten Stufe fort (`consumer_runtime_status.stufe_energie_kwh_heute`); fällt der Laufzeit-Zähler der Box, beginnt ein neuer Tag.

## Verbindungstest und „nach Stromausfall“ (Probe, [mqtt-probe.schema.json](../mqtt-probe.schema.json))

- **`test_connection`** mit `connection.channels` braucht zwei Anfragen wie bei einem Ausgang (`/shelly`, `Shelly.GetStatus`). Die Antwort enthält:
  - je Ausgang eine `samples`-Zeile `relay_on_<kanal>` (0/1);
  - den Block `ausgaenge` mit `kanal`, `ein` und `nach_stromausfall`.

  Die Einstellung „nach Stromausfall“ liest die Box mit einer dritten Anfrage, nur wenn der Test dafür noch Zeit hat (≥ 4 s). Sonst fehlt sie; sie wird nie geraten. Alles außer `off` heißt: Nach einem Stromausfall ohne Box heizt der Stab weiter (HZ-5).
- **`nach_stromausfall_aus`** (neue Op, nur Marke `shelly`) stellt an jedem Ausgang „nach Stromausfall: aus“ ein, nur auf ausdrückliche Zustimmung im Portal. Dazu gibt es einen Schreibbefehl je Ausgang: Gen2 `Switch.SetConfig`, Gen1 `/settings/relay/N`. Das ist eine Einstellung, kein Schaltbefehl. Die Antwort meldet den danach gelesenen Wert in `ausgaenge`. Eine ältere Box antwortet `not_supported`.

## Doppelte Schreiber

Beanspruchen zwei Geräte denselben Ausgang (eine Ausgangsmenge über einem Ausgang, der schon eine eigene Komponente ist), schreibt die Box auf keinem von beiden. Beide melden in der Rücklesung „Ausgang N gehört zu zwei Geräten …“. Die API verhindert das schon beim Anlegen; die Box ist die zweite Sperre.

## Freigabe

Der Typ `heating-rod` bleibt `simulator_only` (HZ-9 = B): erst der Prüfstand mit drei Lampen, dann der echte Stab, dann der Katalog-Flip. Dieser Vertrag ändert an der Freigabe nichts. Geschaltet wird nur hinter den beiden Box-Schaltern `VP_CONTROL_ENABLED` und `VP_CONSUMER_CONTROL_ENABLED`.
