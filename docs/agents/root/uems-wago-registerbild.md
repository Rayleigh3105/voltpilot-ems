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
  Datei), IP-14 (belegte Pilot-Fälle mit `nachweis`). IP-12 steht (siehe unten).

## Simulator-Vorstufe (AP-05 IP-12, 18.09.2026)

Die **Bühne**, auf der IP-6 (Treiberfamilie), IP-7 (Kopf-Prüfung) und IP-8 (Ereignisse) ihre Tests
fahren — kein Leser, kein Treiber, kein Produktivcode der Box.

- `edge-app/nodered/vp-palette/test/fixtures/wago-registerbild-store.js` — Register-Store (Kopf +
  n Karten) und ein In-Process-Modbus-TCP-Server davor, nach dem Muster von `modbus_spec.js`.
  Exporte für IP-6: `vertragVorhanden`, `ladeAufbau`, `erstelleRegisterbild`,
  `starteRegisterbildServer`, `ladeFaelle`/`ladeFall`, `UNGUELTIG`.
- [`wago-simulator-vectors.json`](../../contracts/v2/wago-simulator-vectors.json) — fünf Fälle
  S1–S5: Normallast (4 Karten, big, FC3), Rücksetzung (Überlauf 65 535 → 0 ist KEIN Neustart, ein
  Programmstart schon), Herzschlag steht (little, FC4, Basisadresse 4096), Version fremd, Karte
  fehlt. Je Fall `lesungen[]` mit `schritte` (Store-Mutationen) und `erwartet`.
- `edge-app/nodered/vp-palette/test/wago_simulator_spec.js` — der Prüfer: baut den Store, liest ihn
  über den echten Modbus-Weg (`lib/modbus-conn`) und dekodiert mit einem kleinen unabhängigen Leser.

### Fallen

- ⚠ **Der Aufbau wird nicht abgeschrieben:** Offsets, Längen, Datentypen, Festlegungswerte und das
  Vokabular der Gründe liest die Fixture aus `wago-registerbild-vectors.json`. Ändert IP-2 den
  Vertrag, wandert der Store mit — dafür gibt es hier keine zweite Kopie der Zahlen.
- ⚠ **Kein Beleg, und der Test hält es fest:** jeder Fall `herkunft: simulator`, `belegt: false`,
  nie ein `nachweis`. Die Fixture **weigert sich**, für Messwert 2 (Datentyp zu erheben) eine
  gedeutete Zahl anzunehmen — dort ist nur `{ "roh": N }` zulässig. Aus einem Rohwert wird nirgends
  eine kWh-Zahl: der Faktor der 750-494 ist nicht belegt.
- ⚠ **Der Leser gehört NICHT in die Fixture.** Läge er dort, prüfte IP-6 seinen Leser gegen einen
  Zwilling seiner selbst. Er steht im Spec und bleibt dort.
- ⚠ **`RUNTIME_VERSION` bleibt unberührt** (Befund 8): IP-12 packt keine Palette neu; das tut IP-6
  zusammen mit einem Edge-Release.
- ⚠ **Testweg:** `npm test` in `edge-app/nodered/vp-palette` (Mocha). Unter `node --test` scheitern
  die Specs mit „describe is not defined"; die CI schließt `vp-palette` aus dem `node --test`-Schritt
  aus (`.forgejo/workflows/edge-images.yaml`).
