# Deye-Ladeseite: Drehbuch für die Pilotfenster (K5)

Der Deye SUN-30K-SG01HP3 (Herzogau, Fernsteuer-Block 1100–1121, PR-978-Lage) soll die **Ladeseite** selbst regeln: nur Überschuss laden (E↑, `surplus_charge`) und Eigenverbrauch (E, `self_consumption`). **Freigegeben ist davon nichts.** Bis ein Pilotfenster es belegt, regelt die Box die Ladeseite gedämpft (K1). Der E↓-Weg (`cover_load`, `1100 ← 0`) bleibt unverändert.

Jeder Test läuft in einem **betreuten Fenster von höchstens 15 Minuten** (Captain-Entscheid E7 A). Der Captain löst jeden Test selbst aus. Das Fenster startet nie von selbst und nie nach Zeitplan.

## Die zwei Kandidaten

| Kandidat | Was die Box schreibt | Was dann regelt | Rückfall letzter Instanz |
|---|---|---|---|
| `grid_zero` – „netzseitig Ziel 0“ | `1101 ← 60`, `1109 ← 0` (Neutralschritt **vor** dem Seitenwechsel), `1104 ← 2`, `1115 ← 999`, zuletzt `1100 ← 1`. Danach je Takt nur der Herzschlag `1101`/`1109`/`1100`. | Der Deye regelt seinen Netzzähler auf 0. Der Zähler sieht auch die Fronius. | Totmann `1101`: Schweigt die Box 60 s, verlässt der Deye die Fernsteuerung. |
| `own_config` – „Eigenkonfiguration“ | einmal `1100 ← 0`, dann nur Lesen | Die eigene Einstellung des Deye (Arbeitsmodus, Energiemuster, Solar Sell, Zeitfenster-Programm). | Die Eigenkonfiguration ist der Rückfall. |

`grid_zero` hat eine **Nebenwirkung** (Konzept §6.3): Nimmt der Speicher nichts mehr auf, drosselt der Deye seine **eigene** PV, auch bei positivem Preis. Die Box nimmt deshalb zurück, sobald der Ladestand die Obergrenze − 3 Prozentpunkte erreicht. Sie nimmt auch zurück, wenn der Speicher länger als 60 s an der Ladegrenze lädt und die Anlage dabei einspeist (Grund `pv_abgeregelt`). Deckelt der Plan die PV ohnehin (Negativpreis, §51), bleibt der Modus stehen.

Die Box schreibt **nie** Installateur- oder EEPROM-Register: nicht Work Mode, nicht Time of Use, nicht `0x00E7`, nicht `0x006C`/`0x006D`. Für `own_config` **liest** sie die Einstellung in einem Blocklesen `0x008D..0x00B1`. Passt sie nicht, verweigert die Box mit deutschem Grund (E5 A).

| Einstellung | Wird verweigert, wenn … |
|---|---|
| Arbeitsmodus `0x008E` | 1 „Zero Export To Load“ (regelt nur den Lastausgang) oder ein unbekannter Wert |
| Energiemuster `0x008D` | 0 „Battery First“: lädt vor dem Hausverbrauch, das Haus bezieht dabei Netzstrom |
| Solar Sell `0x0091` | aus bei „Zero Export To CT“: PV würde abgeregelt statt eingespeist |
| Netzladen (EEG) | das **gerade gültige** Zeitfenster-Programm erlaubt Laden aus dem Netz |
| E↑ | Zeitfenster-Programm an **und** das gültige Programm hat Leistung > 0 (der Deye würde entladen) |
| E | Zeitfenster-Programm aus, Leistung 0, Ziel-SoC über der Reserve, **oder Arbeitsmodus 0 „Selling First“**. Laut Handbuch darf er mit aktivem Zeitfenster-Programm dann auch Speicherenergie verkaufen. |

