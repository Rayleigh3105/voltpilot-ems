# VoltPilot-Registerbild Erzeuger v1 (EZ-1)

Stand 21.10.2026 · Vertrag 1.0 · Registerbild 1.0 (Wort 0x0100, schlanke Fassung) · Konzept
`data/vp-erzeuger-wago-konzept` Fassung 12 §3.1, §3.7, §3.9, §3.10 (`register-vorlage-schlank.json`) ·
Entscheide EW-1, EW-2, EW-5, EW-16, EW-17 vom 21.10.2026 · firstmate A1 = A, A2 = A und Lesarten 1–12 vom 21.10.2026 ·
Wort 24 ohne gültige Vorgabe: Antwort A des Captains vom 23.10.2026 (§3).

Das Registerbild ist die **Vereinbarung zwischen der Steuerung einer Erzeugungsanlage und der Box.** Die
Steuerung (WAGO PFC200 oder ein anderer Controller mit Modbus-TCP-Server) führt die Werte der Anlage zusammen:
Netzpunkt, Erzeugung, was der Netzbetreiber und der Direktvermarkter vorgeben, was davon wirkt und je Einheit
(Wechselrichter oder BHKW-Motor) Zustand, Ist, Soll und Zählerstand. Sie legt sie in einen festen
Eingangsregister-Bereich, den die Box nur liest. Ein Bild gilt für PV und BHKW (EW-1 A); was je Anlage
verschieden ist, erklärt das Bild selbst (Anlagenart, Zahl, Art und Nennleistung der Einheiten, Namen).
Das SPS-Programm, das das Bild füllt, schreibt VoltPilot (SPS-Bibliothek, EW-13 B); gelesen wird es von der
Lese-Familie `erzeuger_registerbild` der Box (EW-4 A).

**Stand vor dem Pilot.** An einer Steuerung belegt ist nur die erste Lesung bei Gore vom 22.10.2026 (Programmstand
2610, Fall E21, `herkunft: steuerung`, `belegt: true`); bei Büttner fehlt die Hardware. Alle anderen Lese-Fälle sind
ausgedacht (`herkunft: vertrag`, `belegt: false`).

| Datei | Rolle |
|---|---|
| [`erzeuger-registerbild.md`](./erzeuger-registerbild.md) | dieser Vertrag |
| [`erzeuger-registerbild-vectors.json`](./erzeuger-registerbild-vectors.json) | Aufbau (Felder, Bits, Vokabular, Namen, Leseregeln) und 21 Lese-Fälle E1–E21 mit rohen Wörtern und vollständiger Erwartung |
| [`erzeuger-registerbild.schema.json`](./erzeuger-registerbild.schema.json) | Schema der Vektor-Datei (Teilmenge des UEMS-Schema-Läufers) |
| `frontend/portal/src/erzeugerRegisterbild.test.ts` | Prüfer: Schema, lückenloser Aufbau, Vertrag ⟷ Datei, Rechenbeispiele, ein unabhängiger Leser über alle Fälle |

**Die Vektoren sind die Leserspezifikation.** Box-Leser (EZ-5), Simulator (EZ-2) und der Bild-Baustein der
SPS-Bibliothek (EZ-3, eigenes Repository) prüfen sich gegen `erzeuger-registerbild-vectors.json`; Zwillinge gibt es
noch keine. Wer den Aufbau ändert, ändert Vektor-Datei, Vertrag und Test gemeinsam — und die Zwillinge, sobald es sie gibt.

## 1. Grundsätze

Übernommen vom [WAGO-Registerbild v1](./wago-registerbild.md), soweit nichts anderes steht (Konzept §3.1):

| Regel | Festlegung |
|---|---|
| Ort | eigene **Eingangsregister, Funktionscode 4, ab Adresse 0** (EW-2 A); Protokolladresse 0-basiert wie im Telegramm. Eingangsregister kann kein Modbus-Client schreiben. |
| Wortfolge | **höherwertiges Wort zuerst**, für jeden 32-bit-Wert; fest, kein Parameter. Innerhalb eines Worts die Byte-Reihenfolge des Modbus-Protokolls. |
| Typen | U16, S16, U32, S32 — keine Gleitkommazahlen, keine Coils; wahr/falsch steht als Bit in einem Bitfeld. 32-bit-Werte beginnen auf geraden Adressen. |
| Ungültig | das **Typ-Maximum**, nie 0: U16 0xFFFF, S16 0x7FFF, U32 0xFFFFFFFF, S32 0x7FFFFFFF. Maßgeblich ist der Typ des Felds: 0xFFFF 0xFFFF in einem S32-Feld ist −1 und ein Wert. Ausnahme: die drei Zähler (§8). |
| Einheiten | Die Steuerung rechnet in die feste Einheit des Felds um (W, kW, 0,1 %, 0,001, 0,1 kWh, s). Die Box rechnet nichts um. |
| Dauern statt Uhrzeiten | `…_seit_s` zählt Sekunden seit der letzten Änderung, höchstens 65534. Den Zeitpunkt setzt die Box mit ihrer eigenen Uhr: Lesezeit − `n_seit_s`. Eine falsch gehende SPS-Uhr schadet nicht. |
| Zähler seit Programmstart | `n_zaehler`, `d_zaehler` zählen Vorgaben; fällt eine Lesung aus, zeigt der Zähler trotzdem, dass dazwischen etwas war. |
| Vorgabe und Wirkung getrennt | Abschnitt N und D zeigen, was Netzbetreiber und Direktvermarkter schicken, Abschnitt S, was danach gilt und wer es bestimmt (`quelle_p`), T, was jede Einheit tut. |
| Unit-ID | gehört zur Datenquelle, nie zum Bild. |
| Takt | die Box liest alle **5 s** (EW-5 A). |

