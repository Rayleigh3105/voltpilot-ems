# Modbus-Datenspiegel: Anlagendaten für die Gebäudeautomation, ohne den Logger zu berühren

Der VoltPilot-Edge stellt die Messwerte der Anlage als **Nur-Lese-Modbus-TCP-Server**
im Hausnetz bereit (Standard-Port **502**). Eine Gebäudeautomation (Loxone, KNX-Gateway,
SCADA, …) liest ihre Register **bei uns** statt am Solarman-Logger des Wechselrichters –
der erlaubt nur EINEN Client, und diesen Client braucht VoltPilot für die Steuerung
(der 60-s-Totmannschalter, Register 1101, wird von unserem Schreibtakt gefüttert).

**Die tragende Zusicherung:** Eine Verbraucher-Anfrage löst **niemals** einen Zugriff
auf den Logger aus. Jede Antwort kommt aus dem Zwischenspeicher, den unser eigener
5-s-Poll füllt. Verbraucher-Nachfrage steuert höchstens, was **unser** Poll zusätzlich
liest (Auto-Lernen, unten) – hart gedeckelt und immer nachrangig zur bestehenden
Socket-Disziplin, in der Steuer-Schreibbefehle Vorrang haben. Die Steuerung wird durch
den Spiegel nicht beeinflusst.

## Einschalten

1. Geräteseite öffnen: `http://<geraet>:8484` → **Einrichten** → Karte
   **„Datenfreigabe im Hausnetz"**.
2. Schalter **„Messwerte per Modbus TCP bereitstellen (nur Lesen)"** einschalten.
3. Die angezeigte Adresse (`<geraet>:502`) in die Gebäudeautomation übernehmen.

Standardmäßig ist der Spiegel **aus**; dann lauscht nichts und eine Verbindung auf
Port 502 wird abgewiesen. Der Host-Port ist über `VP_MIRROR_PORT` in der `.env`
änderbar (Anzeige und Port-Mapping folgen ihm).

## Loxone-Kurzanleitung

Im Loxone Config das bestehende **„Modbus Server"**-Objekt (das bisher auf den
Logger zeigte, z. B. `192.168.254.210:8899`) auf **`<edge-ip>:502`** umstellen –
**eine Eigenschaft, fertig.** Alle Sensoren darunter (Register-Adressen, Formeln,
Programmbausteine, Statistiken) bleiben unverändert, weil der Spiegel die
**originalen Deye-Adressen** unter derselben Geräte-ID (Unit-ID, Standard 1)
ausliefert. „Fragmentierte Pakete" darf aktiviert bleiben (der Spiegel reassembliert).
Der von Loxone erzwungene Mindest-Abfragezyklus von 5 s passt genau zur Frische
des Spiegels (unser Poll liest alle 5 s).

Für einen **Neuaufbau** (oder markenunabhängige Anlagen) gibt es die
VoltPilot-Standardkarte auf **Geräte-ID 100** – kopierfertige Sensor-Liste mit
allen Loxone-Eigenschaften: [`docs/loxone-voltpilot-map.md`](../docs/loxone-voltpilot-map.md)
(einmal anlegen, dann in Loxone Config „Als Vorlage speichern" und
wiederverwenden – nur die IP ändern).

## Registerbereiche

### Geräte-ID = `mb_slave_id` des Wechselrichters (Standard 1): originale Deye-Register

Byte-getreue Weitergabe der Registerblöcke, die unser Poll ohnehin liest
(FC3 und FC4 liefern dieselben Daten):

| Bereich | Inhalt | Frische |
|---|---|---|
| `0x0000` | Geräteklasse (LV/HV) | jeder Poll (≤ 5 s) |
| `0x024C–0x02C4` | Messblock hybrid_3p: SoC, Batterie, Netz (ext. CT), Last, PV | jeder Poll (≤ 5 s) |
| andere Familien | die jeweiligen Primärblöcke (`deye/deye-decode.js planReads`) | jeder Poll |
| **gelernte Blöcke** | jedes weitere Register per Auto-Lernen (unten) | je nach Anzahl, ≤ 8 × 5 s = 40 s |
| `1100–1121` (`0x044C–0x0461`) | Fernsteuer-Fenster: **lesbar** aus unseren eigenen Steuerungs-Rücklesungen (~10-s-Takt, solange die Steuerung aktiv schreibt) – **nie über einen zusätzlichen Poll**, niemals schreibbar | ~10 s bei aktiver Steuerung, sonst „Gerät antwortet nicht" |

Der Spiegel gilt heute für **Deye/Solarman-Anlagen** (der Poll veröffentlicht dort
seine Rohblöcke). Bei anderen Primärgeräten (Fronius, generisches Modbus) bleibt der
native Bereich leer und antwortet mit 0x0B; die VoltPilot-Karte (unten) funktioniert
auf **jeder** Anlage.

### Geräte-ID 100: die VoltPilot-Standardkarte (Schema v1, eingefroren)

Markenunabhängig, aus den geprüften Gesamt-Messwerten der Anlage (dieselben Zahlen
wie Dashboard und Cloud). Wächst nur additiv; bestehende Register wandern nie.

