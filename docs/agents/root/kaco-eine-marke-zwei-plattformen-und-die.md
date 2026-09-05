# KACO: EINE Marke, ZWEI Plattformen - und die brand-neutrale SunSpec-Kennung

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 153).


Die KACO-Palette in Deye-Dichte (70 Modelle; Scout `data/vp-kaco-palette-y6`,
Betreiber-Doku `edge-app/nodered/KACO.md`, Prüfstand `CONTROL-BENCH.md` → KACO).

- **⚠ Zwei Geräte-Plattformen unter einem Markennamen**, und die Modelle nennen
  ihren Weg deshalb SELBST (`Model.Transports`): die **KACO-eigene** Linie
  (blueplanet TL1/TL3, Powador TL3 Ethernet-Generation, NX3 M8/M10, gridsave)
  spricht echtes SunSpec Modbus TCP; die **AISWEI/Solplanet-OEM**-Linie
  (NX1/NX3 M2/M3/M5, hybrid NH3) hängt an einer Kommunikationseinheit.
- **⚠ `CommSunSpecTCP = "sunspec_tcp"` ist die BRAND-NEUTRALE Kennung desselben
  Lesepfads, den Fronius unter `fronius_sunspec` fährt.** Beide Werte bleiben
  für immer nebeneinander: `fronius_sunspec` ist PERSISTIERT (die zwei Fronius
  Eco der Anlage Herzogau tragen es in Selection, Quellen-Config und
  Vorlagen-Schlüssel), `sunspec_tcp` trägt jede spätere SunSpec-Marke - sonst
  stünde in der Vorlagen-Verwaltung „Fronius SunSpec" über einem KACO. Wer den
  Pfad anfasst, fragt `inverter.IsSunSpecTCP` (Go) bzw. `routing.isSunSpecTcp`
  (JS) - **nie den String zweimal vergleichen**.
- **⚠ Der VORGABE-Weg der AISWEI-Plattform ist die App-Schnittstelle
  (HTTP-JSON 8484), und das ist ein GERÄTE-Fakt, keine Vorliebe:** der Stick
  kennt „Datenupload/SmartCloud" ODER „Modbus TCP IP Server", nie beides - der
  SunSpec-Ausweg nimmt dem Kunden seine KACO-App. Die 8484-Schnittstelle läuft
  parallel dazu. Der Preis des Auswegs steht in der Notiz JEDES betroffenen
  Modells (ein Test prüft das).
- **⚠ Beim hybriden NH3 kommt die PV von der DC-Seite** (`Σ vpv × ipv` bzw.
  Register 31601), weil seine AC-Leistung `PV + Entladung − Ladung` ist - die
  Regel, die `sunspec-live.js` für Fronius-Hybride aufgeschrieben hat. Ohne
  lesbare DC-Werte wird GAR KEINE PV veröffentlicht, nie die AC-Leistung.
  Dafür gibt es zwei HTTP-Profile (`kaco_http` / `kaco_http_hybrid`).
- **`Model.FamilyPerTransport` (additiv) löst genau diesen Fall:** derselbe Weg,
  anderes Profil je PRODUKT. Auflösung `FamilyPerTransport[Weg] > Family >
  Transport.Family`, zentral in `familyFor` (Normalize + Vorlagen-Export teilen
  sie). Ein gesetztes `Model.Family` hätte den Experten-Ausweg still
  wirkungslos gemacht - die Warnung, die schon an `froniusModels` steht.
- **⚠ Die einphasigen blueplanet TL1 melden SunSpec-Modell 102 (Split-Phase),
  nicht 101** - KACOs eigene Wahl; evcc scheiterte genau daran. Unser Walker
  decodiert 102 wie 101/103. **`phases: 'split'` beschreibt das MODELL, nie das
  Gerät** - ein TL1 ist ein Einphaser.
- **Die Steuerung ist VORBEREITET und GESPERRT, und die Sperre ist HÄRTER als
  die Freigabeliste:** die KACO-Adapter geben `writes: []` heraus **unabhängig
  von `certified`** - ein First-Light-Grant, der bei Fronius/Deye den Schreibweg
  öffnet, reicht hier nicht. Sie fällt erst durch eine bewusste Code-Änderung.
  Geplant sind SunSpec Model 123 (offiziell dokumentiert: 40295/40299) und der
  NH3-Batterieweg (AISWEI 41104/41152/41153/41154/41155, evcc-belegt).
- **⚠ Der NH3 hat KEIN Totmann-Register.** Ein gesetzter Sollwert bliebe stehen;
  der Failsafe muss unserer sein (re-assertieren, bei Stille 41104 auf 2
  zurück). Dass die Rücknahme am Gerät wirkt, ist Prüfstand-PFLICHT.
- **gridsave liest ohne Ladestand** (der SoC steht im Vendor-Modell 64203, das
  das EMS selbst beschreibt); der EMS-Steuerpfad ist ein eigener Bau.
- **Nichts davon ist an einem KACO gemessen.** Die Annahmen (beide Vorzeichen,
  die Wort-Reihenfolge, die Modicon-Adressumrechnung `3xxxx`→FC4 −30001 /
  `4xxxx`→FC3 −40001) stehen als solche im Code UND als Termin-Liste in
  `KACO.md` §12.

