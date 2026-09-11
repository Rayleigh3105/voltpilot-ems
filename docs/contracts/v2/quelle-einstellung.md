# Einstellungs-Fassungen je Quelle (UEMS AP-04 IP-11)

**Status:** gebaut (AP-04 IP-11, Backend). Konzept `vp-uems-ap04-messstellen` §4.2
„Einstellungen je Quelle", §4.4, §5.7, §6.2, W5; Entscheide **E4 = A** (an der Quelle, die
Messstelle bleibt hardwarefrei) und **E5 = A** (angewendet beim Erfassen, Wirkung nur ab
Gültigkeitsbeginn) vom 10.09.2026. Abnahmefälle **A4**, **A5**.

Vektoren: [`quelle-einstellung-vectors.json`](./quelle-einstellung-vectors.json), Schema:
[`quelle-einstellung.schema.json`](./quelle-einstellung.schema.json) (die Vektor-Datei ist ihre
eigene Fixture). Zwillinge: Java `services/api …/uems/QuelleEinstellungRegeln` ⟷ TS
`frontend/portal/src/uemsEinstellung.ts`; die SQL-Seite der Migration `V20260911280000`
(`uems_einstellung_wert_gueltig`, `uems_einstellungen_aus_verbindung`) fährt dieselben Fälle.

## 1. Die Quelle

Eine Fassung hängt an der **Quelle**: einem **Einbau** (`geraet`, eine Zeile je eingebautem Gerät —
ein Zählerwechsel bringt einen neuen Einbau und mit ihm eigene Fassungen), optional an einer
**Komponente**, die er speist, und optional an einem **Kanal** dieser Komponente (Slug des
Selbstbaus, Kanal der Lesung, Messwert des Katalogs). Ein Kanal gehört immer zu einer Komponente.

- Einbau allein: gilt für alles, was er misst — MS-01 und MS-02 an GR-2 teilen die Fassung (A4).
- Einbau + Komponente: gilt für alles, was er für diese Komponente misst — die Energiekarte EK-2
  (K-8.2) am Controller C-1 (A5).
- Einbau + Komponente + Kanal: gilt für diesen einen Messwert (Skalierung eines Selbstbau-Kanals).

Je **Quelle und Art** gilt zu jedem Zeitpunkt **höchstens eine** Fassung, halboffen `[ab, bis)` auf
die volle Minute (`bis` null = bis auf Weiteres).

## 2. Arten und Werte