| Adresse | Register | Typ | Anmerkung |
|---|---|---|---|
| 0 | Karten-Magic `0x5650` („VP") | u16 | Plausibilitätsprüfung des Verbrauchers |
| 1 | Schema-Version = 1 | u16 | eingefroren; nur additives Wachstum |
| 2 | Datenalter, Sekunden | u16 | `0xFFFF` = noch keine Daten |
| 3 | Qualität | u16 | 0 = ok, 1 = veraltet, 2 = keine Daten |
| 4–5 | PV-Leistung, W | s32 | ≥ 0 |
| 6–7 | Hausverbrauch, W | s32 | der Standard-Hausverbrauch |
| 8–9 | Netzleistung, W | s32 | + Bezug / − Einspeisung (passt zu Loxone `Gpwr`) |
| 10–11 | Batterieleistung, W | s32 | + Laden / − Entladen (Loxone `Spwr` erwartet das Inverse – Formel beim Installateur) |
| 12 | Ladestand, 0,1 % | u16 | `0xFFFF` = nicht vorhanden |
| 13–14 | Netzlimit (§14a), W | s32 | nur wenn gemeldet |

Fehlende Kanäle tragen **SunSpec-übliche Sentinels** (`0x8000_0000` für s32,
`0xFFFF` für u16) – nie eine erfundene 0. Veraltete Daten werden auf der Karte
**angezeigt** (Alter + Qualität), nicht verweigert, damit ein Verbraucher die
Frische sehen kann, ohne Fehler behandeln zu müssen.

## Auto-Lernen: jedes Register, ohne den Logger zu gefährden

Fragt der Verbraucher ein natives Register an, das (noch) nicht im Zwischenspeicher
liegt, merkt sich der Spiegel den Bereich als **Wunschblock** und nimmt ihn in
**unseren eigenen** Poll auf:

- **Erstes Mal:** Antwort `0x0B` („Gerät antwortet nicht"). Loxone pollt zyklisch,
  ab dem nächsten Poll-Zyklus liefert der Spiegel – der erste Fehlversuch ist in
  der Praxis unsichtbar.
- **Harter Deckel:** Wünsche werden zu Blöcken von höchstens **64 Registern**
  zusammengefasst, maximal **8 Blöcke** (selten Gefragtes fliegt per LRU raus),
  und der Poll liest höchstens **einen** gelernten Block je 5-s-Zyklus –
  round-robin, **nach** den Primärblöcken, innerhalb derselben Socket-Sperre, die
  Steuer-Schreibbefehlen immer Vorrang gibt. Worst case kostet der Spiegel den
  Logger also **eine zusätzliche FC3-Anfrage (≤ 64 Register) pro 5 s** – egal, was
  der Verbraucher tut.
- **Frische gelernter Blöcke:** bei k gelernten Blöcken wird jeder alle k × 5 s
  aufgefrischt (max. 40 s bei vollen 8 Blöcken – innerhalb der 90-s-Schwelle).
- **Vom Wechselrichter abgelehnte Bereiche** (Modbus-Ausnahme) werden verworfen und
  ab dann mit `0x02` ILLEGAL DATA ADDRESS beantwortet – sie verschwenden nie den
  einen gelernten Slot pro Zyklus.
- Die gelernte Liste **überlebt einen Neustart** (`mirror.json` im Datenverzeichnis).
- Das Fernsteuer-Fenster **1100–1121 wird nie gelernt/gepollt** (es kommt aus den
  Steuerungs-Rücklesungen); die VoltPilot-Karte (Geräte-ID 100) lernt nie.

## Frische & Fehlerbilder

| Ereignis | Antwort des Spiegels | Was Loxone sieht |
|---|---|---|
| Daten frisch (≤ 90 s, `stale_after_s`) | Werte | normale Sensorwerte |
| Deye-Lesung > 90 s alt (WLAN weg, Logger-Reboot) | Ausnahme `0x0B` je Anfrage | Sensor ungültig – ehrlich, wie früher beim toten Logger |
| Register (noch) nicht gelernt | `0x0B`, ab dem nächsten Zyklus Werte | ein unsichtbarer erster Fehlversuch |
| Vom Wechselrichter abgelehnter Bereich | `0x02` ILLEGAL DATA ADDRESS | dauerhaft ungültiger Sensor → Adresse prüfen |
| Schreibversuch (jeder Nicht-Lese-FC) | `0x01` ILLEGAL FUNCTION, protokolliert | Schreibfehler; der Wechselrichter bleibt unberührt |
| Spiegel ausgeschaltet (Standard) | kein Listener | Verbindung abgewiesen |
| unbekannte Geräte-ID | `0x0B` | Sensor ungültig |
| Kern startet neu | Listener kurz weg; retained Daten füllen sofort wieder | wenige Sekunden Verbindungsfehler |

**Nur Lesen ist strukturell:** Es werden ausschließlich FC3/FC4 beantwortet; im
Spiegel existiert kein Schreibpfad. Grenzen: max. 8 gleichzeitige Verbindungen,
max. 125 Register je Anfrage, Lese-Timeouts, kaputte Frames trennen die Verbindung.
Alle Antworten kommen aus dem RAM.

**Sicherheitslage:** LAN-only wie `:8484`; Modbus kennt keine Authentifizierung –
die Absicherung ist Nur-Lesen + kuratierte Register + Verbindungsdeckel;
Netz-Segmentierung bleibt Sache des Installateurs.

## Technische Referenz

- Kern: `edge-app/core/internal/mirror` (Server, Auto-Lernen, VP-Karte),
  Anbindung `internal/agent/mirror.go`, API `GET/POST /api/mirror`.
- Node-RED: retained `edge/registers/raw` (Rohblöcke, `vp-register-raw`) hoch,
  retained `edge/registers/want` (Wunschliste, `vp-register-want`) runter;
  Topics dokumentiert im Kopf von `core/internal/localbus/localbus.go`.
- Konfiguration: `mirror.json` (`enabled`, `port` = Container-Port 1502,
  `stale_after_s`, `learned_blocks`); Host-Port-Mapping
  `${VP_MIRROR_PORT:-502}:1502` in der Compose.