- **Die Steuerungskennung ist kein Identitätsbeweis.** `steuerung_id` vergibt VoltPilot; sie zeigt, ob unter der
  Adresse die erwartete Steuerung antwortet. Das Gerät bleibt über seine eigene Kennung identifiziert; eine Adresse,
  ein Port oder dieselbe Verbindung beweist keine Gerätegleichheit. Eine Einheit ist (Steuerung, Nummer n).
- **Der Prüfwert geht über dieselbe Routine wie jeder 32-bit-Wert** (Lesart 9). Schreibt das Programm ihn als zwei
  Konstanten, prüft er seine Packfunktion nicht — dann sieht ein falsch packendes Programm gesund aus (Fall E5).

## 2. Aufbau

| Abschnitt | Adressen | Wörter | Inhalt |
|---|---|---|---|
| K Kopf | 0–11 | 12 | Signatur, Prüfwert, Fassung, Zahl der Einheiten, Herzschlag, Programmstand, Kennung, Anlagenart, Beginn der Namen |
| A Anlage und Netzpunkt | 12–21 | 10 | Gültigkeit, Alter und Leistung am Netzpunkt, Erzeugung, Zustand, Gasspeicher, installierte Leistung |
| N Netzbetreiber | 22–27 | 6 | Kanal, Bits, Wirkleistungsgrenze, cos φ, seit, Zähler |
| D Direktvermarkter | 28–33 | 6 | Kanal, Bits, Sollwert, seit, Zähler |
| S Wirkung | 34–37 | 4 | wer begrenzt, Bits, wirksame Grenze |
| T Einheit n | 38 + (n − 1) · 10 | je 10 | Zustand, Bits, Art, Nennleistung, Ist, Soll, Zählerstand |
| Namen | ab `beschreibung_ab` (140) | 32 + 16 · n | Netzbetreiber, Direktvermarkter, Typ je Einheit — selten gelesen (§6) |

Das laufende Bild hat **38 + 10 · n Wörter**: Gore (3 Wechselrichter) 68, Büttner (2 Motoren) 58, höchstens
10 Einheiten = 138. Die Steuerung trägt 1 bis 10 Einheiten (`te_anzahl`). Die Wörter zwischen dem Ende der
letzten Einheit und `beschreibung_ab` sind in 1.0 frei.

## 3. Felder

Adressen der Einheit gelten für Einheit 1; Einheit n liegt bei Adresse + (n − 1) · 10. „—“ heißt: kein Ungültig-Wert.

