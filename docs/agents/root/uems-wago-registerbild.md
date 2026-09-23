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
- [`wago-simulator-vectors.json`](../../contracts/v2/wago-simulator-vectors.json) — sechs Fälle
  S1–S6: Normallast (4 Karten, big, FC3), Rücksetzung (Überlauf 65 535 → 0 ist KEIN Neustart, ein
  Programmstart schon), Herzschlag steht (little, FC4, Basisadresse 4096), Version fremd, Karte
  fehlt, Bereichsbegrenzung (S6 kam mit IP-8: der UNGÜLTIG-Wert tritt ein, bleibt, geht und tritt
  wieder ein). Je Fall `lesungen[]` mit `schritte` (Store-Mutationen), `erwartet` und
  `ereignisse` (was IP-8 aus dieser Lesung meldet, ohne die Kennungen des Aufrufers).
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

## Kopf-Prüfung und Probe-Op `wago_kopf` (AP-05 IP-7, 18.09.2026)

Was aus der Prüfung von IP-6 **folgt** — die Prüfung selbst steht dort und wird hier nicht
wiederholt. Weiter **RUHEND**: `RUNTIME_VERSION` bleibt 2026.08.26.3, `wago.pm494`/`wago.pm495`
bleiben in `NOCH_NICHT_AN_DER_BOX`, kein Edge-Release.

- `edge-app/nodered/measurements/wago-kopf.js` — die Stufe über dem Treiber. `pruefeLesung()`
  reicht das Ergebnis von `liesRegisterbild` durch und hängt drei Dinge an: `befund`,
  `herzschlag_urteil`/`steht` und `qualitaet`.
- **Finding `registerbild_unbekannt`:** genau die zwei Gründe `signatur_fremd` und
  `hauptversion_fremd` — die beiden, die VOR jeder Längenprüfung stehen. Jeder andere Grund bleibt
  ein Grund: dort steht ein v1-Registerbild, es passt nur nicht zum Hardwareblatt oder zu den
  Parametern, und das ist eine Aussage über die Anlage, nicht über das Programm der Steuerung.
- **Qualität `stale` nach drei stehenden Lesungen in Folge**, gezählt **je Steuerung** in
  `HerzschlagWacht` — der Herzschlag steht im Kopf, also gilt er für alle Karten zugleich.
  `ueberlauf` und `rueckwaerts` setzen den Zähler zurück wie `laeuft` (Fall S2).
- **Probe-Op `wago_kopf`** (additiv in `docs/contracts/mqtt-probe.schema.json`): liest NUR die
  zwölf Kopfwörter. Core `internal/probe` (Zulassung, Urteil), `agent/probe.go`
  (`wagoKopfResult`), Palette `nodes/vp-modbus-probe.js` (Ausführung über `lib/modbus-conn`).
  Fixtures `mqtt-probe.valid.wago-kopf{,-result}.json`, `mqtt-probe.invalid.wago-kopf-without-address.json`.
- `edge-app/nodered/measurements/wago-kopf.test.js` (11) und
  `edge-app/nodered/vp-palette/test/wago_kopf_spec.js` (8, über den echten Modbus-Weg der Bühne:
  S4 Version fremd, S3 Herzschlag steht).

### Fallen