Geschlossenes Vokabular (AP-04 §4.4), `wert` je Art mit genau diesen Feldern; jede Zahl ist eine
JSON-Zahl mit Betrag ≤ 1.000.000.000 (ein Text „600" wird nie gelesen):

| Art | Kundenwort | Wert | Text |
|---|---|---|---|
| `wandler_strom` | Wandlerverhältnis Strom | `{primaer_a > 0, sekundaer_a > 0}` | „1.000/5 A" |
| `wandler_spannung` | Spannungswandler | `{primaer_v > 0, sekundaer_v > 0}` | „20.000/100 V" |
| `skalierung` | Skalierung | `{faktor ≠ 0}` oder `{automatisch: true}` | „×10", „automatisch" |
| `offset` | Offset | `{wert, einheit}` (Einheit ≤ 32 Zeichen, leer erlaubt) | „-2 °C" |
| `vorzeichen_umgekehrt` | Vorzeichen umgekehrt | `{umgekehrt: bool}` | „ja" / „nein" |
| `impulswertigkeit` | Impulswertigkeit | `{impulse_je_kwh > 0}` | „1.000 Impulse je kWh" |
| `zaehlerkonstante` | Zählerkonstante | `{je_kwh > 0}` | „375 je kWh" |

Zahlen im Text: Tausenderpunkt, Dezimalkomma, keine überflüssige Null. „Gleicher Wert" vergleicht
Zahlen nach ihrem Wert (600 = 600.0).

## 3. Anwendung, Herkunft, Zustellung, Status

- **Anwendung** (E5): `angewendet` — VoltPilot wendet sie beim Erfassen an; `dokumentiert` — im
  Gerät eingestellt, VoltPilot rechnet nichts um.
- **Herkunft**: `bestand` (Fassung 1, aus der heutigen Verbindung abgeleitet, §6), `verbindung`
  (mit einer Änderung der Verbindung geschrieben — der Hebel), `eintrag` (über die Schnittstelle).
  `bestand` und `verbindung` sind immer angewendet und hängen an einer Komponente.
- **Zustellung** (abgeleitet, nie gespeichert): `verbindung` — die Box wendet die Fassung heute mit
  der Verbindung der Komponente an; `ausstehend` — angewendet eingetragen, die Zustellung an die
  Box (AP-06) steht aus; `null` — dokumentiert. Kundensatz: „angewendet — mit der Verbindung
  zugestellt" · „angewendet — Zustellung ausstehend" · „im Gerät eingestellt — dokumentiert".
- **Status** (zu `jetzt`): `geplant` (beginnt später — „angekündigt"), `gueltig`, `beendet` (ab `bis`).

## 4. Eine neue Fassung

Eine neue Fassung ab `t` **beendet die zu `t` gültige** derselben Quelle und Art genau bei `t` und
gilt bis zum Beginn der nächsten späteren (höchstens bis zum Ende der Quelle). Sie überschreibt nie,
sie legt sich dazwischen; eine gespeicherte Fassung wird nur verkürzt, nie verlängert (Trigger).

Prüfreihenfolge und Codes:

| # | Code | Status | wann |
|---|---|---|---|
| 1 | `wert_ungueltig` | 400 | der Wert hat nicht die Form der Art (§2) |
| 2 | `zeitpunkt_ungueltig` | 400 | `gueltig_ab` oder `tatsaechlich_ab` nicht auf der vollen Minute — nie gerundet |
| 3 | `vor_beginn` | 422 | vor dem Beginn der Quelle (Einbau bzw. Speisung der Komponente) |
| 4 | `nach_ende` | 422 | am oder nach ihrem Ende (ausgebaut, Speisung beendet) |
| 5 | `tatsaechlich_ungueltig` | 422 | `tatsaechlich_ab` nicht vor `gueltig_ab` oder vor dem Beginn |
| 6 | `beginn_belegt` | 409 | an `t` beginnt schon eine Fassung dieser Quelle und Art |
| 7 | `unveraendert` | 400 | gleicher Wert UND gleiche Anwendung wie die zu `t` gültige |

`rueckwirkend` heißt: `t` liegt vor der Minute von `jetzt` (sichtbar markiert, AP-02 E2).

## 5. Folgen-Sätze

Die Folgen-Karte (AP-04 §5.7, A5) als Kundensätze — sie nennen nie eine Neuberechnung, es gibt keine:

1. „Werte vor dem {ab} bleiben unverändert."
2. Mit `tatsaechlich_ab`: „Der Zeitraum vom {von} bis {ab} ist mit {vorheriger Wert} erfasst.
   Berichtigen Sie ihn über eine Korrektur, sobald Korrekturen verfügbar sind." (ohne Vorgänger:
   „… ist ohne diese Einstellung erfasst."). Sonst: „Wenn der Wandler schon früher getauscht
   wurde, …" (Wandler) bzw. „Wenn die Einstellung schon früher geändert wurde, ist der Zeitraum
   dazwischen falsch erfasst — berichtigen Sie ihn über eine Korrektur, …".
3. Dokumentiert: „VoltPilot rechnet nichts um — das Gerät wendet die Einstellung selbst an." ·
   angewendet eingetragen: „Die Zustellung an die VoltPilot-Box steht noch aus; bis dahin erfasst
   sie wie bisher. Bereits erfasste Werte berechnet VoltPilot nie neu." · über die Verbindung: „Die
   VoltPilot-Box wendet die Einstellung mit der Verbindung der Komponente an. …"

Zeitpunkte in Europe/Berlin: „15.01.2027, 09:00 Uhr", um Mitternacht nur der Tag „01.02.2027".
Die Sätze der Konzept-Vorlage tragen „(AP-08)" als Verweis für den Leser — im Kundensatz steht er
nicht.

## 6. Fassung 1 aus der Verbindung, und der Hebel

Die Fassung 1 jeder Komponente mit laufender Speisung kommt aus ihrer **heutigen Verbindung**
(Familie `verbindung`) — „gilt seit Beginn" der Speisung, Herkunft `bestand`, von VoltPilot:

- Selbstbau (`modbus_baukasten`): je Kanal Skalierung (`scale` ≠ 0) und Offset (`offset`, mit der
  Einheit des Kanals) am Kanal (Slug).
- sonst: `power_scale` 0/1/10 (Zahl oder Text) → Skalierung automatisch/×1/×10 an der Komponente;
  `invert_grid_sign` / `invert_batt_sign` (nur echte Wahrheitswerte) → Vorzeichen umgekehrt am
  Kanal `power_kw` bzw. `battery_power_kw` der Lesung — zwei Fassungen derselben Art brauchen zwei
  Quellen.
- `signed` (Datentyp s16/s32) ist die Lesart eines Registers, kein umgekehrtes Vorzeichen — daraus
  wird nie eine Fassung. Wandler, Impulswertigkeit und Zählerkonstante stehen heute nirgends; sie
  entstehen nur als Eintrag.

Die Ableitung ist wiederholbar und nur schreibend: je (Quelle, Art) nur, wo es noch keine Fassung
gibt. **Der Hebel „Auf ×10 stellen" (W5)** ruft den PUT der Komponente; ändert der eine Einstellung
der Verbindung (Familie `aenderung`), sichert derselbe Weg zuerst die Fassung 1 aus der bisherigen
Verbindung und schreibt dann eine Fassung „angewendet, gültig ab jetzt" (Herkunft `verbindung`) — in
derselben Transaktion; zweimal in derselben Minute beginnt die zweite eine Minute später. Das
Setzen des Werts und die Testpflicht bleiben, wie sie waren.

## 7. Protokoll

An der Quelle ist die Fassung selbst das Protokoll (wer · wann · gilt ab · rückwirkend ·
Begründung, Urheber über `uems/ProtokollAkteur`). An **jeder Messstelle**, deren Quellenbindung
(führend oder Vergleich, `messstelle_quelle`) zum Beginn der Fassung aus dieser Quelle liest, steht
ein Eintrag `einstellung_geaendert` in `messstelle_aenderung` (`alt`/`neu` = die Einstellung
vorher/nachher mit Gerät, Einbau, Art, Wert und Text).

## 8. Nicht dieser Vertrag

Keine Zustellung an die Box (AP-06: die heutigen Felder bleiben die Wahrheit der Box), keine
Korrektur oder Neuberechnung (AP-08), kein Zählerwechsel mit „Einstellungen übernommen" (IP-17),
keine Geräteseite (IP-12), keine Protokoll-Routen (IP-21). `v2/measurement-config` und jede
heutige Konfiguration bleiben unverändert.
