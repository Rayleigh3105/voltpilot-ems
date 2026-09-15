# UEMS-WAGO: Vertrag „VoltPilot-Registerbild WAGO v1“ (AP-05 IP-2)

Neu am 15.09.2026, zweites Bau-Paket von AP-05 (Konzept `vp-uems-ap05-wago/report.md` §4.1, §4.5, §4.6,
§8 IP-2; Entscheide E1, E2, E4, E9). Nur Vertrag, Schema, Vektor-Datei und ein Test — kein Treiber, kein
Baustein, kein Portal. Es gibt keine Hardware: **nichts im Vertrag ist am Gerät belegt.**

- [`docs/contracts/v2/wago-registerbild.md`](../../contracts/v2/wago-registerbild.md) — Kopf 12 Wörter
  (Signatur 0x5650 0x5242, Haupt-/Nebenversion, Kopflänge, Kartenblocklänge, Kartenzahl, Herzschlag,
  Wortfolge-Prüfwert 0x01020304, Controller-Kennung), Karten-Block 42 Wörter (Steckplatz, Kartentyp,
  Variante, Gültigkeit, Kartenregister 32/35 roh, 3 × 4 Statuswörter, 12 Messwerte à 2 Wörter);
  Basisadresse, Funktionscode, Wortfolge und Soll-Aufbau sind Parameter.
- [`wago-registerbild-vectors.json`](../../contracts/v2/wago-registerbild-vectors.json) +
  [`wago-registerbild.schema.json`](../../contracts/v2/wago-registerbild.schema.json) — jede Zahl als Angabe
  mit `art` festlegung · handbuch (Seite + `gilt_fuer`) · repo (Datei:Zeile) · zu erheben; 13 Lese-Fälle
  V1–V13, alle `herkunft: vertrag`, `belegt: false`.
- `frontend/portal/src/wagoRegisterbild.test.ts` — Schema, lückenloser Aufbau, Handbuch deckt Artikel,
  Vertrag ⟷ Datei ⟷ Hardwareblatt-Vorlage (Messwert-IDs, Datentypen), Rechenbeispiele, unabhängiger Leser
  über alle Fälle.

## Fallen

- ⚠ **Handbuch-Angaben gelten für die 750-495, nicht für die 750-494** (Ahrenberg C-1). Belegt für die 494
  ist nur der Prozessabbild-Aufbau (Handbuch 750-494 S. 39). `gilt_fuer` einer Angabe darf nur Artikel
  nennen, die das zitierte Handbuch abdeckt — der Test hält `ABDECKUNG` fest. Den Energie-Faktor (0,01
  oder 0,05 kWh) NIE als Vertragswert für die 494 eintragen.
- ⚠ **Die Vektor-Datei wurde per Skript kodiert, der Test liest unabhängig.** Wer einen Fall von Hand
  ändert, rechnet die Wörter nach (big/little, Int32-Vorzeichen, INVALID je Datentyp) — der Test sagt es
  sonst.
- ⚠ **Vertrag-Tabellen sind maschinenlesbar:** Kopf-/Karten-Zeilen `| Offset | Wörter | \`feld\` |`,
  Messwert-Zeilen `| Nr. | Offset | 2 | \`feld\` | … | Gruppe | ID | Datentyp |`, Rechenbeispiele
  `| \`0x… 0x…\` | big | UInt32 | Wert |` und `| Rohwert | Faktor | Ergebnis |`. Tabellenform ändern =
  Test mitändern. Die Hardwareblatt-Vorlage §4 wird ebenso gelesen.
- ⚠ **Ein Karten-Block wird nie auf zwei Anfragen geteilt:** 4 Karten = 180 Wörter = 2 Anfragen (E9-Beispiel
  im Konzept sagte 1). Budget: `measurement-planner.js:6` (30/min) und `:97` (120 Wörter).
- ⚠ **Ohne belegten Datentyp kein Wert:** Messwert 2 (Lieferung gesamt) liefert `null`, bis Pilotschritt 1
  den Typ erhebt. Gültigkeitsbit 0 → alte Wörter im Block sind kein Wert.
- **Vorbehalt vor dem Pilot (§6):** bis zum ersten eingebauten Baustein oder ausgelieferten Leser darf
  Fassung 1.0 selbst berichtigt werden (Vertrag + Datei + Test zusammen), danach nur additiv.
- Nachfolger: IP-3 (Baustein schreibt), IP-4 (Katalog-Faktoren), IP-6/IP-7 (Leser = Zwillinge dieser
  Datei), IP-12 (Simulator-Fälle `herkunft: simulator`), IP-14 (belegte Pilot-Fälle mit `nachweis`).
