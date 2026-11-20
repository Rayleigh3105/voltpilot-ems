# VoltPilot-Koppelbild v1 (KB-1)

Stand 19.11.2026 · Vertrag 1.0 · Koppelbild 1.0 (Wort 0x0100) · Konzept `vp-pfc200-edge-konzept` Abschnitt 5 (Entwurf 0.1) · Entscheide E2 = A und E3 = A vom 19.11.2026 (PFC200 statt Raspberry Pi).

Das Koppelbild ist die **Vereinbarung zwischen der Edge-Software und dem SPS-Programm einer Anlage** über Modbus TCP.
Die Edge schreibt Wünsche, die SPS entscheidet und quittiert.
Es ergänzt die Lese-Bilder ([Erzeuger](./erzeuger-registerbild.md), [WAGO-Energiekarten](./wago-registerbild.md)) und ändert sie nicht: das Erzeuger-Registerbild bleibt Wort für Wort gültig.
Die SPS-Seite ist der Baustein `FB_VP_Koppelbild` der VoltPilot-Bibliothek (`sps/codesys`), die Box-Seite das Paket `koppelbild` im Go-Core (Edge Light).

**Stand vor dem ersten Einbau.** Nichts davon ist an einer Steuerung belegt; alle Fälle sind ausgedacht (`herkunft: vertrag`, `belegt: false`).
Was nur am Gerät oder in der CODESYS-Entwicklungsumgebung zu belegen ist, steht in §16 mit seinem Prüfstein.

| Datei | Rolle |
|---|---|
| [`koppelbild.md`](./koppelbild.md) | dieser Vertrag |
| [`koppelbild-vectors.json`](./koppelbild-vectors.json) | Aufbau (Felder, Bits, Vokabular, Siegel, Regeln) und 29 Fälle K1–K28 als Schrittfolgen mit rohen Wörtern und der Erwartung an alle Seiten |
| [`koppelbild.schema.json`](./koppelbild.schema.json) | Schema der Vektor-Datei (Teilmenge des UEMS-Schema-Läufers) |
| `frontend/portal/src/koppelbild.test.ts` | Prüfer: Schema, lückenloser Aufbau, Vertrag ⟷ Datei, Siegel, Rechenbeispiele, ein unabhängiger Baustein, Leser und Lage über alle Fälle |
| `edge-app/core/internal/koppelbild` | Zwilling der Box: Schreiber, Leser, Lage; `vertrag_test.go` gegen alle Fälle |
| `sps/codesys/bibliothek/FB_VP_Koppelbild.st` | Zwilling der SPS: der Baustein selbst; `sps/codesys/pruefer/pruefe.py` führt ihn gegen alle Fälle aus |

**Die Vektoren sind die Spezifikation** für Schreiber und Leser der Box, für den Baustein der Bibliothek und für jede Bühne.
Ein Fall ist eine Schrittfolge: Halteregister setzen (ein Telegramm der Edge oder ein fremdes), ein Zyklus des Bausteins, eine Lesung der Edge.
Je Schritt steht die Erwartung an den Schreiber (`absicht` → `woerter`), an den Baustein (Eingänge der Anlage → `q_woerter`, `erwartet_sps`), an den Leser (`erwartet_lesung`) und an die Lage der Edge (`erwartet_lage`).
Wer den Aufbau ändert, ändert Vektor-Datei, Vertrag, Prüfer und beide Zwillinge gemeinsam.

## 1. Grundsätze

Übernommen vom Erzeuger-Registerbild, soweit nichts anderes steht.

| Regel | Festlegung |
|---|---|
| Rollen | Server ist die SPS, Client ist die Edge. Auf einem PFC200 mit Edge Light spricht die Edge 127.0.0.1 („in diesem Gerät“); steht die Box neben der Steuerung, ändert sich nur die Adresse der Datenquelle. |
| Zwei Tabellen, zwei Eigentümer | **Eingangsregister gehören der SPS** (kein Client kann sie schreiben), **Halteregister 0 bis 63 gehören der Edge** (die SPS schreibt dort nie). |
| Funktionscodes | 4 (Eingangsregister lesen), 16 (Halteregister schreiben, immer alle 64 Wörter in einem Telegramm), 3 (Halteregister zurücklesen, nur zur Kontrolle). Einzelne Register schreibt niemand (kein Funktionscode 6). |
| Port, Unit-ID | gehören zur Datenquelle, nie zum Bild; Vorgabe Port 502. |
| Wortfolge, Typen, Ungültig | wie das Erzeuger-Bild: höherwertiges Wort zuerst; U16, S16, U32, S32; ungültig ist das Typ-Maximum, nie 0; 32-bit-Werte auf geraden Adressen. Zähler und Echos haben keinen Ungültig-Wert. |
| Dauern statt Uhrzeiten | Fristen zählt die SPS mit ihrem eigenen Zeitglied ab dem Empfang; keine Seite verlässt sich auf die Uhr der anderen. |
| Wunsch, Quittung, Wirkung getrennt | Abschnitt W ist, was die Edge will. Abschnitt Q ist, was die SPS dazu sagt und was sie anwendet. Die gemessene Wirkung steht im Lese-Bild der Anlage. |
| Die SPS entscheidet | Ein Wunsch ist nie ein Befehl. Ohne gültigen Wunsch fährt das Anlagenprogramm mit eigenen Werten. |
| Das Bild erklärt sich selbst | Die SPS nennt je Stellplatz, was er stellt und in welchem Band (Angebot). Die Edge wünscht nur, was angeboten ist. |
| Takt | Die Edge liest alle 5 s und schreibt alle 5 s, bei einer Änderung sofort, höchstens ein Telegramm je Sekunde. |

- **Jeder Wunsch läuft von selbst ab.**
  Ein Telegramm gilt höchstens `frist_s` ab Empfang und nie länger als die am Baustein eingestellte Obergrenze (Vorgabe 60 s).
  Fällt die Edge aus, fährt die Anlage nach der Frist allein weiter.
- **Lebenszeichen in beiden Richtungen.**
  Die Edge zählt `herzschlag` je Telegramm, die SPS je Sekunde; beide Seiten sehen, ob die andere lebt.
