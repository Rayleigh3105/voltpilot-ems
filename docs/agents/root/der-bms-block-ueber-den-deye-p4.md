# Der BMS-Block über den Deye (P4): bei CAN-Kopplung meldet der Wechselrichter die Batterie selbst

Angelegt am 09.09.2026. Konzept `data/vp-deye-diybms-luecke-l5/report.md` §3.1/§3.3,
Bauplan-Paket **P4**. Es ist VORSORGE, kein Live-Fix: an der Anlage, die den Bauplan
ausgelöst hat, ist die Batterie NICHT CAN-gekoppelt (Deye im Spannungsmodus, der BMS-Block
war live komplett 0 — Beleg `evidence/ha-nodered-soc-flow-note.md`, Befund F16). P4 wirkt
erst an der ersten CAN-gekoppelten Anlage, und bis dahin ist es strukturell wirkungslos.

## Was gelesen wird

`deye_p3.yaml` Gruppe „BMS", **`0x00D2..0x00DF`** — 14 Register, EIN zusätzlicher FC03-Umlauf
je Poll unter derselben Socket-Lane. Der Block ist die dritte, **OPTIONALE** Lesung der
Familie `hybrid_3p` (`deye-decode.js` `FAMILIES.hybrid_3p.reads`), angehängt NACH Kennung
und Messblock.

| Register | Kanal | Skala |
|---|---|---|
| `0x00D2` / `0x00D3` | `bms_charge_voltage_v` / `bms_discharge_voltage_v` | ×0,01 · HV ×10 |
| `0x00D4` / `0x00D5` | `bms_charge_limit_a` / `bms_discharge_limit_a` — was das BMS GERADE erlaubt | ×1 |
| `0x00D6` | `bms_soc_pct` — der Ladestand des BMS selbst | ×1 |
| `0x00D7` | `bms_voltage_v` | ×0,01 · HV ×10 |
| `0x00D8` | `bms_current_a` (vorzeichenbehaftet) | ×1 · **HV ×0,1** |
| `0x00DA` / `0x00DB` | `bms_max_charge_limit_a` / `bms_max_discharge_limit_a` — die statischen Maxima | ×1 |
| `0x00DC` / `0x00DD` | `bms_alarm` / `bms_fault` (Bitfelder, ganzzahlig) | ×1 |
| `0x00DF` | `bms_type` (0 = PYLON … 10 = Shenggao CAN) | ×1 |

⚠ **Die HV-Doppelskala zeigt nicht überall nach oben.** Spannungen tragen
`scale: [0.01, 0.1]` (HV = ×10, wie PV/Batterie), der STROM trägt `scale: [1, 0.1]` — HV also
×0,1. Ein HV-Pack führt bei ~4-facher Spannung ~1/4 des Stroms, seine Firmware gibt die
16 Bit deshalb in AUFLÖSUNG statt in Reichweite aus. Deshalb hat der Feld-Spec ein eigenes
`hvFactor` neben `hvScale`; `hvScale` für den Strom meldete 30 A als 300 A.

## Vierzehn Nullen sind KEINE Batterie

Ein Deye ohne CAN-Kopplung beantwortet den Block mit lauter Nullen. Das ist die belegte
Signatur „nicht gekoppelt", nicht ein Pack, das „0 V / 0 A / 0 %" meldet — also entsteht
**kein einziger `bms_*`-Kanal** (`bmsCoupled()`: mindestens ein Register ≠ 0). Ein
fehlender oder abgelehnter Block genauso. Es gibt keinen Weg, auf dem hier eine 0 %, eine
0 V oder ein „BMS-Typ PYLON" entsteht.

## `0x00D6` ist die ZWEITE `missing`-Ausfahrt

Neben der Spannungsschätzung (#493, `soc_from_voltage`) hat die `missing`-Regel jetzt einen
zweiten Ausgang: meldet `0x024C` exakt 0 auf einem **nachweislich lebenden** Block, `0x00D6`
aber einen plausiblen Prozentwert, dann fährt die Anlage auf diesem Wert; `soc_source`
reist als `bms` auf dem lokalen Bus mit (die Schätzung bleibt `voltage`). Vier Regeln:

1. **Nur aus `missing`.** `no_answer` (Leerantwort) und `out_of_range` (kaputter Rahmen)
   bleiben harte Verwerfer — mit gekoppeltem BMS genau wie ohne.
2. **Ein echter `0x024C` wird nie überschrieben.**
3. **Dieselbe Plausibilität** wie für jeden SoC (> 0 und ≤ 100).
4. **Messung schlägt Interpolation:** die BMS-Ausfahrt gewinnt gegen die Spannungsschätzung.

⚠ **Sie braucht KEIN `allow_missing_soc`.** Das Opt-in regelt genau eine Entscheidung —
„eine Messung OHNE Ladestand veröffentlichen" —, und hier gibt es einen, vom Gerät selbst
gemeldet. Folgerichtig BESTEHT auch der Verbindungstest (`test-read.js`) mit diesem Wert,
statt weiter `unplausibel` zu melden: sonst wäre eine Anlage nicht anlegbar, deren Telemetrie
danach anstandslos liefe.

## Der Weg in die Cloud

`edge/telemetry` trägt die `bms_*`-Kanäle **neben** der Messung (der Go-Kern liest sie in
einem zweiten Durchgang, `agent.bmsChannels`, Präfix-Weißliste + Deckel) → Snapshot
`BmsReading` → additiver `bms`-Block am `primary`-Eintrag des `sources`-Herzschlags →
`SourceStatusListener` (dieselbe Weißliste) → `device_source_status.bms` (`jsonb`,
Migration `V20260911010000`) → `GET /api/v1/sites/{id}/sources` → Geräteseite, Block **„BMS"**
in der Sektion „Komponenten" (`geraetSeite.bmsZeilen`).

**Der eingefrorene v1-Telemetrievertrag bleibt unberührt** — die Kanäle werden NIE
Messkanäle, nichts davon geht in Puffer, Rollups, Erlöse oder den Optimierer. Es ist reine
SICHTBARKEIT, genau wie der Rest des `sources`-Blocks. Die Grenzen, die einen Sollwert
wirklich kappen, sind die v2-Entitäts-Kanäle des Schutzbausteins
([`der-schutz-grenzbaustein-p5c.md`](der-schutz-grenzbaustein-p5c.md)) — nicht diese.

Fällt die Kopplung weg, verschwindet der Block: **kein Hold-last**. Eine Grenze, die niemand
mehr gewährt, ist keine Grenze.

## Was NICHT dazugehört

Kein Schreibweg (`vp-deye-bench-cert` / `vp-deye-hybrid-control-p2` bleiben die Türsteher),
kein Optimierer-Eingang, keine Deutung der Alarm-/Fehler-Bitfelder (sie werden als CODE
gezeigt — eine Fläche, die eine URSACHE behauptet, bräuchte einen Fakt, der genau sie trägt),
und kein neuer Katalog-Eintrag (P8).
