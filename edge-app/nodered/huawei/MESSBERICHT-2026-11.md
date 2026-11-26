# Messbericht Huawei SUN2000 + LUNA2000 – Feldanlage SUN2000-3KTL-M1

Grundlage der Steuer-Freigabe für den Huawei-Fensterpfad auf Edge Light und Edge Industrie
(`core/internal/steuerplan/huawei.go`, `core/internal/layer1/freigabe.go`) und der Wissensstände in
[`huawei.json`](../../../catalog/control-profiles/profiles/huawei.json) (Quelle `huawei_feld_m1`).

**Anlage:** Feldanlage SUN2000-3KTL-M1 mit LUNA2000 (10 kWh) und Leistungsmesser, Smart Dongle, Unit 1, Port 502.
**Zugang:** über den Wartungstunnel der Box, SSH-Weiterleitung auf den Dongle. Auf der Box wurde nichts geändert;
die VoltPilot-Konfiguration der Anlage blieb unberührt.
**Werkzeug:** [`core/cmd/vp-huawei-pruefstand`](../../core/cmd/vp-huawei-pruefstand). Es liest mit dem Leseplan und
Decoder der Box (`huaweidecode`) und fährt die Schreibfolgen des Huawei-Adapters
(`controlRoute(...).planned`). Geschrieben werden nur die Absichtsregister aus `huawei.json`. Vor jedem Schreiben
liest das Werkzeug jeden Ausgangswert und legt ihn ab; danach schreibt es ihn zurück und liest ihn nach.
**Zeiten:** in UTC.

## 1. Lesend (25.11.2026, 19:29–19:36)

| Was | Wert |
|---|---|
| Modell (30000, Text endet am ersten NUL) | SUN2000-3KTL-M1, Modell-ID 424 |
| Nennleistung / Pmax (30073/30075) | 3000 W / 3300 W, 2 MPPT |
| Firmware (30035) / Software (30050) | V100R001-02 / **V100R001C00SPC153** |
| Batterie (47000) | 2 = LUNA2000, Kapazität 10000 Wh (37758), Status 2 = läuft |
| Leistungsmesser (37100) | 1 = normal, Typ 1 |
| Arbeitsmodus 47086 | 2 (Maximise self consumption) |
| 47075 / 47077 (max. Laden / Entladen) | 7000 W / 3300 W |
| 47081 / 47082 (Lade-/Entladeschluss) | 100 % / 5 % |
| 47083 / 47087 / 47100 / 47246 / 47247 / 47249 | 60 / 1 / 0 / 0 / 7000 / 0 |

**Vorzeichen** (abends, PV 0): AC-Wirkleistung (32080) +3,2 kW und Batterie (37765) −3,2 kW. Damit gilt
„+ = Laden“. Der Zähler (37113) zeigte −8,0 kW, der Haushalt bezog also Strom: Huawei zählt „− = Bezug“, die Box
macht daraus +8,0 kW Bezug.

**Wartezeit nach dem Verbinden:** je Pause dreimal 30000 gelesen, in neuer Verbindung, Zeitlimit 3 s.

| Pause | beantwortet |
|---|---|
| sofort | 0 von 3 |
| 0,3 s | 1 von 3 |
| 0,5 s | 1 von 3 |
| 0,7 s | 3 von 3 |
| 1 s | 3 von 3 |
| 1,5 s | 3 von 3 |

Durch den SSH-Tunnel ist die wirksame Pause am Dongle etwas kürzer als eingestellt. Eingebaut sind 1 s (PR
„Huawei: 1 s Wartezeit …“).

**Leseplan der Box mit 1 s Wartezeit:** 2 × 12 Lesungen im 5-s-Takt. Alle vier Blöcke kamen ohne Ablehnung durch
das Gerät; eine Lesung dauerte durch den Tunnel 2,7–4,5 s. Ausfälle gingen auf Tunnelabrisse zurück (WLAN der
Box), nicht auf den Dongle.

## 2. Schreibend, abends (25.11.2026)