| Adresse | Wörter | Feld | Typ | Ungültig | Einheit | Bedeutung |
|---|---|---|---|---|---|---|
| 0 | 2 | `signatur` | U32 | 0xFFFFFFFF | 0x5650 0x455A | „VP“ „EZ“: das ist ein Erzeuger-Bild |
| 2 | 2 | `wortfolge` | U32 | 0xFFFFFFFF | 0x01020304 | Prüfwert: höherwertiges Wort zuerst |
| 4 | 1 | `version` | U16 | 0xFFFF | 0x0100 | Bildfassung: höherwertiges Byte Hauptversion 1, niederwertiges Nebenversion 0 |
| 5 | 1 | `te_anzahl` | U16 | 0xFFFF | Anzahl, 1 … 10 | Einheiten im Bild (Wechselrichter oder Motoren) |
| 6 | 1 | `herzschlag` | U16 | — | +1 je s, Start 0, 65535 → 0 | steht er dreimal still, gilt alles als veraltet (§8) |
| 7 | 1 | `programmstand` | U16 | 0xFFFF | JJMM | Stand des eingespielten Programms |
| 8 | 2 | `steuerung_id` | U32 | 0xFFFFFFFF | Nummer | Kennung der Steuerung, von VoltPilot vergeben |
| 10 | 1 | `anlagenart` | U16 | 0xFFFF | Vokabular (§5) | Art der Anlage |
| 11 | 1 | `beschreibung_ab` | U16 | 0xFFFF | Adresse, 0 = keine Namen | wo die Namen beginnen (140) |
| 12 | 1 | `a_gueltig` | U16 | 0xFFFF | Bitfeld (§4) | Gültigkeit von Netzpunkt, Erzeugung, Gasspeicher |
| 13 | 1 | `a_alter_s` | U16 | 0xFFFF | s | Alter der Netzpunkt-Messung |
| 14 | 2 | `p_nvp_w` | S32 | 0x7FFFFFFF | W · + Bezug / − Einspeisung | Leistung am Netzpunkt |
| 16 | 2 | `p_erzeugung_w` | S32 | 0x7FFFFFFF | W · + Erzeugung | Summe aller Einheiten |
| 18 | 1 | `anlage_zustand` | U16 | 0xFFFF | Vokabular (§5) | Zustand der ganzen Anlage |
| 19 | 1 | `a_bits` | U16 | 0xFFFF | Bitfeld (§4) | Not-Aus, NA-Schutz, Sammelstörung, Hand/Ort, Wartung |
| 20 | 1 | `speicher_fuellstand` | U16 | 0xFFFF | 0,1 % | Gasspeicher (Gassack) |
| 21 | 1 | `p_installiert_kw` | U16 | 0xFFFF | kW | installierte Leistung |
| 22 | 1 | `n_kanal` | U16 | 0xFFFF | Vokabular (§5) | Weg der Vorgabe des Netzbetreibers |
| 23 | 1 | `n_bits` | U16 | 0xFFFF | Bitfeld (§4) | Vorgabe gültig, Verbindung, begrenzt, Not-Aus, cos φ, Kennlinie |
| 24 | 1 | `n_p_prozent` | U16 | 0xFFFF | 0,1 % | Wirkleistungsgrenze des Netzbetreibers; ohne gültige Vorgabe der wirksame Ersatzwert, nie 0xFFFF, solange einer wirkt |
| 25 | 1 | `n_cosphi` | S16 | 0x7FFF | 0,001 · + über- / − untererregt | cos-φ-Vorgabe |
| 26 | 1 | `n_seit_s` | U16 | 0xFFFF | s, höchstens 65534 | seit der letzten Vorgabe |
| 27 | 1 | `n_zaehler` | U16 | — | Anzahl, 65535 → 0 | Vorgaben seit Programmstart (§8) |
| 28 | 1 | `d_kanal` | U16 | 0xFFFF | Vokabular (§5) | Weg des Direktvermarkters |
| 29 | 1 | `d_bits` | U16 | 0xFFFF | Bitfeld (§4) | Abschnitt gültig, Aktivierung, Stopp, bereit/aktiv gemeldet |
| 30 | 2 | `d_soll_w` | U32 | 0xFFFFFFFF | W | Sollwert des Direktvermarkters |
| 32 | 1 | `d_seit_s` | U16 | 0xFFFF | s, höchstens 65534 | seit der letzten Änderung |
| 33 | 1 | `d_zaehler` | U16 | — | Anzahl, 65535 → 0 | Abrufe seit Programmstart (§8) |
| 34 | 1 | `quelle_p` | U16 | 0xFFFF | Vokabular (§5) | wer gerade begrenzt |
| 35 | 1 | `s_bits` | U16 | 0xFFFF | Bitfeld (§4) | gültig, Anlage folgt |
| 36 | 2 | `p_grenze_w` | U32 | 0xFFFFFFFF | W | wirksame Grenze |
| 38 | 1 | `t_zustand` | U16 | 0xFFFF | Vokabular (§5) | Zustand der Einheit |
| 39 | 1 | `t_bits` | U16 | 0xFFFF | Bitfeld (§4) | Werte/Sollwert gültig, DV bereit/aktiv, Gründe für „nicht bereit“ |
| 40 | 1 | `t_art` | U16 | 0xFFFF | Vokabular (§5) | Art der Einheit (erklärt die Anlage) |
| 41 | 1 | `t_nenn_kw` | U16 | 0xFFFF | kW | Nennleistung der Einheit (erklärt die Anlage) |
| 42 | 2 | `t_p_ist_w` | S32 | 0x7FFFFFFF | W · + Erzeugung | Leistung der Einheit |
| 44 | 2 | `t_p_soll_w` | U32 | 0xFFFFFFFF | W | wirksamer Sollwert der Einheit |
| 46 | 2 | `t_e` | U32 | 0xFFFFFFFF | 0,1 kWh | Zählerstand Erzeugung |

- **Kopf.** Signatur und Prüfwert stehen als Wörter da: Wort 0 = 0x5650, Wort 1 = 0x455A, Wort 2 = 0x0102,
  Wort 3 = 0x0304. Das zweite Signaturwort „EZ“ statt „RB“ trennt das Bild vom WAGO-Energiekarten-Bild — jeder der
  beiden Leser lehnt das andere ab (E3).
- **Vorzeichen.** `p_nvp_w` ist positiv bei Bezug und **negativ bei Einspeisung** am Netzpunkt. `p_erzeugung_w` und
  `t_p_ist_w` sind positiv bei Erzeugung (`p_erzeugung_w` ist die Summe der Einheiten, also gilt für beide dasselbe);
  ein kleiner negativer Wert ist Eigenbedarf. `n_cosphi` + übererregt / − untererregt.
- **`p_installiert_kw` muss nicht Σ `t_nenn_kw` sein.** Bei PV ist es die installierte Modulleistung (Gore 265 kW
  gegen 3 × 125 kW Wechselrichter-Nennleistung). Der Leser prüft keine Summe.
- **Grenze ohne Wert.** Begrenzt niemand (`quelle_p` 0), trägt `p_grenze_w` das Typ-Maximum: kein Wert, nie 0 W.
  Ebenso `d_soll_w` ohne Direktvermarkter.
