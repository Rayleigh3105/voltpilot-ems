# Der SoC-Ableitungs-Baustein, Ebene 2 (P5b): `vp.soc.derive` + `soc_source_code`

Angelegt am 09.09.2026 (P5b Ebene 2). Konzept: `data/vp-deye-diybms-luecke-l5/report.md`
§3.2b „Zwei-Ebenen-Architektur", Bauplan-Paket P5b. Vertrags-Entscheid:
`docs/contracts/v2/README.md` D-23. Ebene 1 (der Anschluss selbst):
`der-generische-batterie-anschluss-p5-ebe.md`.

## Warum es das gibt

Ebene 1 (P5) holt die ROHWERTE — Zellspannungen, Pack-Spannung, Strom, Freigaben. Nur: weder
ein Deye im Spannungsmodus noch ein DIYBMS ohne Shunt MISST einen Ladestand. Der Kunde rechnet
ihn heute selbst in seinem Home-Assistant-Node-RED aus den Zellspannungen und trägt ihn per
`input_number.set_value` ein. Weder HA noch dieser Flow sind eine Quelle für VoltPilot — also
baut VoltPilot das Verfahren GENERISCH nach, als umschaltbaren Baustein je Batterie.

## Was Ebene 2 ist

| Stück | Wo |
|---|---|
| Die reine Rechnung (ohne Broker, ohne Uhr) | `edge-app/nodered/vp-palette/lib/soc-derivation.js` |
| Der ausführende Knoten | `edge-app/nodered/vp-palette/nodes/vp-soc-derive.js`, Palette **0.11.0** |
| Katalogtyp `vp.soc.derive` | `services/api/.../flowcatalog/catalog.json` + `frontend/portal/src/flows/catalog.json` (byte-gleich) + `edge-app/nodered/flowc/catalog.js` |
| Die REGELN (rein, ohne Docker) | `services/api/.../components/UserDefinedBatteryDefinition.checkSoc` |
| Die Kurven-Vorlagen | `services/api/src/main/resources/soccurves/catalog.json` + `SocCurveTemplateCatalog` |
| Die GETEILTEN Vektoren (der Beleg) | `docs/contracts/v2/soc-derivation-vectors.json` |
| Vertrags-Beispiel | `docs/contracts/v2/examples/flow-graph.valid.mqtt-battery.json` (zweiter Knoten) |

## Die drei Methoden und ihre Vorrangregel

| Methode | Eingänge | Rechnung | `soc_source_code` |
|---|---|---|---|
| `direct` (bevorzugt) | gemappter `soc_pct` | übernehmen | 1 = `gemessen` |
| `ocv_curve` (der DIYBMS-Fall) | `cell_max_mv`/`cell_min_mv`, oder `voltage_v` + Zellzahl | zwei OCV→SoC-Tabellen, linear interpoliert, geklemmt 0..100, **konservatives Minimum** aus `f(vmax, Ladekurve)` und `f(vmin, Entladekurve)`, Rundung 0,1 | 2 = `berechnet:kennlinie` |
| `coulomb` | `power_kw` oder `current_a` + Spannung, Kapazität, ANKER | `SoC(t) = SoC(t-1) + P·dt/E_nutz·100`, geklemmt, Zustand persistent, optionale Rekalibrierung an den Spannungs-Endpunkten | 3 = `berechnet:ladungszählung` |

**Die Auswahl-Logik ist eine LAUFZEIT-Vorrangregel, keine Formular-Verzweigung:** liegt ein
FRISCHER gemessener Ladestand vor, gewinnt er — eine Messung schlägt jede Rechnung. Nur
`prefer_direct: false` schaltet das ab (Vergleichs-/Einfahrbetrieb).

## Die Regeln, die tragen

- **Das konservative MINIMUM ist die ganze Methode.** Die höchste Zelle sagt, wie voll der Pack
  HÖCHSTENS ist, die niedrigste, wie leer er MINDESTENS ist; der Pack kann nur hergeben, was
  seine schwächste Zelle hält. Am Beleg-Tag: vmin 3,393 V → 7,3 %, vmax 3,606 V → 31,5 %,
  Ergebnis **7,3 %** — genau der Ladestand, den der Kunde in HA sieht, und der Grund für seinen
  beobachteten „Boden ~8 %". Wer hier das Maximum nähme, hielte den Speicher für viermal so
  voll.