**Herzogau heute:** Selling First, Load First, Solar Sell an, Zeitfenster-Programm aktiv. Die Box verweigert `own_config` für E wegen „Selling First“. Für E↑ passt die Einstellung nur, wenn das gerade gültige Programm Leistung 0 hat. Deshalb kommt zuerst `grid_zero` dran (E5 A: erst der Weg ohne Umstellung). Eine Umstellung beim Installateur ist erst dran, wenn `grid_zero` scheitert.

## Auslösen und Abbrechen

Über den Wartungstunnel auf die Box (`:8484`). Jede Handlung braucht das Betreiber-Kennwort, genau wie beim Netz-Sollwert-Test:

```sh
BOX=http://10.10.1.23:8484 ; TOK='<Betreiber-Kennwort>'
# Starten: Kandidat, Absicht, Prüffall, Minuten (1..15, Vorgabe 10)
curl -s -X POST -H "X-VP-Calibration-Token: $TOK" -H 'Content-Type: application/json' \
  -d '{"candidate":"grid_zero","intent":"surplus_charge","case":"F11","minutes":15}' $BOX/api/native/pilot
# Beobachten (offen, kein Kennwort)
curl -s $BOX/api/native/pilot | jq .native_pilot.run
# Sofort beenden – der Plan übernimmt im nächsten Takt
curl -s -X POST -H "X-VP-Calibration-Token: $TOK" $BOX/api/native/pilot/abort
```

Die Box verweigert den Start mit HTTP 400 und deutschem Satz in diesen Fällen: Not-Aus, keine First-Light-Freigabe, kein Fernsteuerpfad, ein anderer Test läuft, Messwerte älter als 15 s, Reserve unbekannt, Ladestand an der Reserve oder ab 95 %.

## Welcher Test bei welchem Wetter

| Reihenfolge | Fall | Wetter / Zeit | Anfrage | Bestanden, wenn (Konzept §8) |
|---|---|---|---|---|
| 1 | **F11** Fremd-PV | Sonne, Fronius speist ≥ 10 kW ein, Deye-PV klein, SoC 30–80 % | `grid_zero`, `surplus_charge`, `F11`, 15 min | `einspeisung_trotz_ladeleistung_kwh` ≈ 0 und `max_einspeisung_kw` ≤ 0,5 bis Ladegrenze oder 95 %; `netz_in_speicher_kwh` ≈ 0 |
| 1b | F11 für E | wie oben | `grid_zero`, `self_consumption`, `F11` | wie oben |
| 2 | **F1/F2** Wolken | Haufenwolken-Nachmittag | `grid_zero`, die in F11 bestandene Absicht, `F1` bzw. `F2`, 15 min | F1: Bezug > 1 kW höchstens 5 s je Kante, höchstens ein Nachschwinger. F2: Einspeisung > 1 kW höchstens 5 s. Keine Rücknahme `laden_bei_bezug`. |
| 3 | **F5** Verkauf nach Eigenverbrauch | ≤ 15 min vor dem Abendverkauf | `grid_zero`, `self_consumption`, `F5` | Das Fenster endet am Slotende, dann `nachlauf_auswertung`: `abweichung_nach_30s_kw` ≤ 0,5, `ueberschwingen_kw` ≤ 3 |

`T90` und die Sprünge werden aus der Telemetrie gerechnet. Sie wird alle 5 s abgefragt, der Solarman-Logger erneuert seine Register aber nur alle 5–25 s. Die 5-s-Grenze von F1/F2 ist deshalb nur mit dieser Auflösung belegbar. Für die Kante zählt zusätzlich das Box-Protokoll.

## Abbruch erkennen

`run.active` ist `false`, `run.end` nennt `code`, `kind` (`ende` | `abbruch` | `ruecknahme`) und den deutschen Satz. Die Box protokolliert den Start als `Pilotfenster Deye-Ladeseite armiert`.

| `kind` | Codes |
|---|---|
| ende | `zeit_abgelaufen`, `slot_ende` (F5), `ladegrenze_erreicht` (95 %), `betreiber_abbruch` |
| abbruch | `einspeisung_ueber_grenze` (> 33 kW), `bezug_ueber_grenze` (> 5 kW länger als 10 s), `telemetrie_veraltet` (> 15 s), `rueckmeldung_fehlt` (zwei Rücklese-Fehler), `nicht_uebernommen` (kein Beleg binnen 60 s, mit dem Grund der Box), `reserve_boden`, `netzladen_am_geraet`, `steuerung_aus` |
| ruecknahme | `laden_bei_bezug`, `entladen_gegen_absicht` (E↑), `pv_abgeregelt` (`grid_zero`) |