- **Die Steuerungskennung ist kein Identitätsbeweis.**
  `steuerung_id` zeigt nach einem Gerätetausch oder bei einer falschen Adresse, dass nicht die erwartete Steuerung antwortet; sie schützt nicht vor einem Angreifer.
  Die Schranke gegen Fremde ist, dass der Port von außen zu ist (PS-P8).

## 2. Aufbau

| Abschnitt | Tabelle | Adressen | Wörter | Richtung | Inhalt |
|---|---|---|---|---|---|
| Lese-Bild der Anlage | Eingangsregister | 0 bis 999 | wie bisher | SPS → Edge | Erzeuger-Registerbild 1.x ab 0, unverändert; nicht Teil dieses Vertrags |
| **Q Quittung** | Eingangsregister | 1000 bis 1115 | 116 | SPS → Edge | Kopf (20) und 8 Stellplätze je 12: Angebot, Urteil, wirksamer Wert |
| Energiekarten | Eingangsregister | ab 2000 (Vorgabe für neue Anlagen) | 12 + 42 je Karte | SPS → Edge | WAGO-Registerbild v1 an seiner Basisadresse; nicht Teil dieses Vertrags |
| **W Wunsch** | Halteregister | 0 bis 63 | 64 | Edge → SPS | Kopf (16) und 8 Stellplätze je 6 |

Das Koppelbild ist je Fassung fest: 8 Stellplätze, keine Längen im Kopf.
Stellplatz n (1 bis 8) liegt in W bei 16 + (n − 1) · 6 und in Q bei 1020 + (n − 1) · 12.
Dass eine Anlage ein Koppelbild hat, erkennt die Box an der Signatur bei 1000, nicht an einem Feld des Erzeuger-Bilds.

## 3. Abschnitt W: Wunsch (Halteregister 0 bis 63)

| Adresse | Wörter | Feld | Typ | Ungültig | Einheit | Bedeutung |
|---|---|---|---|---|---|---|
| 0 | 2 | `signatur` | U32 | – | 0x5650 0x4B57 | „VP“ „KW“: das ist ein Koppelbild-Wunsch |
| 2 | 2 | `wortfolge` | U32 | – | 0x01020304 | Prüfwert, über dieselbe Routine wie jeder 32-bit-Wert |
| 4 | 1 | `version` | U16 | – | 0x0100 | höherwertiges Byte Hauptversion 1, niederwertiges Nebenversion 0 |
| 5 | 1 | `platz_anzahl` | U16 | – | 8 | Zahl der Stellplätze im Telegramm |
| 6 | 1 | `sitzung` | U16 | 0xFFFF | Zufallszahl 1 bis 65534 | neu bei jedem Programmstart der Edge; 0 und 0xFFFF sind ungültig |
| 7 | 1 | `herzschlag` | U16 | – | +1 je Telegramm, 65535 → 0 | Lebenszeichen der Edge |
| 8 | 2 | `steuerung_id` | U32 | 0xFFFFFFFF | Nummer | für welche Steuerung das Telegramm gilt; 0 = Grundprogramm ohne Anlage |
| 10 | 1 | `frist_s` | U16 | 0xFFFF | s, 5 bis 600 | so lange gilt das Telegramm ab Empfang; 0 ist ungültig |
| 11 | 1 | `e_bits` | U16 | 0xFFFF | Bitfeld (§6) | Lage der Edge |
| 12 | 3 | `frei` | U16 | – | 0 | in 1.0 immer 0 |
| 15 | 1 | `siegel` | U16 | – | CRC-16/MODBUS (§8) | über die Wörter 0 bis 14 und 16 bis 63 |
| 16 | 1 | `w_art` | U16 | 0xFFFF | Vokabular `art` (§7) | 0 = kein Wunsch für diesen Stellplatz |
| 17 | 1 | `w_grund` | U16 | 0xFFFF | Vokabular `grund` (§7) | warum die Edge das wünscht; Auskunft, keine Weiche |
| 18 | 2 | `w_wert` | S32 | 0x7FFFFFFF | nach der Art | der gewünschte Wert |
| 20 | 1 | `w_folge` | U16 | – | +1 bei jeder Änderung von Art oder Wert | lässt die Quittung dem Wunsch zuordnen |
| 21 | 1 | `frei` | U16 | – | 0 | in 1.0 immer 0 |

Adressen 16 bis 21 gelten für Stellplatz 1; Stellplatz n liegt bei Adresse + (n − 1) · 6.

- **Ein Telegramm ist immer ganz.**
  Die Edge schreibt alle 64 Wörter mit einem Funktionscode 16.
  Ein Stellplatz ohne Wunsch trägt `w_art` 0, `w_grund` 0 und `w_wert` das Typ-Maximum; seine Folge bleibt stehen.
- **Die Folge zählt jede Änderung**, auch wenn ein Wunsch wegfällt oder wiederkommt (K25); sie beginnt mit der Sitzung bei 0.
- **Die Frist erneuert sich nur durch ein angenommenes Telegramm.**
  Empfohlen sind 60 s bei 5 s Takt, also zwölf verlorene Telegramme bis zum Ablauf; das entspricht den Totmann-Zeiten, die die Box bei Wechselrichtern vorfindet ([Edge-Laufzeit](../../edge-runtime.md)).

## 4. Abschnitt Q: Quittung (Eingangsregister 1000 bis 1115)