- **Geklemmt, nie extrapoliert.** Außerhalb der Kurvenenden gilt der Randwert. Eine
  Extrapolation über das Ende einer GEMESSENEN Kurve hinaus wäre eine erfundene Chemie.
- **Eine Kennlinie STEIGT.** Eine, die bei höherer Spannung einen kleineren Ladestand nennt,
  beschreibt keine Lithium-Zelle — sie ist ein Tippfehler mit Ergebnis und wird abgelehnt.
- **Kein `soc_pct` ohne EINGANG.** `direct` braucht ein gemapptes `soc_pct`, `ocv_curve` eine
  Spannung UND Stützpunkte, `coulomb` Leistung, Kapazität und einen Anker (ein gemapptes
  `soc_pct` IST der beste Anker). Fehlt eines, entsteht kein Wert — nie eine Vorgabe.
- **Ein EINGEFRORENER Wert bekommt NIE einen frischen Zeitstempel.** Der Knoten
  veröffentlicht ihn gar nicht erneut; er zeigt ihn samt Alter im Status, und die Telemetrie
  lässt ihn von selbst altern (jedes Frischefenster stromabwärts sieht das richtige Alter).
  Nach `hold_s` (Vorgabe 900 s) ist er ABWESEND — und eine Ladungszählung braucht dann einen
  neuen Anker: was ein Speicher in einer unbeobachteten Stunde getan hat, weiß niemand.
- **Die HERKUNFT reist als KANAL mit, nicht als Stammdatum.** `soc_source_code` steht in
  DERSELBEN Telemetrie-Nachricht wie der Wert, also behält die Historie die damalige Quelle;
  eine später geänderte Definition fälscht keine alte Zeile. Ein CODE und kein Wort, weil die
  Kanäle per Vertrag Zahlen sind (`edge-entity.schema.json $defs/channels`,
  `telemetry_v2.value` ist `DOUBLE PRECISION`) — so reist er durch die BEWIESENE Kette
  unverändert, ohne Umbau von Ingest, Writer oder Migration. **Es gibt keine 0 für
  „unbekannt":** ein unbekannter Ladestand ist ein ABWESENDER Kanal.
- **`soc_source_code` ist der einzige Kanal, den niemand ZUORDNEN darf.** Kein BMS
  veröffentlicht ihn; ihn zuzuordnen hieße, eine Rechnung als Messung auszugeben.
- **⚠ „Übernehmen" heißt ÜBERNEHMEN — verbatim, ohne Runden und ohne Klemmen.** Bei `direct`
  trägt DERSELBE Kanal in derselben Sekunde schon die ROHE Messung aus der Ebene 1. Würde die
  Ableitung sie auch nur um 0,03 Prozentpunkte verändern, stünden zwei verschiedene Zahlen für
  denselben Ladestand in derselben Sekunde in der Historie — und welche gewinnt, hinge an der
  Zustellreihenfolge. So ist die zweite Nachricht eine byte-gleiche Wiederholung, die nur die
  HERKUNFT ergänzt. (Nur der Anker der Ladungszählung wird geklemmt: ein Startpunkt außerhalb
  von 0..100 wäre keiner.) Gerundet und geklemmt wird ausschließlich, was die Ableitung
  SELBST gerechnet hat.
- **Die Fähigkeiten wachsen mit der Ableitung.** Rechnet eine Kennlinie den Ladestand aus,
  dann LIEFERT diese Batterie `soc_pct` — auch wenn ihn niemand sendet. `capabilities()` nimmt
  ihn (und `soc_source_code`) deshalb auf; ohne das fiele der generierte Flow bei der
  Aktivierung durch (`FlowGraphValidator.checkSocDerivations`, V-6).
- **Der Ableiter hängt an einer KANTE, nie am Takt** (`triggerable: false`). Der Auslöser
  trifft NUR die Quelle; der Ableiter rechnet auf dem, was sie gerade gesendet hat. Hinge er
  selbst am Takt, rechnete er auf dem Stand des VORIGEN Taktes — und die Reihenfolge zweier
  gleichzeitig gefeuerter Knoten ist nichts, worauf man einen Ladestand baut.