- **Wort 24 ohne gültige Vorgabe** (Antwort A des Captains vom 23.10.2026). Ist `n_bits` Bit 0 `vorgabe_gueltig` = 0
  (Erstanlauf, Telegramm ungültig oder ausgeblieben), schreibt die Steuerung in `n_p_prozent` den **wirksamen
  Ersatzwert**, mit dem sie die Anlage fährt — bei Gore im Erstanlauf 1000 = 100,0 %. 0xFFFF steht dort nur, wenn gar
  kein Wert wirkt. Ob das eine Vorgabe des Netzbetreibers ist, sagen nur Bit 0 und `quelle_p`: Bit 0 = 0 heißt
  „keine gültige Vorgabe“, `quelle_p` 6 `ersatzwert` heißt „die Anlage fährt mit dem Ersatzwert“, die Grenze selbst
  steht in `p_grenze_w`. Die Deckung bleibt (§4): der Leser liest Wort 24 bei Bit 0 = 0 nicht als Vorgabe (Grund
  `gueltigkeit`) — nie „der Netzbetreiber begrenzt auf 100 %“. `n_cosphi` bleibt ohne Vorgabe 0x7FFF. Für alle
  anderen Felder gilt die Ungültig-Regel aus §1 unverändert (Fall E21).

## 4. Bitfelder und was sie decken

Ein Gültigkeitsbit **deckt** Werte: ist es 0, sind diese Werte **unbekannt** — der Leser liest ihre Wörter nicht,
auch nicht als 0. Ein Wert ohne deckendes Bit ist ein Wert, solange er nicht das Typ-Maximum ist. Ist ein Bitfeld
selbst 0xFFFF, ist jedes seiner Bits unbekannt und jeder gedeckte Wert auch. Bits ab der Spalte „frei ab“ sind in 1.0
immer 0; eine Nebenversion darf ihnen Bedeutung geben, ein 1.0-Leser übergeht sie.

| Feld | Bit | Name | Bedeutung | deckt |
|---|---|---|---|---|
| `a_gueltig` | 0 | `netzpunkt_gueltig` | Netzpunkt gültig | `p_nvp_w` |
| `a_gueltig` | 1 | `netzpunkt_berechnet` | Netzpunkt berechnet (aus mehreren Messungen) | — |
| `a_gueltig` | 2 | `netzpunkt_tot` | Netzpunkt-Messung tot | — |
| `a_gueltig` | 3 | `erzeugung_gueltig` | Erzeugung gültig | `p_erzeugung_w` |
| `a_gueltig` | 4 | `gasspeicher_gueltig` | Gasspeicher gültig | `speicher_fuellstand` |
| `a_bits` | 0 | `not_aus` | Not-Aus vor Ort | — |
| `a_bits` | 1 | `na_schutz` | NA-Schutz | — |
| `a_bits` | 2 | `sammelstoerung` | Sammelstörung | — |
| `a_bits` | 3 | `hand_ort` | Hand/Ort | — |
| `a_bits` | 4 | `wartung` | Wartung | — |
| `n_bits` | 0 | `vorgabe_gueltig` | Vorgabe gültig | `n_p_prozent`, `n_cosphi` |
| `n_bits` | 1 | `verbindung_steht` | Verbindung steht | — |
| `n_bits` | 2 | `wirkleistung_begrenzt` | Wirkleistung begrenzt | — |
| `n_bits` | 3 | `not_aus` | Not-Aus | — |
| `n_bits` | 4 | `cosphi_vorgabe` | cos-φ-Vorgabe | — |
| `n_bits` | 5 | `kennlinie` | Kennlinie | — |
| `d_bits` | 0 | `abschnitt_gueltig` | Abschnitt gültig | `d_soll_w`, `d_seit_s`, `d_zaehler`, `aktivierung`, `stopp`, `bereit_gemeldet`, `aktiv_gemeldet` |
| `d_bits` | 1 | `aktivierung` | Aktivierung | — |
| `d_bits` | 2 | `stopp` | Stopp | — |
| `d_bits` | 3 | `bereit_gemeldet` | bereit gemeldet | — |
| `d_bits` | 4 | `aktiv_gemeldet` | aktiv gemeldet | — |
| `s_bits` | 0 | `gueltig` | gültig | `quelle_p`, `p_grenze_w`, `anlage_folgt` |
| `s_bits` | 1 | `anlage_folgt` | Anlage folgt | — |
| `t_bits` | 0 | `werte_gueltig` | Werte gültig | `t_zustand`, `t_p_ist_w`, `t_e` |
| `t_bits` | 1 | `sollwert_gueltig` | Sollwert gültig | `t_p_soll_w` |
| `t_bits` | 2 | `dv_bereit` | DV bereit | — |
| `t_bits` | 3 | `dv_aktiv` | DV aktiv | — |
| `t_bits` | 4 | `grund_stoerung` | nicht bereit: Störung | — |
| `t_bits` | 5 | `grund_netzbetreiber` | nicht bereit: Vorgabe des Netzbetreibers (§ 9 EEG) | — |
| `t_bits` | 6 | `grund_hand_ort` | nicht bereit: Hand/Ort | — |
| `t_bits` | 7 | `grund_wartung` | nicht bereit: Wartung | — |
| `t_bits` | 8 | `grund_gasspeicher_leer` | nicht bereit: Gasspeicher leer | — |
| `t_bits` | 9 | `grund_sonstiger` | nicht bereit: sonstiger | — |