| Adresse | Wörter | Feld | Typ | Ungültig | Einheit | Bedeutung |
|---|---|---|---|---|---|---|
| 1000 | 2 | `signatur` | U32 | – | 0x5650 0x4B51 | „VP“ „KQ“: das ist eine Koppelbild-Quittung |
| 1002 | 2 | `wortfolge` | U32 | – | 0x01020304 | Prüfwert |
| 1004 | 1 | `version` | U16 | – | 0x0100 | Bildfassung |
| 1005 | 1 | `platz_anzahl` | U16 | 0xFFFF | 0 bis 8 | so viele Stellplätze bietet die Anlage an |
| 1006 | 1 | `herzschlag` | U16 | – | +1 je s, Start 0 | Lebenszeichen der SPS, derselbe Takt wie im Erzeuger-Bild |
| 1007 | 1 | `bibliothek` | U16 | 0xFFFF | 0xHHNN | Fassung der VoltPilot-Bibliothek, Haupt und Neben |
| 1008 | 2 | `steuerung_id` | U32 | 0xFFFFFFFF | Nummer | Kennung der Steuerung; gleich der im Erzeuger-Bild |
| 1010 | 1 | `kopf_urteil` | U16 | 0xFFFF | Vokabular `kopf_urteil` (§7) | Urteil über das zuletzt empfangene Telegramm |
| 1011 | 1 | `q_sitzung` | U16 | – | Echo, 0 = keines | Sitzung des zuletzt angenommenen Telegramms |
| 1012 | 1 | `q_herzschlag` | U16 | – | Echo | Herzschlag des zuletzt angenommenen Telegramms |
| 1013 | 1 | `rest_s` | U16 | 0xFFFF | s | Restlaufzeit des geltenden Telegramms; 0 = abgelaufen oder keines |
| 1014 | 1 | `q_bits` | U16 | 0xFFFF | Bitfeld (§6) | Lage der SPS |
| 1015 | 1 | `angenommen_zaehler` | U16 | – | Anzahl, 65535 → 0 | angenommene Telegramme seit Programmstart |
| 1016 | 1 | `abgelehnt_zaehler` | U16 | – | Anzahl, 65535 → 0 | abgelehnte Telegramme seit Programmstart |
| 1017 | 2 | `frei` | U16 | – | 0 | in 1.0 immer 0 |
| 1019 | 1 | `siegel` | U16 | – | CRC-16/MODBUS (§8) | über die Wörter 1000 bis 1018 und 1020 bis 1115 |
| 1020 | 1 | `a_art` | U16 | 0xFFFF | Vokabular `art` | was dieser Stellplatz stellt; 0 = Platz leer |
| 1021 | 1 | `a_ziel` | U16 | 0xFFFF | Vokabular `ziel` | worauf er wirkt |
| 1022 | 1 | `a_nr` | U16 | 0xFFFF | Nummer, 0 = ohne | Nummer des Ziels (Einheit des Erzeuger-Bilds, Speicher, Verbraucher) |
| 1023 | 1 | `a_bits` | U16 | 0xFFFF | Bitfeld (§6) | bereit und Gründe für „nicht bereit“ |
| 1024 | 2 | `a_min` | S32 | 0x7FFFFFFF | nach der Art | kleinster Wert, den die Anlage annimmt |
| 1026 | 2 | `a_max` | S32 | 0x7FFFFFFF | nach der Art | größter Wert, den die Anlage annimmt |
| 1028 | 1 | `q_urteil` | U16 | 0xFFFF | Vokabular `q_urteil` (§7) | Urteil über den Wunsch dieses Stellplatzes |
| 1029 | 1 | `q_folge` | U16 | – | Echo von `w_folge` | auf welchen Wunsch sich das Urteil bezieht |
| 1030 | 2 | `q_wirksam` | S32 | 0x7FFFFFFF | nach der Art | der Wert, den das Anlagenprogramm für dieses Ziel gerade anwendet |

Adressen 1020 bis 1031 gelten für Stellplatz 1; Stellplatz n liegt bei Adresse + (n − 1) · 12.

- **`q_wirksam` gilt auch ohne Wunsch.**
  Es ist der Wert, den die Anlage gerade fährt, gleich woher er kommt; trägt es das Typ-Maximum, begrenzt oder stellt gerade niemand.
- **Ein leerer Platz** (`a_art` 0) trägt `a_ziel`, `a_nr`, `a_bits` 0 und `a_min`, `a_max` das Typ-Maximum; der Leser liest sein Angebot nicht.
- **Angebot ist Einrichtung, kein Messwert.**
  `a_art`, `a_ziel`, `a_nr`, `a_min`, `a_max` ändern sich nur mit dem Anlagenprogramm; die Box nimmt sie als Fähigkeiten (§15), die übrigen Felder im Takt.
- **Die Zähler haben keinen Ungültig-Wert**, wie im Erzeuger-Bild: 0xFFFF ist dort ein Wert.

## 5. Was die SPS mit einem Telegramm tut, in dieser Reihenfolge

1. Wort 0 ≠ 0x5650 oder Wort 1 ≠ 0x4B57 → `signatur_fremd`
2. Hauptversion ≠ 1 → `version_fremd`
3. Wort 2 ≠ 0x0102 oder Wort 3 ≠ 0x0304 → `wortfolge_falsch`
4. `siegel` stimmt nicht → `siegel_falsch`
5. `steuerung_id` ≠ eigene Kennung → `steuerung_fremd`
6. `frist_s` nicht 5 bis 600, `sitzung` 0 oder 0xFFFF, oder `platz_anzahl` nicht 8 → `kopf_ungueltig`
7. Fernsteuerung an der Anlage nicht freigegeben → `gesperrt`
8. sonst `angenommen`: Frist neu setzen (höchstens die am Baustein eingestellte Obergrenze, Vorgabe 60 s)

Jeder Grund 1 bis 6 heißt: **dieses Telegramm bewirkt nichts**, lieber kein Wunsch als ein falscher; `abgelehnt_zaehler` + 1.
Das zuletzt angenommene Telegramm gilt weiter, bis seine Frist abläuft.
Ein Telegramm nach Grund 7 oder 8 ist gültig: `q_sitzung` und `q_herzschlag` übernehmen es, `angenommen_zaehler` + 1, `edge_lebt` beginnt neu.
Nach Grund 7 gilt kein Wunsch und keine Frist (`rest_s` 0); erst ein neues Telegramm nach der Freigabe gilt (K12).

Drei Festlegungen dieses Vertrags über den Entwurf hinaus:

- **Programmstart.** Was beim ersten Aufruf des Bausteins in den Halteregistern steht, ist kein Telegramm, nur der Vergleichsstand; nach einem Neustart der SPS steht `kopf_urteil` darum auf `keins` (K10).
- **Nur Geändertes.** Geprüft wird nur ein Telegramm, dessen Wörter sich seit der letzten Prüfung geändert haben; die Edge ändert mit jedem Telegramm mindestens den Herzschlag. Eine hängende Edge, die dieselben Wörter wiederholt, erneuert die Frist nicht (K24).
- **Fernsteuerung entzogen.** Nimmt die Anlage die Freigabe zurück, während eine Frist läuft, fallen alle Wünsche sofort: `kopf_urteil` `gesperrt`, `rest_s` 0.