| Zeit | Test | Register alt → neu | beobachtete Wirkung | Wiederherstellung |
|---|---|---|---|---|
| 19:38:22–19:40:09 | H (Folge `halten`) | 47075 7000→0, 47077 3300→0 | Batterie −3,22 → 0 kW (≤ 11 s), Netzbezug +3,2 kW | 7000/3300 zurückgelesen, Entladen −3,22 kW |
| 19:41:35–19:43:05 | Skala 47077 | 47077 3300→1000 | −3,22 → −1,135 kW (2,6 s) → −0,948 kW (5,9 s), danach stabil | 3300 zurückgelesen, −3,22 kW |
| 19:43:49–19:45:14 | E_laden/E_gedrosselt (Folge `laden_gedrosselt`, 500 W) | 47086 2→2, 47077 3300→0, 47075 7000→500 | Entladen aus nach 1,4 s; kein Laden aus dem Netz | alle zurückgelesen |
| 19:45:58–19:47:00 | E_decken (Folge `decken`, alte Fassung) | 47086 2→2, 47075 7000→0 | Entladen unverändert −3,22 kW (Laden gesperrt, nachts nicht sichtbar) | alle zurückgelesen |
| 19:47:37–19:48:23 | N (Folge `netzladen`, 500 W) | 47087 1→1, 47247 7000→500, 47083 60→1, 47246 0→0, 47100 0→1 | nach 4,3 s 0 kW, nach 7 s +0,572 kW Laden | Auffrischen endete in einem Transport-Timeout: Abbruch, alle fünf zurückgelesen |
| 19:49:12–19:51:27 | N, je 8 s neu geschrieben, 2 min | wie oben | +0,575 kW über 2 min (länger als 1 min in 47083) | alle fünf zurückgelesen, −3,23 kW |
| 19:52:09–19:55:20 | N einmal, Totmann | wie oben, ohne Auffrischen | Laden +0,576 kW bis 19:53:10; um 19:53:27 stand 47100 = 0, ab 19:53:40 Entladen −3,23 kW | auf Anweisung abgebrochen, alle fünf zurückgelesen |

**Netzladen ist an dieser Anlage nicht erlaubt.** Der Captain hat um ca. 19:54 die Netzlade-Tests gestoppt.
Davor lief Netzladen ≈ 3,5 min mit ≈ 0,575 kW (≈ 35 Wh). Absicht N bleibt gesperrt und wird nicht weiter getestet.

Nach allen Tests (19:58) standen alle Absichtsregister wieder auf den Ausgangswerten (eigene Erhebung).

## 3. Befunde

1. 47075/47077 sind in W, Gain 1. Bei einer Grenze von 1000 W lieferte die Batterie 948 W.
2. Eine Fenstergrenze wirkt nach 1,4–6 s. Die Messregister ändern sich in Schritten von 1–3 s.
3. Zwangsladen mit 500 W ergab +575 W. Der Totmann aus 47083 wirkt: einmal geschrieben, endete das Zwangsladen
   nach ~1 min von selbst; neu geschrieben hielt es.
4. Die Rückgabe des Adapters schrieb 47075 = 47077 = 0. Das ist **Halten** und sperrt den Speicher. Behoben: Die
   Rückgabe schreibt die eigenen Werte des Geräts zurück.
5. E_decken ließ 47077 unberührt. Nach Halten oder Laden blieb damit 47077 = 0 stehen, und der Speicher durfte
   nicht entladen. Behoben: E_decken setzt 47077 auf den eigenen Wert zurück.
6. Ob 47075/47077 im Dauerspeicher liegen, war ohne Stromunterbrechung nicht zu messen. Der Go-Pfad behandelt sie
   als Dauerspeicher: Er schreibt nur Abweichungen und hält das Tagesbudget ein.

## 4. Morgens (26.11.2026): Netzladen des Geräts selbst, Go-Fensterpfad am Gerät

Die Box der Anlage lief seit 06:42 auf `edge-light-2026.11.19`, also noch ohne die Wartezeit.

**07:05–07:07, nur lesend.** Das Gerät lud **von sich aus aus dem Netz**: +1,01 kW, PV 0, SoC 7 %, AC −1,01 kW.

