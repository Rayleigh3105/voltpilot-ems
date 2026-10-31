# Heizstab-Regler der Box (Vertrag)

Die Box wählt die Stufe eines Heizstabs selbst: aus, eine Phase, zwei Phasen oder alle drei. Grundlage ist der gemessene Überschuss im Haus. Das läuft im Go-Core von Edge Light und der Docker-Box gleich, ohne Node-RED und ohne Cloud (HZ-7 = A). Herkunft: Heizstab-Konzept V1, entschieden am 31.10.2026. Das Schalten der Ausgänge regelt [heizstab-shelly.md](heizstab-shelly.md).

Gemeinsame Vektoren: [heizstab-regler-vectors.json](heizstab-regler-vectors.json). Darin stehen gültige, ungültige und untätige Blöcke sowie Szenarien Takt für Takt. Die Box liest sie in `edge-app/core/internal/heizstab/heizstab_vectors_test.go`.

## Parameterblock `heizstab` (Registry-Push → Box)

Der Block steht additiv in der Entitätsbeschreibung. Das Schema ist [edge-entity.schema.json](edge-entity.schema.json) `$defs/heizstab`. Die Cloud übersetzt die Steuerart eines Heizstabs in diesen Block und baut dafür keinen Regel-Flow mehr. Sie sendet ihn nur an eine Box mit der Fähigkeit `heizstab_regler` ([edge-supports.md](edge-supports.md)); eine ältere Box überliest ihn.

| Feld | Vorgabe | Bedeutung |
|---|---|---|
| `modus` | – (Pflicht) | `ueberschuss` = PV-Überschuss in Stufen. Jeder andere Wert bedeutet: kein Regler. |
| `reserve_kw` | 0,2 | Was als Einspeisung stehen bleibt. |
| `hoechste_stufe` | oberste Stufe | Höchstens so viele Ausgänge zugleich, z. B. 1 = „nur eine Phase“. |
| `vorrang` | `speicher_zuerst` | Folgt der „Reihenfolge bei knapper Leistung“ im Portal (HZ-6): Steht der Stab unter dem Speicher, gilt `speicher_zuerst`; steht er darüber, `heizstab_zuerst`. |
| `mindestlauf_s` | 300 | Mindestlaufzeit, bevor der Stab ganz ausgeht. |
| `mindestpause_s` | 300 | Mindestpause, bevor er wieder angeht. |
| `haltezeit_s` | 120 | Wartezeit nach jedem Wechsel, bevor es aufwärts geht. |
| `schaltungen_je_stunde` | 12 | Schaltungen in der gleitenden Stunde, je geschaltetem Ausgang gezählt. |

Der Regler führt nur einen Stab, dessen Treiber eine gültige Ausgangsmenge trägt (`driver.connection.channels`, auch eine Menge aus nur einem Ausgang). Nur so kennt er die Stufen und ihre kW. Für jeden anderen Treiber schaltet er nichts und schreibt den Grund einmal ins Log.

## Regeln

Grundlage sind die Messwerte aus dem Haus. `netz` ist der Netzpunkt mit Vorzeichen, `speicher` die gemessene Speicherleistung (+ laden, − entladen). Die Stableistung ist gemessen oder, ohne Messung, die kW der **bestätigten** Stufe aus der Rücklesung.

```
überschuss = −netz + min(0, speicher)    (speicher_zuerst)
überschuss = −netz + speicher            (heizstab_zuerst)
verfügbar  = überschuss + Stableistung − reserve_kw
Ziel       = höchste erlaubte Stufe mit kW ≤ verfügbar
```