Danach je Stellplatz des geltenden Telegramms, in jedem Zyklus:

1. `w_art` = 0 → `kein_wunsch`
2. `w_art` ≠ `a_art` des Angebots (auch: Platz leer) → `art_fremd`
3. `w_wert` ist das Typ-Maximum → `wert_ungueltig`
4. `a_bits` Bit 0 `bereit` = 0 → `nicht_bereit`
5. `w_wert` außerhalb `a_min` bis `a_max` → auf das Band begrenzt, `begrenzt`
6. sonst `angenommen`

Der so zugelassene Wert geht an das Anlagenprogramm (`aWunsch[n].xGilt`, `diWert`).
Wendet es wegen eines Vorrangs etwas anderes an, meldet es das (`aRueckmeldung[n].xUeberstimmt`), und das Urteil wird `ueberstimmt`; der zugelassene Wert bleibt am Ausgang, das Anlagenprogramm entscheidet.
Steht die Anlage auf Hand oder Ort (`xHandOrt`), nimmt der Baustein jedem Stellplatz die Bereitschaft und setzt `grund_hand_ort` (K15).
Gilt kein Telegramm, trägt ein Stellplatz mit Wunsch im letzten gültigen Telegramm `abgelaufen` (Frist vorbei) oder `nicht_bereit` (gesperrt), sonst `kein_wunsch`.
Läuft die Frist ab: `kopf_urteil` `abgelaufen`, `rest_s` 0, das Anlagenprogramm fährt mit eigenen Werten (K4).
`rest_s` sind die aufgerundeten Sekunden bis zum Ende der Frist; abgelaufen ist sie, sobald sie erreicht ist.

## 6. Bitfelder

Bits ab „frei ab“ sind in 1.0 immer 0; eine Nebenversion darf ihnen Bedeutung geben, ein Leser der 1.0 übergeht sie.

| Feld | Bit | Name | Bedeutung |
|---|---|---|---|
| `e_bits` | 0 | `cloud_verbunden` | die Edge hat Verbindung zur Cloud |
| `e_bits` | 1 | `plan_frisch` | ein gültiger, frischer Fahrplan liegt vor |
| `e_bits` | 2 | `steuerung_frei` | die Steuerungsfreigaben der Box sind gesetzt |
| `e_bits` | 3 | `probe` | die Wünsche stammen aus einem Schalt-Test oder der Werkstatt |
| `q_bits` | 0 | `fernsteuerung_frei` | das Anlagenprogramm lässt Wünsche zu |
| `q_bits` | 1 | `edge_lebt` | das letzte angenommene Telegramm ist jünger als 15 s |
| `q_bits` | 2 | `hand_ort` | die Anlage steht auf Hand oder Ort |
| `a_bits` | 0 | `bereit` | der Stellplatz kann jetzt gestellt werden |
| `a_bits` | 1 | `grund_stoerung` | nicht bereit: Störung |
| `a_bits` | 2 | `grund_hand_ort` | nicht bereit: Hand oder Ort |
| `a_bits` | 3 | `grund_wartung` | nicht bereit: Wartung |
| `a_bits` | 4 | `grund_vorrang` | eine Stelle mit Vorrang bestimmt gerade (Netzbetreiber, Direktvermarkter, Schutz) |
| `a_bits` | 5 | `grund_sonstiger` | nicht bereit: sonstiger Grund |

Frei ab: `e_bits` Bit 4, `q_bits` Bit 3, `a_bits` Bit 6.
`grund_vorrang` darf mit `bereit` zusammen stehen (K3): der Stellplatz nimmt Wünsche an, eine Stelle mit Vorrang bestimmt trotzdem.

## 7. Aufzählungen

Ein Wert außerhalb des Vokabulars ist kein Wert (Grund `fremd`), das Typ-Maximum ebenso (`ungueltig`).
Die Arten sind die Kommandos des [Schiedsrichters der Box](./edge-desired-arbitration.md), in ganzen Einheiten statt Kommazahlen (§15).

| Feld | Code | Name | Einheit von Wert, Band und wirksam | Bedeutung |
|---|---|---|---|---|
| `art` | 0 | `keiner` | – | kein Wunsch, Platz leer |
| `art` | 1 | `limit_w` | W, nie negativ | Obergrenze einer Leistung; eine Grenze begrenzt und fordert nie an |
| `art` | 2 | `limit_pct` | 0,1 % der Nennleistung, 0 bis 1000 | Obergrenze in Prozent |
| `art` | 3 | `setpoint_w` | W mit Vorzeichen | Sollwert: Speicher + lädt und − entlädt, Verbraucher + Verbrauch |
| `art` | 4 | `on_off` | 0 oder 1 | aus oder ein |
| `art` | 5 | `mode` | 1 bis 8 | Betriebsart nach der Liste der Anlage |
| `art` | 6 | `setpoint_c` | 0,1 °C | Sollwert einer Temperatur |
| `ziel` | 1 | `erzeugung_gesamt` | | die ganze Erzeugung der Anlage |
| `ziel` | 2 | `erzeugungseinheit` | | eine Einheit; `a_nr` ist ihre Nummer im Erzeuger-Bild |
| `ziel` | 3 | `speicher` | | ein Speicher; `a_nr` zählt ab 1 |
| `ziel` | 4 | `verbraucher` | | ein Verbraucher; `a_nr` zählt ab 1 |
| `ziel` | 5 | `netzbezug` | | Bezug am Netzpunkt (mit `limit_w`: höchster Bezug) |
| `ziel` | 6 | `einspeisung` | | Einspeisung am Netzpunkt (mit `limit_w`: höchste Einspeisung) |
| `ziel` | 7 | `probe` | | Probe-Stellplatz des Grundprogramms (Lampe am Gerät) |
| `grund` | 0 | `keiner` | | ohne Angabe |
| `grund` | 1 | `markt` | | Fahrplan, Preis |
| `grund` | 2 | `netz` | | Grenze oder Vorgabe am Netzanschluss |
| `grund` | 3 | `regel` | | Regel oder Steuerlogik der Anlage |
| `grund` | 4 | `hand` | | Handeingriff im Portal oder an der Box |
| `grund` | 5 | `test` | | Schalt-Test, Werkstatt |
| `kopf_urteil` | 0 | `keins` | | seit dem Programmstart kam kein Telegramm |
| `kopf_urteil` | 1 | `angenommen` | | |
| `kopf_urteil` | 2 | `signatur_fremd` | | |
| `kopf_urteil` | 3 | `version_fremd` | | |
| `kopf_urteil` | 4 | `wortfolge_falsch` | | |
| `kopf_urteil` | 5 | `siegel_falsch` | | |
| `kopf_urteil` | 6 | `steuerung_fremd` | | |
| `kopf_urteil` | 7 | `kopf_ungueltig` | | Frist außerhalb 5 bis 600 s, Sitzung 0 oder 0xFFFF, oder `platz_anzahl` nicht 8 |
| `kopf_urteil` | 8 | `abgelaufen` | | die Frist des letzten angenommenen Telegramms ist vorbei |
| `kopf_urteil` | 9 | `gesperrt` | | Fernsteuerung an der Anlage nicht freigegeben: gültig, aber kein Wunsch gilt |
| `q_urteil` | 0 | `kein_wunsch` | | |
| `q_urteil` | 1 | `angenommen` | | der Wunsch gilt unverändert |
| `q_urteil` | 2 | `begrenzt` | | auf das Band des Angebots begrenzt |
| `q_urteil` | 3 | `art_fremd` | | die Art passt nicht zum Angebot (auch: Platz leer) |
| `q_urteil` | 4 | `wert_ungueltig` | | der Wert ist das Typ-Maximum |
| `q_urteil` | 5 | `nicht_bereit` | | Grund in `a_bits`; auch, solange die Fernsteuerung gesperrt ist |
| `q_urteil` | 6 | `ueberstimmt` | | eine Stelle mit Vorrang bestimmt; `q_wirksam` nennt ihren Wert |
| `q_urteil` | 7 | `abgelaufen` | | die Frist ist vorbei |