- Grund sind die Einstellungen am Gerät: 47087 = 1 (Netzladen an), 47088 = 100,0 % (Netzlade-Grenze),
  47082 = 5 % (Entladeschluss).
- VoltPilot hat damit nichts zu tun. 47100 = 0, und alle Absichtsregister standen auf den Werten vom Vorabend.
- Zwischen 07:07:00 und 07:08:02 endete das Netzladen von selbst, vor dem ersten Schreiben des Go-Pfads um
  07:08:14.
- **Woher kam der Strom?** Der Captain fragte, ob der Huawei den Strom des AC-gekoppelten KACO-Wechselrichters
  derselben Anlage in seine Batterie nimmt. Das kann so aussehen wie Netzladen. Die Antwort gibt der Zähler am
  Netzanschluss (37113, Huawei „− = Bezug“): Der Leseplan las ihn in denselben Lesungen wie die Batterie (37765).
  Gemessen wurde nur lesend; den KACO hat die Box nicht angesprochen.

  | Zeit | Batterie (37765) | Netz (37113, als VoltPilot-Bezug) | PV Huawei |
  |---|---|---|---|
  | 07:06–07:07, 6 Lesungen | +1,009 … +1,011 kW (Laden) | +1,186 … +1,196 kW **Bezug** (37113 ≈ −1190 W) | 0 |
  | ab 07:08, Laden zu Ende | 0 | +0,16 … +0,17 kW Bezug | 0 |

  Während des Ladens war der Bezug so groß wie Haushalt (≈ 0,17 kW) plus Ladeleistung. Es war also **Netzbezug**,
  kein KACO-Überschuss; um 08:05 MEZ, kurz nach Sonnenaufgang, erzeugte der KACO offenbar nichts Nennenswertes.
  Das gilt unter der Annahme, dass der Smart Power Sensor wirklich am Netzanschluss sitzt (Status 1 = normal;
  Profil `zaehler.ort = netzpunkt`, vor Ort nicht nachgesehen).
- **47087 bleibt unberührt.** 47087 = 1 ist vermutlich die Einstellung, die der Huawei für die AC-Kopplung mit dem
  KACO braucht, damit er dessen Überschuss laden kann. Die Box schreibt 47087 nie: Der Go-Fensterpfad und jede
  Rückgabe (Go und Node-RED) lassen das Register unverändert, und die gesperrte Absicht N setzt es höchstens auf 1,
  nie auf 0. Ob die Anlage aus dem Netz laden darf, ist am Gerät bzw. mit dem Installateur zu klären (Netzlade-Grenze
  47088 = 100 %).

**07:07:53–07:11:33, der Go-Fensterpfad der Box selbst** (`vp-huawei-pruefstand steuerweg`). Eine
Layer-1-Laufzeit lief am Prüfrechner hinter dem Tunnel; sie bekam die Huawei-Auswahl (`sun2000-m1`, Unit 1) und
Sollwerte im 10-s-Takt (`device_certified`, `control_enabled`).

| Zeit | Sollwert | Rückmeldung des Go-Pfads | Register danach |
|---|---|---|---|
| 07:08:14 | 0 kW (H) | `wrote`, `verify=held` | 47075 = 0, 47077 = 0 |
| 07:08:18–07:08:51 | 0 kW | `held`, kein weiteres Schreiben | unverändert |
| 07:09:03 | −1 kW (E_decken) | `wrote`, `verify=held` | 47086 = 2, 47075 = 0, 47077 = 3300 (eigener Wert) |
| 07:09:16–07:09:51 | −1 kW | `held`, kein weiteres Schreiben | unverändert |
| 07:10:07 | Not-Aus | `mode=release`, `verify=held`, Grund „Steuerung deaktiviert (Not-Aus)“ | 47075 = 7000, 47077 = 3300, 47086 = 2 |

- Die Batterie stand während des ganzen Laufs schon auf 0 kW (SoC 7 %, PV 0). Eine Wirkung war deshalb nicht zu
  sehen; die Wirkung derselben Register belegen die Abendtests in §2.