Frei ab: `a_gueltig` Bit 5, `a_bits` Bit 5, `n_bits` Bit 6, `d_bits` Bit 5, `s_bits` Bit 2, `t_bits` Bit 10.

- **Was nicht gedeckt ist, bleibt lesbar:** `d_kanal` auch bei `d_bits` Bit 0 = 0 (der Weg ist Einrichtung, kein
  Messwert), die Zustandsbits 1–5 von `n_bits` auch ohne gültige Vorgabe, `a_alter_s` auch bei toter Messung (es sagt,
  wie alt sie ist), `t_art` und `t_nenn_kw` immer (sie erklären die Anlage), die DV-Signale und Gründe in `t_bits`
  unabhängig von Bit 0 (sie kommen von der Poolbox, nicht von der Einheit).
- **Gründe für „nicht bereit“** (Bit 4–9) stehen an derselben Stelle wie in der vollen Fassung (Konzept §3.3,
  `t_dv_bits`); die Vermarktung verlangt „bereit“ dauerhaft, die Gründe sagen, warum es fällt.
- **Büttner ohne Netzpunkt (EW-16 C):** `a_gueltig` Bit 0, 1 und 2 sind 0, `p_nvp_w` und `a_alter_s` tragen das
  Typ-Maximum — der Netzpunkt ist unbekannt, nicht tot und nie 0 (E2).

## 5. Aufzählungen

Ein Wert außerhalb des Vokabulars ist **kein Wert** (Grund `fremd`), das Typ-Maximum ebenso (Grund `ungueltig`).
`anlage_zustand` und `t_zustand` teilen ein Vokabular.

| Feld | Code | Name | Bedeutung |
|---|---|---|---|
| `anlagenart` | 1 | `pv` | PV |
| `anlagenart` | 2 | `bhkw` | BHKW |
| `anlagenart` | 3 | `gemischt` | gemischt |
| `anlage_zustand` | 0 | `aus` | aus |
| `anlage_zustand` | 1 | `bereit` | bereit |
| `anlage_zustand` | 2 | `laeuft` | läuft |
| `anlage_zustand` | 3 | `laeuft_begrenzt` | läuft begrenzt |
| `anlage_zustand` | 4 | `stoerung` | Störung |
| `anlage_zustand` | 5 | `hand_wartung` | Hand/Wartung |
| `anlage_zustand` | 6 | `not_aus` | Not-Aus |
| `n_kanal` | 0 | `keiner` | keiner |
| `n_kanal` | 1 | `feste_grenze` | feste Grenze |
| `n_kanal` | 2 | `stufen` | Stufen |
| `n_kanal` | 3 | `fernwirktechnik` | Fernwirktechnik |
| `d_kanal` | 0 | `keiner` | keiner |
| `d_kanal` | 1 | `relais_und_ma` | Relais und mA |
| `d_kanal` | 2 | `modbus` | Modbus |
| `quelle_p` | 0 | `keine_grenze` | keine Grenze |
| `quelle_p` | 1 | `netzbetreiber` | Netzbetreiber |
| `quelle_p` | 2 | `direktvermarkter` | Direktvermarkter |
| `quelle_p` | 3 | `netzpunkt_regelung` | Netzpunkt-Regelung |
| `quelle_p` | 4 | `hand` | Hand |
| `quelle_p` | 5 | `not_aus` | Not-Aus |
| `quelle_p` | 6 | `ersatzwert` | Ersatzwert |
| `t_art` | 1 | `pv_wechselrichter` | PV-Wechselrichter |
| `t_art` | 2 | `bhkw_motor` | BHKW-Motor |

## 6. Namen ab `beschreibung_ab`

Die Namen stehen in einem eigenen Bereich, den die Box **beim Start, bei neuem `programmstand` und einmal am Tag**
liest, nicht alle 5 s. Kopf-Register 11 sagt, wo er beginnt (Vorgabe 140); die Texte liegen relativ dazu:

| Versatz | Wörter | Feld | Inhalt | bei 140 |
|---|---|---|---|---|
| +0 | 16 | `netzbetreiber_name` | Name des Netzbetreibers | 140–155 |
| +16 | 16 | `direktvermarkter_name` | Name des Direktvermarkters, leer = keiner | 156–171 |
| +32 + (n − 1) · 16 | 16 | `t_typ_name` | Hersteller und Typ der Einheit n | 172–187 für n = 1 |

- **Kodierung:** 32 Zeichen, 1 Byte je Zeichen (ISO 8859-1 wie CODESYS `STRING`), **höherwertiges Byte zuerst**, mit
  0 aufgefüllt; Umlaute gehen (ü = 0xFC). Der Text endet am **ersten 0-Byte** — was dahinter steht, zählt nicht. 32
  Zeichen ohne abschließende 0 sind erlaubt. Ein leerer Text heißt „keiner“ (`null`).