Vorzeichen und Einheiten folgen den bestehenden Verträgen: W statt kW, am Speicher lädt positiv, am Netzpunkt wird nie mit Vorzeichen gestellt, sondern mit zwei getrennten Zielen.
Der Grund ist Auskunft: der Baustein reicht ihn unverändert an das Anlagenprogramm, auch einen unbekannten Code (K17).

**Band je Art.** Ein Angebot, dessen Band nicht in das natürliche Band seiner Art passt oder verkehrt ist (`a_min` > `a_max`), nimmt die Box nicht als Fähigkeit: Grund `angebot_ungueltig` (K27).

| Art | natürliches Band |
|---|---|
| `limit_w` | 0 bis 2 147 483 646 W |
| `limit_pct` | 0 bis 1000 (0,1 %) |
| `on_off` | 0 bis 1 |
| `mode` | 1 bis 8 |
| `setpoint_w`, `setpoint_c` | jeder Wert außer dem Typ-Maximum |

## 8. Siegel

`siegel` ist CRC-16/MODBUS (Polynom 0xA001 gespiegelt, Startwert 0xFFFF, kein Schluss-XOR) über die Bytes aller Wörter des Abschnitts außer dem Siegelwort, in aufsteigender Adresse, je Wort das höherwertige Byte zuerst.
Das Ergebnis steht als Zahl im Wort.
Prüfwert des Verfahrens: die Zeichenfolge „123456789“ ergibt 0x4B37.

- **Wozu:** Ein halb angekommenes Telegramm, ein einzelnes überschriebenes Register oder ein halb gelesener Abschnitt Q fällt auf, gleich wie der Modbus-Dienst der Steuerung intern arbeitet.
- **Wozu nicht:** Das Siegel ist kein Schlüssel und beweist keinen Absender.
- **Nur Nullen sind nie gültig:** Leert der Watchdog des Modbus-Servers die Halteregister, scheitert schon die Signatur (K7).

## 9. Lesen der Quittung (Edge), in dieser Reihenfolge

1. Antwort kürzer als 116 Wörter → `zu_wenig_woerter`
2. Signatur ≠ 0x5650 0x4B51 → `signatur_fremd`
3. Hauptversion ≠ 1 → `version_fremd`
4. Prüfwert ≠ 0x0102 0x0304 → `wortfolge_falsch`
5. Siegel stimmt nicht → `siegel_falsch`
6. `platz_anzahl` über 8 oder 0xFFFF → `platz_anzahl_ungueltig`
7. `steuerung_id` ≠ Soll → `steuerung_id_abweichend`: der Kopf ist lesbar, die Edge schreibt nichts

Jeder Grund 1 bis 6 heißt: nicht lesbar, kein einziger Wert, und die Edge schreibt in diesem Takt kein Telegramm; das angenommene gilt bis zu seiner Frist, die nächste Lesung entscheidet (K22).
Danach je Wert wie im Erzeuger-Bild: Typ-Maximum → kein Wert (`ungueltig`), außerhalb des Vokabulars → kein Wert (`fremd`).
Ein Stellplatz mit `a_art` 0 hat kein Angebot; eines mit ungültigem Ziel, ungültiger Nummer, ungültigen Bits oder unpassendem Band ebenso (`angebot_ungueltig`).

## 10. Lebenszeichen, Neustart, zweiter Schreiber

Die Edge bewertet jede Lesung zu einer Lage; die Lage sagt, ob sie im nächsten Takt schreibt und ob das Telegramm Wünsche trägt.

| Lage | Woran erkannt | schreibt | wünscht |
|---|---|---|---|
| `bereit` | die Steuerung nimmt Telegramme an | ja | ja |
| `gesperrt` | `kopf_urteil` `gesperrt` oder `fernsteuerung_frei` 0 | ja | nein |
| `sps_neustart` | `herzschlag` rückwärts über mehr als die Schrittgrenze 120 (Regel wie im Erzeuger-Bild), oder `kopf_urteil` wieder `keins`, nachdem die Edge schon schrieb | ja | ja |
| `sps_steht` | derselbe `herzschlag` ab der dritten Lesung in Folge | nein | nein |
| `zweiter_schreiber` | `q_sitzung` ist nicht die eigene, oder `angenommen_zaehler` wuchs seit der vorigen lesbaren Lesung um mehr, als die Edge schrieb | nein | nein |
| `steuerung_fremd` | `steuerung_id` der Quittung ist nicht das Soll | nein | nein |
| `nicht_lesbar` | Quittung nicht lesbar (§9) | nein | nein |
| `keine_antwort` | Modbus antwortet nicht | nein | nein |
| `ohne_soll` | die Fassung der Steuerung nennt keine `steuerung_kennung` | nein | nein |

