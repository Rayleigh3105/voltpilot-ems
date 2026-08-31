# Shelly-Relais als steuerbarer Verbraucher (Heizstab u. a.)

Der zweite reale Verbraucher-Steuerpfad nach der go-e-Wallbox (D10; Pilot laut
Captain: Heizstab über Shelly). Ein Shelly-Relais/-Zwischenstecker vor einem
Verbraucher wird über seine **lokale HTTP-API** geschaltet und zurückgelesen -
komplett vom **Go-Core** (`edge-app/core/internal/shelly`), es gibt bewusst
**keinen Node-RED-Lesepfad** (Single-Writer: Quellen-Poll, Verbindungstest und
Steuer-Executor teilen sich EINEN Besitzer des Geräte-Sockets). Bench-Ablauf:
[`CONTROL-BENCH.md`](CONTROL-BENCH.md) → „Shelly".

## 1. Voraussetzungen

- **Festes WLAN, feste IP** (DHCP-Reservierung im Router). Die Verbindung ist
  reines LAN-HTTP; eine wandernde IP macht den Verbraucher stumm.
- **Kein Passwortschutz** auf der Shelly-Weboberfläche: Gen1 nutzt
  HTTP-Basic, Gen2+ Digest-Auth - beides wird in v1 NICHT unterstützt. Ein
  geschütztes Gerät wird ehrlich abgelehnt („passwortgeschützt … siehe
  SHELLY.md") statt halb zu funktionieren. Das Gerät gehört in das lokale,
  nicht öffentlich erreichbare Netz der Anlage.
- **Shelly-Cloud darf an bleiben** (wir nutzen sie nicht); Auto-Firmware-Updates
  besser aus - ein Firmware-Wechsel hinter derselben IP wird zwar erkannt
  (einmalige Neu-Erkennung), ist aber ein unnötiger Überraschungsmoment.

## 2. Generationserkennung - nie konfiguriert

Der Kunde kann seine „Gen" nicht kennen, also wird sie **erkannt und
persistiert** (`data_dir/shelly-devices.json`), nie abgefragt:

- `GET /shelly` antwortet auf JEDER Generation unauthentifiziert: ein
  `gen`-Feld ≥ 2 wählt den **RPC-Dialekt** (Gen2/Gen3/Gen4 - Plus/Pro-Linien),
  ein `type`-Feld ohne `gen` den **Gen1-REST-Dialekt** (klassische
  ESP8266-Linie).
- Ein einmal erkanntes Gerät wird nie erneut geprobt; eine Dialekt-Überraschung
  (Firmware-/Gerätetausch hinter derselben IP) verwirft den Eintrag und die
  nächste Runde erkennt genau EINMAL neu - selbstheilend, nie eine Schleife.

## 3. Messfähigkeit (D3): Stufe 2 oder Stufe 3

Der Treiber fragt das GERÄT, ob es Leistung misst - nie eine Modell-Liste:

| Klasse | Erkennung | Bestätigungshierarchie (§9.4) |
|---|---|---|
| **mit Messung** (1PM/PM/Plug-S-Klasse) | Gen2: `apower` im `Switch.GetStatus`; Gen1: `meters[ch].is_valid` | **Stufe 2**: Laufzeit exakt, Energie aus echten Messwerten integriert; die gemessene Leistung fließt als Verbraucher-Telemetrie in Ledger + Portal |
| **ohne Messung** (Shelly 1, Plus 1 …) | kein `apower` / `is_valid=false` | **Stufe 3**: Laufzeit über das Relais bestätigt, Energie „**angenommen**“ (Nennleistung × Zeit) - so gekennzeichnet, nie als gemessen behauptet |

Die Konsequenz steht schon im Assistenten („misst Leistung" / „ohne
Leistungsmessung - Energie wird angenommen"), und die Ink1-Regel greift
automatisch: **kWh-Ziele bietet der Regelbaukasten nur mit Messung** an; ohne
Messung erscheint der ehrliche Satz „Ohne Messung kann VoltPilot die Erfüllung
nicht nachweisen." Ein nicht-messendes Shelly meldet NIE einen Leistungswert
(Quellen-Zeile: „Relais Ein/Aus" - keine erfundenen Nullen).

Die Gen1-`is_valid`-Regel folgt der aioshelly/Home-Assistant-Disziplin und
bleibt wie jedes Herstellerverhalten **VERIFY-on-device**.

**⚠ Ein SG-Ready-Freigabekontakt ist die Ausnahme von dieser Tabelle.** Liegt
das Relais auf dem SG-Ready-Eingang einer Wärmepumpe, misst es auch als
1PM/Plug-S **nichts Relevantes** — der Strom der Pumpe fließt nicht über den
Steuerkontakt. Dafür gibt es den eigenen Verbrauchertyp
`heat-pump-sgready` mit der eigenen D3-Stufe `freigabe`:
[`docs/waermepumpe-sg-ready.md`](../../docs/waermepumpe-sg-ready.md).

## 4. Einrichten

1. `:8484` → Einrichten → „Weitere Energiequellen" → Rolle **Verbraucher** →
   Marke **Shelly (Relais/Schaltaktor)**: IP (+ Port, + Schaltkanal bei
   Mehrkanal-Geräten wie dem 2PM - Kanal 0 = erster). Generation und Messung
   werden beim „Verbindung testen" erkannt und angezeigt.
2. **„Verbindung testen" (D11)**: identifiziert das Gerät, liest den Zustand
   und fährt den **Schalttest nur, wenn das Relais gerade AUS ist**
   (wertgleicher Aus-Befehl + Rücklesung - ein laufender Heizvorgang wird nie
   unterbrochen; ist das Relais an, wird nur gelesen und ehrlich gesagt,
   warum der Schalttest übersprungen wurde).
3. Im Portal den Verbraucher anlegen (Verbraucher-Assistent) und mit der
   gemeldeten Quelle verbinden - der Bestätigungskanal (Stufe 2/3) wird dabei
   aus der nachgewiesenen Messfähigkeit abgeleitet.

## 5. Steuer-Verhalten des Treibers

- **on_off über die bestehende Kette**: Plan/Regel → Desired → Arbitration →
  Verbraucher-Klemme → **Zyklen-Guard** (für einen Heizstab die zentrale
  Schutzschicht: Mindestlauf/-pause, Starts/Tag - Halte-Gründe wie „wartet -
  Mindestpause" reisen bis ins Portal) → Relais-Befehl → Rücklesung.
- **Jeder EIN-Befehl trägt den geräteeigenen Abfall-Timer** (Gen2
  `toggle_after`, Gen1 `timer`; Vorgabe 180 s = 3 Re-Assert-Intervalle,
  `on_timer_s` im driver.connection; `-1` deaktiviert ihn - dokumentiertes
  Risiko). Hört die Box auf zu schreiben (Edge tot, WLAN weg), fällt das
  Relais **von selbst** ab - ein Heizstab ohne Verbindung heizt NICHT weiter.
- **Failsafe `off` (§4.2)**: bei Staleness/fehlendem Befehl schreibt der
  Treiber zusätzlich aktiv AUS - bewusst NICHT das go-e-Neutral (ein Relais
  hat keine eigene Lade-Logik, in die man es entlassen könnte).
- **Restrict-only**: ein nackter Sollwert unter der Nennleistung schaltet NICHT
  ein (ein Relais liefert 0 oder Nennleistung - nie mehr liefern als
  befohlen); die regulären Befehlswege für on_off-Verbraucher tragen ohnehin
  ein explizites `on_off`.
- **Rücklesung nach jedem Schreiben**: Schaltzustand (+ Leistung bei messenden
  Modellen) → `all_match`; ein Fehler/Timeout ist ein ehrlicher Status
  (`error_code`), nie ein stiller Erfolg.

## 6. Config-Felder (`driver.connection` bzw. Quellen-Verbindung)

```json
{
  "ip": "192.168.0.60",
  "port": 80,
  "channel": 0,
  "rated_power_kw": 3.0,
  "on_timer_s": 180
}
```

Nur `ip` ist Pflicht. `channel` nur bei Mehrkanal-Geräten (2PM: 0/1);
`rated_power_kw` ist der optionale Treiber-Spiegel der Nennleistung (die
Cloud-Verbraucherakte bleibt die Autorität); `on_timer_s` steuert den
Abfall-Timer (0/fehlend = 180).

## 7. Sicherheits-Rahmen (unverändert)

Der Executor läuft nur mit `VP_CONTROL_ENABLED` **und**
`VP_CONSUMER_CONTROL_ENABLED` (beide Vorgabe AUS - mit Flags aus null HTTP an
das Relais, byte-identisch). Vorgelagert bleiben alle Guards autoritativ.
Die Typen `heating-rod`/`generic-load` bleiben im Katalog **unzertifiziert**
(`simulator_only`), bis die Captain-Bench-Session sie flippt (D11, eigener
Mini-PR - siehe CONTROL-BENCH.md „Shelly", Abschluss).