- **`beschreibung_ab` 0 oder 0xFFFF** heißt: keine Namen in der Steuerung — das Bild ist voll lesbar, die Namen trägt
  man im Portal ein (E18).
- **Der Bereich muss hinter dem laufenden Bild liegen:** `beschreibung_ab` ≥ 38 + 10 · `te_anzahl` und
  `beschreibung_ab` + 32 + 16 · `te_anzahl` ≤ 65 536. Sonst gibt es keine Namen (`bereich_ungueltig`), das Bild bleibt
  lesbar (E19).
- **Ein geänderter Name ändert nur die Anzeige.** Die Einheit bleibt dieselbe Nummer, ihre Messreihe läuft weiter.

## 7. Lesen: in dieser Reihenfolge

1. Antwort kürzer als der Kopf (12 Wörter) → `zu_wenig_woerter`
2. Wort 0 ≠ 0x5650 oder Wort 1 ≠ 0x455A → `signatur_fremd`
3. Hauptversion (höherwertiges Byte von Wort 4) ≠ 1 → `version_fremd`
4. Wort 2 ≠ 0x0102 oder Wort 3 ≠ 0x0304 → `wortfolge_falsch`
5. `te_anzahl` nicht 1 … 10 (also 0, über 10 oder 0xFFFF) → `te_anzahl_ungueltig`
6. Antwort kürzer als 38 + 10 · `te_anzahl` → `zu_wenig_woerter`

Jeder dieser Gründe heißt **nicht lesbar: kein einziger Wert** — lieber keine Zahl als eine falsche, nie ein halbes
Bild. Bei 5 und 6 ist der Kopf selbst lesbar und darf angezeigt werden („das Bild hat jetzt 3 statt 2 Einheiten“);
bei 6 plant die Box die Anfrage mit dem gelesenen `te_anzahl` neu (E16). Wörter über das laufende Bild hinaus übergeht
der Leser.

Danach je Wert (Kopf, A, N, D, S und jede Einheit), in dieser Reihenfolge:

1. das deckende Gültigkeitsbit (§4) ist nicht gesetzt → kein Wert, Grund `gueltigkeit`
2. das Wort ist das Typ-Maximum des Felds (außer bei den Zählern) → kein Wert, Grund `ungueltig`
3. eine Aufzählung außerhalb ihres Vokabulars → kein Wert, Grund `fremd`
4. sonst der Wert: U16/U32 vorzeichenlos, S16/S32 im Zweierkomplement, in der Einheit des Felds

Ein Bitfeld liefert sein Wort als Wert und jede bekannte Flagge als wahr/falsch; eine durch Bit 0 desselben Felds
gedeckte Flagge ist unbekannt, wenn Bit 0 = 0. Welche Qualitäten, Ereignisse und Findings daraus werden (`stale`,
`frozen_source`, `device_restart`, Vorgaben im Verlauf), bauen EZ-5 und EZ-6. Dieser Vertrag legt fest, wann ein Wort
ein Wert ist.

## 8. Herzschlag und Zähler

**Herzschlag:** +1 je Sekunde, beim Programmstart 0, von 65535 auf 0. Jede lesbare Lesung ist eine Beobachtung;
verglichen wird mit der letzten lesbaren Lesung derselben Steuerung:

| Urteil | wann | Folge |
|---|---|---|
| `steht` | gleich | zählt eine stehende Lesung mehr |
| `laeuft` | größer | Zählung zurück auf 0 |
| `ueberlauf` | kleiner, aber jetzt + 65536 − vorher ≤ 120 | läuft, kein Neustart |
| `rueckwaerts` | kleiner, sonst | Programmneustart; die Zähler beginnen neu |

- **Veraltet ab der dritten gleichen Lesung:** zeigen drei aufeinanderfolgende lesbare Lesungen denselben Herzschlag,
  gilt **alles** aus dieser Steuerung als veraltet (bei 5 s also nach 10 s Stillstand). Gezählt werden Lesungen, nicht
  Übergänge. ⚠ Der WAGO-Leser (`HerzschlagWacht`, `STEHT_AB = 3`, `edge-app/nodered/measurements/wago-kopf.js:97`)
  zählt stehende Übergänge und urteilt erst bei der vierten — wer ihn übernimmt, stellt die Schwelle auf zwei
  Übergänge (E8).
- **Eine nicht lesbare Lesung ist keine Beobachtung:** sie unterbricht die Folge nicht und zählt nicht als stehend;
  aus „nicht gelesen“ wird nie „steht“ (E8).
- Die Werte einer veralteten Lesung bleiben dekodiert; sie sind nur nicht aktuell. Eine Uhrzeit leitet niemand aus
  dem Herzschlag ab.

**Zähler `herzschlag`, `n_zaehler`, `d_zaehler` (firstmate A2 = A):** sie laufen von 65535 auf 0 und haben **keinen
Ungültig-Wert** — 0xFFFF ist dort ein Wert. Die Vorlage nennt für sie 0xFFFF; das gilt nicht, weil ein Zähler, der
überläuft, durch 65535 geht (wie WAGO v1 und der Gore-Entwurf `uHerzschlag := uHerzschlag + 1`).