- **Edge schweigt:** nach 15 s ohne angenommenes Telegramm ist `edge_lebt` 0 (Auskunft); die Wünsche gelten weiter bis zur Frist.
- **Edge neu gestartet:** neue `sitzung`, Herzschlag und Folgen beginnen neu; die SPS deutet die Reihenfolge der Zahlen nicht (K9). Wünsche werden neu gebildet, nie aus dem Gedächtnis fortgesetzt.
- **SPS steht:** Werte gelten als veraltet, nie als null; keine Wünsche; Meldung (K23).
- **Zweiter Schreiber:** die Edge stellt das Schreiben ein und meldet es, nie zwei Herren. Sie schreibt erst wieder, wenn `angenommen_zaehler` zwölf Lesungen in Folge (60 s) nicht gewachsen ist (K11).
- Gezählt werden die eigenen Telegramme seit der vorigen lesbaren Lesung; eine unlesbare Lesung dazwischen zählt nicht mit.

## 11. Rechenbeispiele

Gerechnet mit dem Referenzmodell; die Prüfer rechnen sie nach.

| Wörter | Typ | Wert | Anmerkung |
|---|---|---|---|
| `0x5650 0x4B57` | U32 | Signatur „VP“ „KW“ | Abschnitt W |
| `0x5650 0x4B51` | U32 | Signatur „VP“ „KQ“ | Abschnitt Q |
| `0x0002 0x6D18` | S32 | 159 000 | Grenze 159 kW = 60 % von 265 kW |
| `0x0004 0x0B28` | S32 | 265 000 | `a_max` einer PV-Anlage mit 265 kW |
| `0x0001 0x9E10` | S32 | 106 000 | 40 % von 265 kW |
| `0xFFFF 0xB1E0` | S32 | −20 000 | Speicher: 20 kW entladen |
| `0x7FFF 0xFFFF` | S32 | kein Wert | Stellplatz ohne Wunsch |

**Fall K1, ein Wunsch wird angenommen.**
Die Edge (Sitzung 0x3A7C, Herzschlag 412) wünscht für die Steuerung 1042 auf Stellplatz 1 eine Grenze von 159 000 W, Grund Markt, Frist 60 s:

- Kopf W: `0x5650 0x4B57 0x0102 0x0304 0x0100 0x0008 0x3A7C 0x019C 0x0000 0x0412 0x003C 0x0007 0x0000 0x0000 0x0000 0x4ED7`
- Stellplatz 1: `0x0001 0x0001 0x0002 0x6D18 0x0007 0x0000`
- Stellplätze 2 bis 8 je: `0x0000 0x0000 0x7FFF 0xFFFF 0x0000 0x0000`

Die SPS (Herzschlag 1731, Bibliothek 1.0) quittiert zwei Sekunden später:

- Kopf Q: `0x5650 0x4B51 0x0102 0x0304 0x0100 0x0001 0x06C3 0x0100 0x0000 0x0412 0x0001 0x3A7C 0x019C 0x003A 0x0003 0x0061 0x0000 0x0000 0x0000 0x8E72`
- Stellplatz 1: `0x0001 0x0001 0x0000 0x0001 0x0000 0x0000 0x0004 0x0B28 0x0001 0x0007 0x0002 0x6D18`
- Stellplätze 2 bis 8 je: `0x0000 0x0000 0x0000 0x0000 0x7FFF 0xFFFF 0x7FFF 0xFFFF 0x0000 0x0000 0x7FFF 0xFFFF`
- Gelesen: ein Stellplatz angeboten (`limit_w` auf `erzeugung_gesamt`, Band 0 bis 265 000 W, bereit), `kopf_urteil` `angenommen`, Sitzung und Herzschlag sind die eigenen, noch 58 s, Fernsteuerung frei, Edge lebt, 97 Telegramme angenommen, Urteil `angenommen` zu Folge 7, wirksam 159 000 W.

**Fall K3, der Netzbetreiber gibt 40 % vor.**
Stellplatz 1 in Q: `0x0001 0x0001 0x0000 0x0011 0x0000 0x0000 0x0004 0x0B28 0x0006 0x0007 0x0001 0x9E10`
Gelesen: bereit, `grund_vorrang`, Urteil `ueberstimmt`, wirksam 106 000 W.
Wer bestimmt, sagt das Erzeuger-Bild (`quelle_p` `netzbetreiber`).

**Fall K5, ein Wort wurde nach dem Schreiben verändert** (Wort 18 statt 0x0002 nun 0x0003).
Das Siegel im Telegramm bleibt 0x4ED7, gerechnet ergäbe sich 0x8E6B → `siegel_falsch`, nichts wird angewandt.

**Fall K7, nur Nullen.**
Die Signatur ist 0x0000 0x0000 → `signatur_fremd`.
Über 63 Nullwörter ergäbe das Siegel 0x1AAB, im Wort steht 0x0000.

**Fall K16, Speicher entladen.**
Stellplatz 2 in W: `0x0003 0x0001 0xFFFF 0xB1E0 0x0003 0x0000` = `setpoint_w` −20 000 W, Grund Markt, Folge 3.

**Fall K20, Probe der Werkstatt.**
Kopf W: `0x5650 0x4B57 0x0102 0x0304 0x0100 0x0008 0x1111 0x0003 0x0000 0x0000 0x0014 0x000C 0x0000 0x0000 0x0000 0x94E3`, Stellplatz 8: `0x0004 0x0005 0x0000 0x0001 0x0001 0x0000`
Gelesen: Steuerung 0 (Grundprogramm), Frist 20 s, `steuerung_frei` und `probe`, Stellplatz 8 `on_off` ein, Grund Test.

## 12. Fälle