Nennt `layer1_refusal` einen Grund, hat die Box den Kandidaten gar nicht übergeben, zum Beispiel wegen einer Vorbedingung. Dann ist nichts am Gerät verstellt worden.

## Ergebnis lesen (`run.metrics`)

| Feld | Bedeutung |
|---|---|
| `netz_in_speicher_kwh` | Σ min(Laden, Bezug) (h4-Definition) |
| `einspeisung_trotz_ladeleistung_kwh` | Einspeisung, während der Speicher unter 95 % und unter der Ladegrenze lag |
| `mittel_abs_netz_kw` | mittlerer \|Netz\| im Fenster |
| `spruenge`, `t90_max_s`, `t90_mittel_s` | Ausschläge über 1 kW und die Zeit, bis \|Netz\| wieder bei 10 % des Spitzenwerts liegt |
| `pendelzyklen` | Vorzeichenwechsel des Netzes durch das ±0,5-kW-Band |
| `schreibvorgaenge`, `schreibvorgaenge_je_stunde` | Takte mit Schreibvorgang (bei `grid_zero` der Herzschlag) |
| `uebernommen_nach_s` | Zeit bis zum ersten Beleg des Geräts |

## Was danach freigeschaltet wird

Der Nachtrag ist **eine Zeile** in `edge-app/nodered/unplanned-load-native.js`. Die passende auskommentierte Zeile wird einkommentiert und der Platzhalter durch den Prüfnachweis ersetzt: Datum, Fall, Lauf-ID und die Messwerte oben. Ohne echten Text wirft das Laden des Moduls einen Fehler.

| Ergebnis | Zeile |
|---|---|
| F11 + F1/F2 mit `grid_zero` für E bestanden | `releaseDeyeChargeSide('grid_zero', 'self_consumption', '…')` |
| F11 + F1/F2 mit `grid_zero` für E↑ bestanden, **ohne** `entladen_gegen_absicht` bei Wolken | `releaseDeyeChargeSide('grid_zero', 'surplus_charge', '…')` |
| `own_config` (nur nach bestandener Vorbedingung, also nach einer Umstellung gemäß E5 A) mit F11 bestanden | die jeweilige `own_config`-Zeile |
| F11 nicht bestanden (der Speicher nimmt die Fronius nicht) | keine Zeile; die Ladeseite bleibt gedämpft |

`netzseitig Ziel 0` hält im Netzmodus seine eigenen SoC-Grenzen nicht ein. Deshalb bleibt `guards.Clamp` mit der Reserve-Aufsicht der Box maßgeblich. E~ (gedrosseltes Laden) bleibt bei beiden Kandidaten bei der Box: Es gibt keinen flüchtigen Grenzen-Hebel im Eigenmodus.

Im selben Schritt wird im Steuerprofil `catalog/control-profiles/profiles/deye_hp3_remote.json` die belegte Zelle nachgezogen: E bzw. E↑ mit Sicherheit B und dem Pilotlauf als Quelle. Die Folgen `ladeseite_netz_null` und `ladeseite_eigenkonfiguration` stehen dort schon; `control-profiles.test.js` bindet sie an den Planer und an die vorbereiteten Einträge. Danach folgen Box-Release und Rollout, beide löst der Captain aus. Belege ohne Hardware: `deye-charge-side.test.js`, `deye-control.e2e.test.js` (K5-Fälle), `flows-sync.test.js`, `core/internal/nativepilot`, `core/internal/guards/nativemode_k5_test.go`. Diese Belege ersetzen die Pilotfenster nicht. [Deye-Referenz](DEYE.md) · [Selbstregelung prüfen](UNPLANNED-LOAD-BENCH.md)