- ⚠ **`registerbild_unbekannt` ist KEINE Fehlerklasse.** §7 des Quellenvertrags
  ([`data-source-assignment.md`](../../contracts/v2/data-source-assignment.md#7-fehlerklassen-je-quelle-e5--a-geschlossenes-vokabular))
  ist ein geschlossenes Vokabular, das Box, Ingest, Writer, api und Portal gemeinsam tragen — ein
  neues Wort dort ist eine Migration und mehrere Vertragsleser. Auf dem Findings-Weg der
  Mess-Runtime (`reportSource` → `data-source-status.js` → `edge/data-sources/poll`) fährt der
  Befund deshalb als **`layout_changed`** („Aufbau geändert — nichts wurde umgehängt"). Das feine
  Wort steht im Probe-Ergebnis, wo der Assistent es braucht.
- ⚠ **Der Kopf-Bericht der Probe teilt sich den Leser NICHT mit `liesRegisterbild`.** Der Treiber
  verlangt, dass das GANZE Registerbild vorliegt (`laenge_ungueltig`, sonst könnten Kartenhälften
  aus zwei Lesesätzen stammen); die Probe liest absichtlich nur zwölf Wörter. `kopfBericht()` fährt
  darum dieselbe Reihenfolge aus §5 mit den Konstanten des Treibers, aber ohne diese eine Prüfung.
- ⚠ **Lücke statt Null im Kopf-Bericht:** bei `signatur_fremd` steht NUR `signatur_ok: false` da,
  bei `hauptversion_fremd` zusätzlich die Version selbst — Kartenzahl, Herzschlag und
  Controller-Kennung wären in einem v2-Registerbild geraten (Vektor V4).
- ⚠ **Das Typenschild 0xFA10–0xFA17 ist nur Anzeige und nie ein Identitätsbeweis** (Hersteller-Beleg
  H2: es ist NICHT belegt, ob die Register ohne Laufzeitsystem antworten). Antwortet es nicht, fehlt
  das Feld und kein einziges Urteil ändert sich — der Spec prüft genau das gegen einen Server, der
  die Adresse mit Ausnahme 0x02 abweist.
- ⚠ **Mischbetrieb ist in beide Richtungen geprüft:** eine ältere Box kennt den Op-Typ nicht und
  antwortet `not_supported` (`ValidateOp`-Vorgabe); eine heutige Cloud verwirft ein Finding-Wort
  außerhalb ihres Vokabulars (`ProbeResultListener.finding`) und ignoriert den Block damit still.
  Auf dem lokalen Bus trägt eine gewöhnliche Lesung weiterhin KEIN `op`-Feld.

## Ereignisse und Qualität aus Statuswort und Zählerverlauf (AP-05 IP-8, 18.09.2026)

Die dritte Stufe: `liesRegisterbild` (IP-6) → `pruefeLesung` (IP-7) → `lesung()` → `edge/events`.
Weiter **RUHEND**: `RUNTIME_VERSION` bleibt 2026.08.26.3, `wago.pm494`/`wago.pm495` bleiben in
`NOCH_NICHT_AN_DER_BOX`, kein Edge-Release, keine Migration, keine Cloud-Änderung.

- `edge-app/nodered/measurements/wago-ereignisse.js` — `WagoEreignisse.lesung()` gibt
  `{ ereignisse, qualitaet }`: fertige Bus-Nachrichten für `edge/events` und die Sicht je Wert.
- **Die drei Arten, jede einmal je Zustandswechsel.** Vertrag §3 nennt die zwei Schlüsse aus dem
  Herzschlag, §5 die Ereignisse daraus: `frozen_source` („Werte eingefroren") wenn der Herzschlag
  steht, `device_restart` wenn er zurückspringt (`ueberlauf` ist **kein** Neustart, Fall S2).
  `range_limit` fällt beim UNGÜLTIG-Wert des Datentyps, je
  (Karte, Gruppe), mit dem rohen Statuswort 1 der Gruppe als unausgelegter Beigabe.
- **Qualität je Wert** trägt nur zusammen, was gebaut ist: `stale` aus IP-7, `invalid` beim
  UNGÜLTIG-Wert, `null` bei einem Feld ohne belegten Datentyp. **Kein zweiter Lieferweg** — dass
  ein UNGÜLTIG-Wert gar kein Sample erzeugt, tut schon IP-6 (PR 942).
- Bühne: `S6 bereichsbegrenzung` in `wago-simulator-vectors.json` (der UNGÜLTIG-Wert tritt ein,
  bleibt, geht, tritt wieder ein) und das neue `ereignisse`-Feld je Lesung an **allen** Fällen.
- `edge-app/nodered/measurements/wago-ereignisse.test.js` (26, über den echten Modbus-Weg der
  Bühne, plus die Fälle des Referenzdatensatzes).

### Fallen

- ⚠ **Das geschlossene Vokabular wird NICHT geweitet.** `device_restart`, `frozen_source` und
  `range_limit` sind seit AP-07 IP-3/IP-19 Box-Arten; der Einliefer-Weg `device-events.js` ist der
  Briefkasten, diese Stufe der Absender. Die §8-Zelle des Konzepts nennt noch „additive
  `event_kind`-Werte" und eine Migration — **sie ist älter als der Ereignis-Vertrag**. Ein Test
  hält fest, dass jede Nachricht unverändert durch `device-events.ereignis()` passt.
- ⚠ **Die Bitlage der Bereichsbegrenzung ist NICHT belegt** (Vertrag §4.2 „Zu erheben",
  `wago-registerbild-vectors.json` → `statuswoerter.bitlage_bereichsbegrenzung.art`, Befunde 1
  und 4). Kein Bit wird gedeutet: die vier Bitzahlen sind ein Parameter
  (`bereichsbegrenzungBits`), ohne ihn lautet die Antwort **`null` = unbekannt**, nie „nein". Ein
  Test bricht, sobald der Vektor nicht mehr „zu erheben" sagt — dann gehört die Lage in den Leser.
- ⚠ **`frozen_source` ist der stehende Herzschlag, nicht ein stillstehender Messwert.** Das
  Vokabular nennt die Art „Werte eingefroren", Vertrag §3 setzt genau das mit dem stehenden
  Herzschlag gleich, und der Referenzdatensatz-Fall `anwendung-gestoppt-herzschlag-steht` erwartet
  `frozen_source` bei `heartbeat: [1731, 1731, 1731]`. Ein Zähler ohne Last steht still, ohne
  eingefroren zu sein — eine Regel „alle Werte bit-gleich" würde auf S1 (Normallast) auslösen.
- ⚠ **Ein Poll-Takt Unterschied in der Schwelle (Befund, IP-7 gehörig).** Vertrag §3, die Bühne
  (`S3.stillstand_ab_lesung: 3`) und der Referenzdatensatz lesen „über drei aufeinanderfolgende
  Lesungen" als **drei gleiche Lesungen**; `HerzschlagWacht` zählt stehende **Übergänge**
  (`STEHT_AB = 3`) und urteilt `stale` erst bei der **vierten**. IP-8 legt bewusst keine eigene
  Zahl daneben, sondern fährt auf `qualitaet === 'stale'` — wo die Schwelle liegt, entscheidet
  IP-7. Der Test `BEFUND: …` hält den heutigen Stand fest.
- ⚠ **Mischbetrieb:** keine Laufzeit ruft diese Stufe, `flows.json` bettet sie nicht ein — eine Box
  ohne WAGO-Quelle sendet keines dieser Ereignisse. Wer sie verdrahtet, braucht ein Edge-Release
  und einen neuen Mischbetriebs-Nachweis.

## Aktivierung an der Box (AP-05 IP-6b, 23.09.2026)

Nicht mehr RUHEND auf Katalog-Ebene: Inhalts- und Laufzeitstand **2026.09.23.3**, die Palette führt
die 54 Kartenpunkte, `NOCH_NICHT_AN_DER_BOX` ist leer — **wirksam erst mit dem Box-Release**, das
diese Palette trägt. Einzelheiten und Mitgezogenes: [`uems-wago-katalog.md`](uems-wago-katalog.md).

- ⚠ **Aktiviert heißt noch nicht gelesen.** Die drei Stufen dieser Datei laufen weiter nur in Tests:
  `registerbilder` kommen weder aus der api noch aus der Laufzeit beim Planer an, `readModbus`
  (`vp-measurements.js`) fährt für `wago_registerbild` FC 3 ohne Wortfolge, und `pruefeLesung`/
  `lesung()` ruft keine Laufzeit. Ein 495-Punkt wird darum als `driver_unavailable` abgelehnt, nie an
  Adresse 0 gelesen. Die Verdrahtung ist ein eigenes Paket und braucht dasselbe Box-Release.
- Nachweis: `wago-registerbild.test.js` „die Box-Sicht des Katalogs führt die WAGO-Karten“ und „eine
  Konfiguration ohne Registerbild-Parameter liest keine Karte, der Rest läuft weiter“.