- **Vorgaben seit der letzten Lesung** = (neu − alt) mod 65536 (E9).
- **Nach einem Neustart** (`rueckwaerts`) ist die Zahl seit der letzten Lesung **unbekannt** (mindestens der neue
  Stand); ab der nächsten Lesung zählt die Differenz wieder.
- Ist ein Zähler gedeckt und sein Bit 0 (`d_zaehler` bei `d_bits` Bit 0 = 0), gibt es keine Differenz.

## 9. Größe und Anfragen

Die Box liest höchstens 120 Wörter je Anfrage (`docs/contracts/v2/measurement-budget-vectors.json` →
`families.modbus.units_per_request`) und **teilt einen Einheiten-Block nie auf zwei Anfragen** — sonst könnten die
Hälften aus zwei Programmzyklen stammen. Bis 8 Einheiten ist das eine Anfrage, **ab 9 Einheiten zwei** (firstmate
A1 = A; die Vorlage sagte „eine Anfrage bis 10 Einheiten“, das rechnet nicht): Anfrage 1 liest Wort 0 bis
37 + 80 = 117 mit Einheit 1–8, Anfrage 2 die Einheiten 9 und 10. Bei 5 s sind das 12 oder 24 Anfragen je Minute
(Grenze 30, `measurement-budget-vectors.json` → `limits.requests`). Ein Text im Namenbereich wird ebenso nie geteilt:
höchstens 7 Texte je Anfrage.

| Einheiten | Wörter | Anfragen | Namen-Wörter | Namen-Anfragen |
|---|---|---|---|---|
| 1 | 48 | 1 | 48 | 1 |
| 2 | 58 | 1 | 64 | 1 |
| 3 | 68 | 1 | 80 | 1 |
| 4 | 78 | 1 | 96 | 1 |
| 5 | 88 | 1 | 112 | 1 |
| 6 | 98 | 1 | 128 | 2 |
| 7 | 108 | 1 | 144 | 2 |
| 8 | 118 | 1 | 160 | 2 |
| 9 | 128 | 2 | 176 | 2 |
| 10 | 138 | 2 | 192 | 2 |

Büttner = 2, Gore = 3 Einheiten: je eine Anfrage für das Bild und eine für die Namen.

## 10. Versionierung

- **Das Bild ist je Fassung fest** (EW-17 A): keine Längen im Kopf, die Einheit n liegt immer bei 38 + (n − 1) · 10.
- **Nebenversion (niederwertiges Byte von `version`) heißt additiv:** ein in 1.0 immer 0 gesetztes Bit bekommt
  Bedeutung, oder ein neues Feld belegt Wörter, die in 1.0 frei sind. Kein Feld ändert je Adresse, Typ oder Bedeutung.
  Ein 1.0-Leser liest jede 1.x weiter und übergeht, was er nicht kennt (E7); die Nebenversion ist Auskunft, keine Weiche.
- **Hauptversion 2** braucht, wer etwas entfernt, verschiebt, umdeutet oder den Block je Einheit verlängert. Der
  Block hat kein freies Wort: die verfügbare Leistung je Einheit, die das Konzept für 1.1 nennt (EW-15), braucht
  einen Platz außerhalb der Blöcke — das entscheidet das Paket, das sie einführt.
- **Vorbehalt vor dem Pilot.** Solange kein Bild-Baustein bei einem Kunden läuft und kein Leser ausgeliefert ist,
  berichtigt ein PR eine Annahme, die EZ-3, EZ-4 oder der erste Einbau widerlegt, in Fassung 1.0 selbst — Vertrag,
  Vektor-Datei und Test gemeinsam. Danach gilt die additive Regel ohne Ausnahme.

## 11. Rechenbeispiele

Wörter → Wert (Wortfolge immer höherwertig zuerst; der Test rechnet jede Zeile nach):

| Wörter | Typ | Wert | Anmerkung |
|---|---|---|---|
| `0xFFFF 0xF7A4` | S32 | −2 140 | `p_nvp_w` in E1: 2,14 kW **Einspeisung** am Netzpunkt |
| `0x0001 0x8768` | S32 | 100 200 | `p_erzeugung_w` in E1 |
| `0xFFFF 0xFFFF` | S32 | −1 | ein Wert, nicht ungültig (E11) |
| `0xFFFF 0xFFFF` | U32 | kein Wert | U32 ungültig |
| `0x7FFF 0xFFFF` | S32 | kein Wert | S32 ungültig |
| `0x011D 0xDDDC` | U32 | 18 734 556 | `t_e` Motor 1 in E2 |
| `0x0102 0x0304` | U32 | 16 909 060 | Prüfwert |
| `0x0304 0x0102` | U32 | 50 594 050 | Prüfwert eines Programms, das das niederwertige Wort zuerst packt → `wortfolge_falsch` (E5) |
| `0x5650 0x455A` | U32 | 1 448 101 210 | Signatur „VP“ „EZ“ |
| `0xFC4A` | S16 | −950 | `n_cosphi` in E1: cos φ 0,950 untererregt |
| `0x7FFF` | S16 | kein Wert | S16 ungültig |
| `0x7FFF` | U16 | 32 767 | in einem U16-Feld ein Wert (E11) |
| `0xFFFF` | U16 | kein Wert | U16 ungültig — außer bei den drei Zählern |