- Die eigene Nachkontrolle des Werkzeugs um 07:11:28 scheiterte an einem Lesefehler. Der Dongle setzte die
  Verbindung zurück, weil die Box selbst denselben Dongle abfragt. Das Werkzeug schrieb die Ausgangswerte
  sicherheitshalber noch einmal, dieselben Werte; seitdem wiederholt es das Nachlesen.
- Erhebung um 07:13: alle Absichtsregister auf den Ausgangswerten.

## 5. Nachweis: Netzladen am Gerät war vor unseren Tests an, und wir haben es nicht verändert

Frage des Captains vom 26.11.2026: Haben die Tests vom 25.11. Netzladen am Gerät eingeschaltet? Die Antwort ist
**nein**. Den Nachweis liefern die Protokolle des Prüfstand-Werkzeugs und eine Lesung um 07:26:58; dafür wurde nichts
geschrieben.

**(1) Register jetzt gegen die erste Erhebung.**

| Register | Bedeutung | erste Erhebung 25.11. 19:29:42 | 26.11. 07:26:58 | von uns geschrieben |
|---|---|---|---|---|
| 47075 | max. Ladeleistung (W) | 7000 | 7000 | ja (0, 500, 7000) – zurück auf 7000 |
| 47077 | max. Entladeleistung (W) | 3300 | 3300 | ja (0, 1000, 3300) – zurück auf 3300 |
| 47081 | Ladeschluss (0,1 %) | 1000 | 1000 | nie |
| 47082 | Entladeschluss (0,1 %) | 50 | 50 | nie |
| 47083 | Dauer Zwangsladen (min) | 60 | 60 | ja (1, 60) – zurück auf 60 |
| 47086 | Arbeitsmodus | 2 | 2 | ja, nur der Wert 2 |
| **47087** | **Netzladen** | **1** | **1** | **ja, nur der Wert 1** (s. u.) |
| 47088 | Netzlade-Grenze (0,1 %) | erstmals gelesen 26.11. 07:07: 1000 | 1000 | **nie** (vom Werkzeug gesperrt) |
| 47100 | Zwangsladen/-entladen | 0 | 0 | ja (1, 0) – zurück auf 0 |
| 47246 | Modus Zwangsladen | 0 | 0 | ja, nur der Wert 0 |
| 47247 | Zwangsladeleistung (W) | 7000 | 7000 | ja (500, 7000) – zurück auf 7000 |
| 47249 | Zwangsentladeleistung (W) | 0 | 0 | nie |

**(2) Zeitlinie.**

- **47087 stand schon vor jedem Schreiben auf 1.** Erste Lesung: 25.11. 19:29:42, Erhebung (nur FC3) →
  „netzladen 1“. Davor lief vom Prüfrechner nichts gegen das Gerät, und auch zwischen 19:29:42 und 19:38:22 nur
  Lesungen (Erhebung, Wartezeit, Leseplan, alle FC3). Der erste Schreibzugriff überhaupt war 19:38:22
  (Halten, 47075).
- **47087 wurde zehnmal geschrieben, immer mit 1.** Das Werkzeug schreibt jeden Schritt einer Folge und liest ihn
  zurück, auch wenn der Wert schon steht. „47087 1→1“ heißt daher: Der Wert 1 wurde **geschrieben**, auf den schon
  vorhandenen Wert 1. Die Zugriffe:
  - 19:47:37 Netzladen-Test 1, Wiederherstellung 19:48:23;
  - 19:49:12 Test 2, Auffrischen 19:49:41, 19:50:10, 19:50:36 und 19:51:00, Wiederherstellung 19:51:27;
  - 19:52:09 Test 3, Wiederherstellung 19:55:20.

  Jedes Mal wurde 1 zurückgelesen. Ein anderer Wert als 1 wurde in 47087 nie geschrieben.
- **47088 wurde nie geschrieben.** Das Werkzeug lässt nur die Absichtsregister 47075, 47077, 47083, 47086, 47087,
  47100, 47246, 47247 und 47249 zu. Gelesen wurde 47088 erstmals am 26.11. um 07:07.
- Der Go-Fensterpfad (26.11. 07:08–07:10) schrieb nur 47075, 47077 und 47086.

**(3) Rückgabe und Not-Aus können kein Netzladen hinterlassen.**