| Fall | zeigt |
|---|---|
| K1 | Wunsch angenommen: `limit_w` auf die ganze Erzeugung, Quittung, wirksam |
| K2 | begrenzt: Wunsch 300 000 W bei `a_max` 265 000 W |
| K3 | überstimmt: der Netzbetreiber gibt weniger vor |
| K4, K4b | Frist läuft ab: die Edge schweigt, `edge_lebt` nach 15 s 0, `rest_s` zählt auf 0, alle Wünsche `abgelaufen`; `frist_s` 600 läuft trotzdem nach 60 s ab |
| K5, K6 | Siegel falsch: ein Wort verändert; nur die ersten 32 Wörter neu |
| K7 | nur Nullen (Watchdog des Modbus-Servers hat geleert) |
| K8 | fremde Steuerung: `steuerung_id` passt nicht, auf beiden Seiten |
| K9, K10 | Edge neu gestartet (neue Sitzung); SPS neu gestartet (Rücksprung, `keins`) |
| K11 | zweiter Schreiber: Zähler wächst schneller, als die Edge schreibt; Wiederaufnahme nach 12 ruhigen Lesungen |
| K12 | Fernsteuerung gesperrt, wieder frei, während einer Frist entzogen |
| K13, K14, K15 | `art_fremd` (auch auf leerem Platz), `wert_ungueltig`, `nicht_bereit` (Störung, Hand/Ort) |
| K16 | Speicher mit Vorzeichen |
| K17, K18 | Nebenversion 1.1 mit unbekanntem Bit und Code auf beiden Seiten; Hauptversion 2 |
| K19 | Wortfolge falsch, obwohl Signatur, Fassung und Siegel stimmen |
| K20 | Probe-Stellplatz der Werkstatt, Frist 20 s |
| K21 | `kopf_ungueltig`: `frist_s` 0, 0xFFFF, 4 und 601; Sitzung 0 und 0xFFFF; `platz_anzahl` 7; die Grenzen 5 und 600 gelten |
| K22 | halb gelesene Quittung: Siegel von Q falsch, nächste Lesung gilt |
| K23 | SPS steht (Herzschlag steht, dann keine Antwort), wieder RUN |
| K24 | dasselbe Telegramm noch einmal: keine neue Frist |
| K25 | Folge: jede Änderung zählt, auch der Wegfall |
| K26 | Grenzfälle nur für Leser: 115 Wörter, `platz_anzahl` 9 und 0xFFFF, Signatur des Wunschs bei 1000, `steuerung_id` ungültig |
| K27 | Angebote, die die Box nicht nimmt; `mode` begrenzt |
| K28 | Lebenszeichen ohne Wunsch, Herzschlag 65535 → 0 |

## 13. Größe und Anfragen

Je Takt drei Anfragen über eine Verbindung, nacheinander: Lese-Bild der Anlage (Funktionscode 4, wie bisher), Quittung (Funktionscode 4, 116 Wörter ab 1000), Wunsch (Funktionscode 16, 64 Wörter ab 0).
Alle bleiben unter 120 Wörtern je Anfrage (`measurement-budget-vectors.json`).
Bei einer Änderung schreibt die Edge sofort (nach einer frischen Lesung der Quittung), höchstens ein Telegramm je Sekunde.

## 14. Versionierung

- **Je Fassung fest:** 8 Stellplätze, feste Adressen.
- **Nebenversion heißt additiv:** ein freies Wort oder ein freies Bit bekommt Bedeutung, oder ein Vokabular bekommt einen neuen Code.
  Ein Leser der 1.0 übergeht freie Wörter und Bits und behandelt einen unbekannten Code als `fremd`, also als kein Wert; die Siegel decken die freien Wörter mit ab (K17).
- **Hauptversion 2** braucht, wer Adressen verschiebt, Bedeutungen ändert oder mehr Stellplätze will.
  W und Q tragen ihre Fassung getrennt; die SPS weist ein Telegramm fremder Hauptversion ab, die Edge schreibt nur die Hauptversion, die Q nennt (K18).
- **Vorbehalt vor dem ersten Einbau:** Solange kein Baustein bei einem Kunden läuft, berichtigt ein PR eine Annahme, die ein Prüfstein widerlegt, in Fassung 1.0 selbst: Vertrag, Vektoren, Prüfer und beide Zwillinge gemeinsam.
- **Das Erzeuger-Bild bleibt 1.0.**
  Ob `quelle_p` einen Code „die Edge bestimmt“ bekommt, ist entschieden: nein; die Auskunft steht allein in Q (`q_urteil`, `q_wirksam`). Das Erzeuger-Bild bleibt damit Wort für Wort gültig.

## 15. Die Box: Stellplätze am Schiedsrichter

Gebaut für Edge Light (Fähigkeit `koppelbild`, [supports](./edge-supports.md)); die Docker-Box hat kein Koppelbild.

**Lesen und Schreiben.**
Die Box liest das Koppelbild in derselben Sitzung wie das Erzeuger-Bild derselben Steuerung, alle 5 s: erst das Erzeuger-Bild, dann die Quittung, dann, wenn die Lage es erlaubt (§10), das Telegramm.
Ohne Signatur „VP KQ“ bei 1000 hat die Steuerung kein Koppelbild, und die Box schreibt nie.
Das Soll der Steuerungskennung ist `steuerung_kennung` der Fassung (`erzeuger_registerbilder`); ohne sie schreibt die Box nie (`ohne_soll`).
Die Sitzung ist eine Zufallszahl 1 bis 65534 je Programmstart der Box, die Frist 60 s.

**Angebot wird Fähigkeit.**
Das Angebot eines Stellplatzes kommt im Herzschlag der Box zur Cloud (Block `koppel`).
Nach einem bestandenen Schalt-Test und der Freigabe dieses Stellplatzes trägt die Anlagensteuerung im Registry-Push eine Fähigkeit `actuate` je freigegebenem Stellplatz mit dem Feld `platz` (additiv, [edge-entity](./edge-entity.schema.json)) und dem Band des Angebots.
Die Freigabe hängt an der Form des Angebots (Art, Ziel, Nummer, Band): ändert das Anlagenprogramm sie, fällt die Freigabe, wie bei den Schreibwerten des [Modbus-Geräts](./modbus-geraet.md).
Je Kommando trägt eine Steuerung höchstens einen freigegebenen Stellplatz, weil der Schiedsrichter je Gerät einen Wert je Kommando gewährt.