Rohwert × Faktor, wie das Portal anzeigt:

| Rohwert | Faktor | Ergebnis |
|---|---|---|
| 734 | 0,1 % | 73,4 % |
| 700 | 0,1 % | 70,0 % |
| −950 | 0,001 | −0,950 |
| 18 734 556 | 0,1 kWh | 1 873 455,6 kWh |
| 4 718 233 | 0,1 kWh | 471 823,3 kWh |

Zähler (mod 65536):

| alt → neu | Vorgaben dazwischen | Anmerkung |
|---|---|---|
| `1873 → 1873` | 0 | nichts geschehen |
| `65533 → 65535` | 2 | 65535 ist ein Wert |
| `65535 → 1` | 2 | Überlauf |
| `65535 → 3` | 4 | Überlauf |

Namen (zwei Zeichen je Wort, höherwertiges Byte zuerst, ISO 8859-1):

| Wörter | Typ | Text |
|---|---|---|
| `0x4E2D 0x4552` | Text | N-ER |
| `0x57FC 0x727A` | Text | Würz |
| `0x2900 0x0000` | Text | ) |

„WVV (Stadtwerke Würzburg)“ = `0x5756 0x5620 0x2853 0x7461 0x6474 0x7765 0x726B 0x6520 0x57FC 0x727A 0x6275 0x7267
0x2900 0x0000 0x0000 0x0000`. Ein Zeitpunkt aus „seit“: gelesen um 14:30:05 mit `n_seit_s` 3412 → letzte Vorgabe um
13:33:13 (Uhr der Box).

## 12. Lese-Fälle

| Fall | zeigt |
|---|---|
| E1 | Gore: PV, 3 Wechselrichter, 265 kW, Netzbetreiber über Fernwirktechnik (Kanal 3), Einspeisung negativ, kein Direktvermarkter, Namen |
| E2 | Büttner: BHKW, Motoren 66 und 33 kW, feste 70-%-Grenze, Direktvermarkter über Relais und mA (Kanal 1), Gasspeicher, ohne Netzpunkt (EW-16 C), Umlaut im Namen |
| E3, E4 | Signatur fremd: WAGO-Energiekarten-Bild, nur Nullen (Abbild nicht gelegt) |
| E5 | Wortfolge falsch, obwohl Signatur und Fassung stimmen |
| E6, E7 | Hauptversion 2 nicht lesbar; Nebenversion 1.1 liest weiter und übergeht unbekannte Bits |
| E8, E9 | Herzschlag steht (mit nicht lesbarer Lesung dazwischen); Überlauf, Neustart, Zähler mod 65536 |
| E10 | Abschnitte ungültig: a, n, d, s und eine Einheit mit Gültigkeitsbit 0 |
| E11 | Ungültig-Werte je Typ, −1 als Wert, 32 767 in U16, Zähler 65535, Werte außerhalb des Vokabulars |
| E12–E17 | `te_anzahl` 0, 10 (zwei Anfragen, Typname mit genau 32 Zeichen), 11, 0xFFFF; zu wenige Wörter; Kopf unvollständig |
| E18–E20 | keine Namen (`beschreibung_ab` 0), Namenbereich im Bild, Namen-Grenzfälle |
| E21 | Gore, erste Lesung 22.10.2026 (belegt): Vorgabe ungültig, Wort 24 = 1000 Ersatzwert, `quelle_p` 6, Grenze 265,5 kW = Σ Sollwerte |

## 13. Offen und Befunde

| Was | Wo |
|---|---|
| Der Gore-Entwurf schreibt den Prüfwert als zwei Konstanten (`aBild[2] := 16#0102; aBild[3] := 16#0304`) und prüft so seine Packfunktion nicht (§1) | EZ-3, EZ-4 |
| Typen der Gore-Wechselrichter vom Typenschild (in E1 Platzhalter „Growatt WR1 (Typ offen)“), Vorzeichen der cos-φ-Vorgabe bei Gore, Growatt-Zustandscodes | EZ-4 |
| Weg der Netzbetreiber-Vorgabe bei Büttner: feste Grenze (Kanal 1) oder Stufen (Kanal 2), Frage I1 | EZ-13 |
| Ob der Modbus-Dienst der Steuerung einen halb geschriebenen Block ausliefern kann | erster Einbau |
| Platz der verfügbaren Leistung je Einheit (Fassung 1.1, EW-15) | EZ-17 |

## 14. Abgrenzung

Dieser Vertrag ist kein Box-Leser (EZ-5), kein Simulator (EZ-2), kein SPS-Baustein (EZ-3, EZ-4), kein Cloud-Modell und
keine Speicherung (EZ-6), keine Katalog-Familie und kein Fähigkeitswort (`erzeuger_registerbild`, mit EZ-5). Die volle
Fassung des Konzepts (196 Wörter, Längen im Kopf) ist Variante B von EW-17 und nicht Teil dieses Vertrags. Das
WAGO-Energiekarten-Bild ([`wago-registerbild.md`](./wago-registerbild.md)) bleibt ein eigener Vertrag mit eigener
Signatur.