- **Er ist transportfrei und deshalb wiederverwendbar:** er liest KANÄLE, nicht MQTT. Der
  HTTP-Lesetyp bekommt ihn ohne eine Zeile Änderung.

## Die Kurven-VORLAGE — und warum es nur eine gibt

`soccurves/catalog.json` liefert **„DIYBMS 176s NMC (Kundenkurven, 25 °C)"**: die beiden
Tabellen VERBATIM aus dem Kundenflow vom 09.09.2026. `SocCurveTemplateTest` prüft sie Punkt für
Punkt gegen `docs/contracts/v2/soc-derivation-vectors.json`, und der Katalog schickt jede
Vorlage beim Start durch DIESELBE Prüfung wie eine eingetippte Kurve — eine Vorlage, die die
Regel ihrer eigenen Fläche nicht besteht, wäre eine Falle mit Gütesiegel.

**⚠ Eine „LiFePO4 generisch"-Vorlage gibt es bewusst NICHT.** Eine Kennlinie ist eine MESSUNG an
einer Zellchemie; VoltPilot hätte sie erfinden müssen, und eine erfundene Kennlinie ist kein
Angebot, sondern ein falscher Ladestand mit Nachkommastellen. Der Pack des Kunden ist NMC/NCA
(3,26–4,18 V/Zelle) — dieselbe Spannung bedeutet an LiFePO4 etwas völlig anderes. Deshalb nennt
jede Vorlage ihre `chemistry` und ihr Zellfenster sichtbar mit.

## ⚠ Was P5b NICHT tut: der Optimierer sieht diesen Ladestand noch nicht

Der abgeleitete `soc_pct` landet in `telemetry_v2` (je Entität, je Kanal). Der Optimierer liest
seinen Anfangs-Ladestand aber aus der v1-Breittabelle `telemetry.soc_pct`
(`services/optimization/.../inputs.py _fresh_measurement`). **Die Brücke ist die
Speiser-Bindung (P6)**, die diese Batterie ausdrücklich zur SoC-Quelle des Speicher-Knotens
macht. Bis dahin bleibt `schedule.soc_source = 'berechnet'` ungeschrieben — die Spalte nimmt
den Wert seit P7 (`V20260910000000`) auf, aber ihn vorher zu schreiben hieße, einen Planungsweg
zu behaupten, den es nicht gibt.

## Was bewusst NICHT in diesem Paket ist

| Später | Was fehlt |
|---|---|
| **P5c** | der Schutz-/Strombegrenzungs-Baustein (SoC→Strom-Treppe, Zellspannungs-Hysterese-Hartstopp → `guards.Clamp`). |
| **P5d** | die Portal-Fläche: Kurven-EDITOR, Rohwert-Vorschau und die Anzeige von `soc_source` auf Cockpit, Geräteseite und Fahrplan. Der Vertrag steht (`soc_derivation` + `soc_source_code` + Vorlagen-Katalog), die Fläche fehlt — deshalb ist `vp.soc.derive` `customer_visible: false` und generated-only. |
| **P6** | die Speiser-Bindung (siehe oben) — erst sie macht den abgeleiteten Ladestand zum Planungseingang. |
| **P5-HTTP** | der HTTP/JSON-Lesetyp. Der Ableiter braucht dafür KEINE Änderung. |

## Tests (alle ohne Docker)

```bash
(cd services/api && ./mvnw test -Dtest='UserDefinedBatteryDefinitionTest,UserDefinedBatteryFlowCompilerTest,SocCurveTemplateTest,UserDefinedBatteryCatalogTypeTest,FlowGraphValidatorTest')
(cd edge-app/nodered/vp-palette && npx mocha test/soc_derive_spec.js --timeout 15000 --exit)
(cd edge-app/nodered/flowc && node --test compile.test.js)
(cd frontend/portal && npx vitest run src/flows/)
```

Der Beleg-Fall ist in beiden Welten ausführbar: `soc_derive_spec.js` fährt JEDEN Vektor aus
`soc-derivation-vectors.json` durch die echte Rechnung (vmin 3,393 / vmax 3,606 → **7,3 %**),
`SocCurveTemplateTest` beweist, dass die ausgelieferte Vorlage nicht davon abgedriftet ist.