- **Eigenlast zählt zurück.** Ein laufender Stab frisst den Überschuss nicht weg, der ihn gestartet hat; der Regler flattert deshalb nicht.
- **Speicher:** Eine Entladung des Speichers zählt immer gegen den Stab. Ein Speicher, der in den Stab entlädt, ist nie Überschuss. Ohne Speichermessung fällt `heizstab_zuerst` auf den gemessenen Ist-Zustand zurück.
- **Aufwärts:** erst wenn der Überschuss für die höhere Stufe 60 s anliegt, eine Stufe auf einmal. Nicht innerhalb der Haltezeit nach einem Wechsel, nicht aus „aus“ innerhalb der Mindestpause und nicht über die Schaltgrenze hinaus.
- **Abwärts:** nach 30 s Netzbezug über 0,1 kW sofort auf die Stufe, die passt. Ganz aus geht es erst nach der Mindestlaufzeit; so lange bleibt die kleinste Stufe, also höchstens so lange Netzbezug.
- **Höchste Stufe gesenkt:** Der Regler folgt sofort.
- **Messwerte fehlen:** Ist die Netzmessung älter als 30 s oder die Stableistung unbekannt, startet keine neue Stufe. Nach 60 s ohne Messwerte ist der Stab aus.
- **Ohne Cloud** läuft der Regler weiter: Er liest nur die Registry auf der Platte und die Messwerte aus dem Haus. Ein Plan läuft ab, der Regler nicht.

## Ausführung

Jeden Takt (1 s) reicht der Regler seine Stufe als Wunsch an den Arbiter: `setpoint_kw` = kW der Stufe, Quelle `heizstab` (nur intern, von außen nie annehmbar), Klasse `flow` (Regel, Rang 40), TTL 45 s.

Darüber behalten alle anderen ihr Wort:

- ein Handeingriff wie „Jetzt heizen“ (75);
- die Schutzgrenzen und der Zyklen-Guard;
- „Automatik pausieren“ (der Arbiter setzt Regelwünsche aus).

Einen Stab, den der Regler führt, lässt der Plan-Executor in Ruhe. Das ist die Regel von `owner_claimed`, angewandt auf die Regel der Box. Ohne `VP_CONSUMER_CONTROL_ENABLED` geht kein Wunsch hinaus.

Den Zustand je Stab hält die Box in `data_dir/heizstab-state.json`: Stufe, seit wann, zuletzt ein und aus, Schaltungen der letzten Stunde. Ein Neustart verkürzt so weder eine Pause noch einen Mindestlauf. Der allgemeine Zyklen-Guard des Arbiters bleibt, wie er ist; er vergisst beim Neustart bewusst.

## Herzschlag: `consumers.{id}.heizstab`

Additiv, nur für einen Stab mit Regler:

- `stufe`, `ausgaenge` und `kw`: die Stufe, die der Regler will;
- `code` und `grund`: maschinenlesbar und als deutscher Satz;
- `verfuegbar_kw`: fehlt, solange Messwerte fehlen;
- `hoeher_ab`: der früheste Wechsel nach oben;
- `seit`: der letzte Wechsel.

Die Codes sind:

| Code | Bedeutung |
|---|---|
| `ueberschuss` | heizt mit Überschuss |
| `kein_ueberschuss` | kein Überschuss (mehr) |
| `ueberschuss_pruefen` | Überschuss für eine höhere Stufe, die 60-s-Prüfung läuft |
| `mindestpause` | Mindestpause läuft |
| `mindestlauf` | Mindestlauf läuft |
| `haltezeit` | Haltezeit nach einem Wechsel läuft |
| `schaltgrenze` | Schaltgrenze je Stunde erreicht |
| `messwerte_fehlen` | frische Messwerte fehlen |
| `hoechste_stufe` | höchste erlaubte Stufe wurde gesenkt |
| `stufen_unbekannt` | die kW je Stufe sind unbekannt |

Was das Gerät tatsächlich bestätigt, steht daneben in `consumers.{id}.stage` ([heizstab-shelly.md](heizstab-shelly.md)).

## Freigabe

Bis zum Katalog-Flip von `heating-rod` (HZ-9 = B: Prüfstand mit Lampen, dann echter Stab) sendet die Cloud den Block nur an die Prüfstand-Box. Dieser Vertrag hebt keine Freigabe auf.