- Der Go-Fensterpfad schreibt 47087, 47088, 47100, 47246, 47247 und 47083 nie. Das prüfen die Tests
  (`keinZwang` in `layer1/steuern_huawei_test.go`, `TestHuaweiPlanenWaehltDieFolgeDesFensterpfads`).
- Seine Rückgabe stellt nur 47075, 47077 und 47086 auf die zuvor gelesenen eigenen Werte zurück.
- Die Node-RED-Rückgabe enthält ebenfalls nur diese drei Register, und `huaweiControl` schreibt nichts (gesperrt).
- Das Prüfstand-Werkzeug stellt jeden geschriebenen Ausgangswert her; für 47087 ist das der vorgefundene Wert 1.

Das Netzladen des Geräts am Morgen (§4) folgt aus seinen eigenen Einstellungen: 47087 = 1 und 47088 = 100 %.

## 6. Im Feld geht nur ein Modbus-Client gleichzeitig

Seit 07:37:56 liest die Box der Anlage den Huawei selbst, alle 5 s mit 1 s Wartezeit. Die Prüfstand-Sitzungen
über den Tunnel und die Lesungen der Box stören sich gegenseitig: Der Smart Dongle nimmt nur **einen** Modbus-Client
zur selben Zeit.

| Zeit | Prüfstand-Sitzung | Box |
|---|---|---|
| 08:23:52 | zwei Blöcke EOF (37113, 37760) | zeitgleich zwei Lesefehler (EOF, „jeder Block abgelehnt“) |
| 08:44:00 | alle vier Blöcke Modbus-Ausnahme 6 (SLAVE DEVICE BUSY) | – |

Im Feld darf deshalb nur die Box mit dem Dongle sprechen; FusionSolar über den Dongle und ein zweites EMS stören
ebenso. Der Steuerweg der Box nutzt dieselbe Spur wie ihr Poll (eine Sitzung nach der anderen). Das
Prüfstand-Werkzeug wiederholt einen Fehler während einer Box-Lesung und wertet ihn nicht als Gerätefehler.

**Netzladen oder Laden aus PV?** Der Leseplan zeigt es am Vorzeichen der AC-Wirkleistung (32080):

- **positiv:** der Wechselrichter gibt AC ab. Eine ladende Batterie lädt dann aus der eigenen DC-PV.
- **negativ:** er nimmt AC auf, und nur dann lädt die Batterie aus dem Netz oder aus einem AC-gekoppelten
  Erzeuger.

Beispiele:

- 08:33:57: PV 0,118 kW, Batterie +0,085 kW, AC **+0,028 kW**, Netz +0,05 kW Bezug. Die Batterie lädt aus der
  DC-PV; den kleinen Bezug lässt der Eigenverbrauchsregler stehen, weil der Haushalt mehr braucht, als der Huawei
  AC-seitig abgibt.
- 07:06–07:07: AC **−1,01 kW** bei PV 0. Das war Netzladen (§4).

## 7. Tageslicht (26.11.2026) und Umfang der Freigabe

Die Sonnen-Tests waren am 26.11. nicht möglich:

- Bis 09:47 lieferte der Huawei höchstens ≈ 0,13 kW PV.
- Seit 07:37:56 liest die Box selbst, und die Prüfstand-Sitzungen kamen daneben nicht sauber durch (§6).

**Captain-Entscheid C (26.11.2026).** Freigegeben ist nur die **Entladegrenze 47077**; ihre Wirkung ist gemessen
(§2), ebenso Schreiben, Rücklesen und Rückgabe durch den Go-Pfad selbst (§4).

- Die **Ladegrenze 47075** bleibt gesperrt, bis an einem sonnigen Tag in einem Fenster ohne den Box-Poll gemessen
  ist, dass sie das Laden bei PV-Überschuss begrenzt (E_gedrosselt) bzw. sperrt (E_decken).
- Bis dahin sperren Halten und ein positiver Sollwert nur das Entladen (47077 = 0), und Decken gibt das Entladen frei
  (47077 = eigener Wert). Das Laden regelt das Gerät selbst.
- Netzladen bleibt gesperrt; 47087/47088 fasst die Box nie an.