| Art | Kommando des Schiedsrichters | Umrechnung beim Schreiben |
|---|---|---|
| `limit_w` | `limit_kw` | kW · 1000, gerundet auf ganze W |
| `limit_pct` | `limit_pct` | % · 10, gerundet |
| `setpoint_w` | `setpoint_kw` | kW · 1000, gerundet, Vorzeichen bleibt |
| `on_off` | `on_off` | aus 0, ein 1 |
| `mode` | `mode` | das Wort „1“ bis „8“ als Zahl |
| `setpoint_c` | `setpoint_c` | °C · 10, gerundet |

Gerundet wird halb vom Nullpunkt weg.
Der Schiedsrichter begrenzt jedes Kommando der Steuerung auf das Band seines Stellplatzes; weitere Schutzgrenzen der Box gibt es für die Steuerung nicht, weil die SPS selbst entscheidet.
Ohne gewährtes Kommando trägt der Stellplatz keinen Wunsch (`failsafe: release`): die Anlage fährt mit eigenen Werten.
Sind die Schalter der Box für die Steuerung zu, schreibt sie Lebenszeichen ohne Wunsch und `steuerung_frei` 0.
Wünsche kommen wie bei jedem Gerät aus Fahrplan, Regeln, Steuerlogik und Handeingriff; die Grenze der Erzeugung aus dem Fahrplan (`pv_limit_kw`) geht an einen freigegebenen `limit_w`-Stellplatz auf `erzeugung_gesamt`.

**Schalt-Test.**
Ein Schalt-Test schreibt für 30 s einen Testwert auf genau einen Stellplatz (Grund `test`, `e_bits` `probe`) und hat in dieser Zeit Vorrang vor dem Schiedsrichter; danach gilt wieder dessen Kommando.
Sein Beleg ist die Quittung: `q_urteil` und `q_wirksam` zur Folge des Testwunschs.
Die Wirkung an der Anlage bestätigt ein Mensch; erst danach gibt es die Freigabe.

Der Schalt-Test ist die Probe-Art `koppel_test` (`docs/contracts/mqtt-probe.schema.json`): Verbindung, Soll der Kennung, Stellplatz, Art, Testwert in den Einheiten des Bilds, `ttl_s` 5 bis 60.
Die Box antwortet mit dem Block `koppel_test` (Lage, Angebot, Folge des Testwunschs, Urteil und wirksamer Wert der SPS); `ok` ist wahr, wenn sie den Testwunsch schreiben konnte und die SPS ihn zu genau dieser Folge quittiert hat.

**Herzschlag-Block `koppel`.**
Die Box (Edge Light, Layer 1) legt ihren Stand retained auf `edge/koppelbild/status`, der Core trägt ihn als Block `koppel` im Herzschlag; ohne Steuerung mit Erzeuger-Plan fehlt der Block.
Er ist Anzeige: die Cloud übernimmt ihn nie in den Soll-Stand, sie zeigt Wunsch, Quittung und Wirkung getrennt und leitet daraus Alarme ab („Steuerung nimmt Wünsche nicht an“, „Bibliothek veraltet“, „zweiter Schreiber“).

```json
"koppel": [{
  "steuerung": "<entity_id der Anlagensteuerung>", "data_source_id": "DQ-1",
  "lage": "bereit", "grund": "signatur_fremd nur bei nicht_lesbar", "gelesen_at": "2026-11-19T21:30:02Z",
  "bibliothek": "1.0", "kopf_urteil": "angenommen", "rest_s": 58, "q_bits": ["fernsteuerung_frei", "edge_lebt"],
  "angenommen_zaehler": 97, "abgelehnt_zaehler": 0,
  "plaetze": [{
    "platz": 1,
    "angebot": {"art": "limit_w", "ziel": "erzeugung_gesamt", "nr": 0, "min": 0, "max": 265000, "bits": ["bereit"]},
    "wunsch": {"art": "limit_w", "grund": "markt", "wert": 159000, "folge": 7}, "test": false,
    "urteil": "angenommen", "folge": 7, "wirksam": 159000
  }]
}]
```

- `gelesen_at` ist die letzte lesbare Lesung; ohne sie sind Kopf und Stellplätze `null`, nie 0.
- `plaetze` nennt nur Stellplätze mit Angebot, Wunsch der Box oder einem Urteil außer `kein_wunsch`; `folge` ist das Echo der SPS (`q_folge`), `wunsch.folge` die eigene Folge der Box.
- Eine Steuerung ohne Koppelbild steht mit `lage` `nicht_lesbar` und `grund` `signatur_fremd` darin.

## 16. Offen und am Gerät zu erheben

| Was | Wo |
|---|---|
| Ob der Modbus-Server von CODESYS auf 127.0.0.1 antwortet, wenn er an keine Schnittstelle gebunden ist, und ob die Firewall ihn von außen sperrt, die Schleife aber nicht | PS-P8, PS-P9 |
| Ob ein zweiter Server mit eigenem Port möglich ist oder die Bibliothek einen eigenen Server mitbringen kann | PS-P10 |
| Ob ein Telegramm halb sichtbar werden kann und wie oft das Siegel greift | PS-P11 |
| Genauigkeit der Frist und Verhalten bei STOP und RUN; ob die Halteregister nach einem Neustart der Laufzeit leer sind | PS-P12, PS-P13 |
| Speicher und Last mit Koppelbild, Edge Light und Tunnel | PS-P21 |
| Ob das Koppelbild auch über das Netz geschrieben werden darf (Box neben der Steuerung); dann braucht es einen Benutzerfilter der Firewall auf die Adresse der Box | das Bau-Paket, das es zuerst braucht |
| Reicht 8 als Zahl der Stellplätze, reicht ein Stellplatz je Kommando | erste Anlagen der Stufe 4 |

## 17. Abgrenzung

Dieser Vertrag ist kein Lese-Bild der Anlage (Erzeuger, Energiekarten), keine Werkstatt (Stufe 3) und keine Zusage zu Normkonformität oder Zertifizierung eines Reglers.
Er legt nur fest, dass Vorgaben mit Vorrang in der SPS immer vor einem Wunsch der Edge gelten.
