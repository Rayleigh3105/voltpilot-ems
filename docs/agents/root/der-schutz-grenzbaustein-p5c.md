# Der SCHUTZ-/GRENZBAUSTEIN (P5c): die Batterie sagt, was sie zulässt — und der Wächter hält sich daran

Angelegt am 09.09.2026. Konzept `data/vp-deye-diybms-luecke-l5/report.md` §3.2b („OPTIONAL —
Schutz-/Grenzbaustein") und §3.3, Bauplan-Paket **P5c**, Captain-Entscheid **E8 (a)**. Er
setzt auf P5 (Anschluss), P5b (Ladestand) und P6 (Speiser-Bindung) auf und ist die
VERALLGEMEINERUNG dessen, was der Kunde heute in seinem eigenen Node-RED fährt
(Evidence-Beleg F24, `evidence/ha-nodered-soc-flow-note.md`).

## Was er rechnet

Zwei Hälften, beide OPTIONAL und beide unabhängig voneinander:

| Hälfte | Eingang | Ergebnis |
|---|---|---|
| **SoC→Strom-TREPPE** je Richtung | der Ladestand (gemessen oder aus P5b gerechnet) | `charge_limit_a` / `discharge_limit_a`, geklemmt auf das GERÄTE-Maximum |
| **Zellspannungs-RIEGEL** (Hysterese) | `cell_max_mv` (Laden) / `cell_min_mv` (Entladen) | `charge_allowed` / `discharge_allowed`; bei Sperre 0 A |

**Die Treppe interpoliert NICHT:** „der letzte Stützpunkt mit Schwelle ≤ SoC gewinnt", die
Stufe gilt bis zur nächsten Schwelle. UNTERHALB der ersten Schwelle wird auf den ERSTEN Punkt
GEKLEMMT statt extrapoliert — dieselbe Regel wie bei `socFromVoltage` (P5b), und in der
Ladekurve zugleich die physikalisch richtige: eine fast leere Batterie darf mit dem größten
Strom laden.

**Der Riegel ist ein RIEGEL, kein Vergleich.** Laden sperrt, sobald die HÖCHSTE Zelle
`charge_stop_v` erreicht, und öffnet erst wieder bei `charge_resume_v`; Entladen
spiegelbildlich an der NIEDRIGSTEN Zelle. Zwischen den Schwellen gilt der VORIGE Zustand —
ohne einen gilt „nicht gesperrt", denn ein Riegel wird nur durch das ÜBERSCHREITEN der
Stopp-Schwelle zugeschoben. Ohne Hysterese schaltete ein Pack an seiner Stopp-Spannung im
Sekundentakt.

Die Werte sind **generisch und vollständig konfigurierbar**; die mitgelieferte VORLAGE
(`protectionprofiles/catalog.json`, `diybms-176s-deye-hp3`) ist byte-verbatim der Kundenflow:
Laden 5 %/270 A … 85 %/22 A, Entladen 5 %/74 A, ab 15 % 342 A, Maxima 40 A („Deye HP3 max
50 A"), Riegel 4,06/4,00 V bzw. 3,40/3,50 V.

## ⚠ Er SCHREIBT auf kein Gerät

Der Kundenflow schreibt die Deye-Stromgrenzen (`0x006C`/`0x006D`) über Home Assistant. **Das
tut VoltPilot hier ausdrücklich NICHT.** Die Grenzen werden BEREITGESTELLT — als Messkanäle
für die Anzeige und als **Kappe für den Wächter** auf der Box. Ein echter Schreibpfad entsteht
erst hinter dem Zertifizierungs-Gate (`ControlCertificationService`, `vp-deye-bench-cert` /
`hybrid-control-p2`); bis dahin bleibt der Kundenflow der aktive Schreiber, und die
Kommando-Transparenz kennt ihn als fremden Einfluss (§3.3).

## Die Wächter-Kappe (`guards.Clamp`)

`guards.Limits.Bms` ist ein **Zeiger** — `nil` heißt „der Pack hat nichts gesagt", und dann
ändert sich nichts. Ein Nullwert, der „0 kW erlaubt" hieße, hätte jede Anlage stillgelegt, die
nie einen Schutzbaustein hatte. Die Kappe wird — wie das Nennband — **ZWEIMAL** angelegt: vor
der §14a-Rechnung, damit die mit einem erreichbaren Wert rechnet, und danach, damit deren
Korrektur die Kappe nie sprengt. Sie RESTRINGIERT nur; sie hebt nie einen Sollwert an. Neue
Stufe im Vokabular: `guard:bms_limit`.

**Ampere → Kilowatt** (`guards.BmsKw`) braucht die GEMESSENE Packspannung. Ohne sie gibt es
KEINE Strom-Kappe — eine geratene Nennspannung wäre eine erfundene Leistungsgrenze. Die EINE
Ausnahme: 0 A sind bei jeder Spannung 0 kW, und genau so meldet der Baustein eine Sperre.

Beide Klemm-Pfade der Box tragen sie: der v2-Arbiter (`Deps.BmsEnvelope`) und der v1
`applySetpoint` — letzteres MUSS sein, denn auf einer v1-gesteuerten Anlage (der
Schattenphase, in der der DIYBMS-Kunde lebt) ist das der Pfad, der wirklich schreibt.

## Woher der Wächter die Grenzen bekommt

Die Grenzen entstehen auf der BATTERIE, der Sollwert geht an den SPEICHER-Knoten — auf einer
Hybrid-Anlage zwei Entitäten. Die **Speiser-Bindung (P6)** ist das Band: sie schreibt für
genau diese Kanäle eine Rollen-Zuordnung `storage`, und der Registry-Push trägt sie zur Box.
`agent.bmsEnvelope` sucht deshalb erst bei der kommandierten Entität selbst (der eigenständige
Fall) und dann beim gebundenen Speiser. Alles aus EINER Entität — eine Ladegrenze des einen
BMS neben der Entladegrenze eines anderen wäre eine Hülle, die keiner von beiden hat.

**Frische:** `bmsEnvelopeWindow` = 5 min. Eine Grenze, die niemand mehr wiederholt, gilt nicht
mehr — sie entfällt dann, sie wird NICHT zu 0. Der Knoten wiederholt eine unveränderte Grenze
deshalb alle 2 min (`REPEAT_AFTER_MS`), damit ihr Alter ehrlich klein bleibt.

## Die Ehrlichkeitsregeln

1. Was der Baustein nicht sagen KANN, sagt er nicht: ohne Ladestand keine Treppe, ohne
   Zellspannung keine Freigabe, ohne beides gar nichts. Ein abwesender Kanal heißt „nicht
   gesagt", nie „0" und nie „erlaubt".
2. Ein Hartstopp braucht KEINEN Ladestand — die Zellspannung allein beweist ihn. Deshalb ist
   der Schutz ein EIGENER Baustein und kein Schalter in `vp.soc.derive`.
3. Eine gesperrte Richtung meldet BEIDES: `allowed = 0` UND `limit_a = 0`.
4. **Ein Kanal hat genau EINEN Autor.** Wer `charge_limit_a` schon aus seinem BMS ZUORDNET,
   bekommt ihn nicht zusätzlich gerechnet — die Cloud lehnt die Überschneidung benannt ab.
5. **Ein FEHLENDER `protection`-Block heißt „unverändert", nicht „weg"** — die Ausnahme von
   der P6-Regel, und sie hat einen Grund: das ist eine SCHUTZgrenze, und ein Formular, das den
   Block noch nicht kennt, darf sie nicht stillschweigend entfernen. Entfernt wird nur mit
   `protection.remove = true`.

## Wo es lebt

| Stück | Ort |
|---|---|
| Geteilte Vektoren (DREI Leser) | `docs/contracts/v2/limit-protection-vectors.json` |
| Reine Rechnung (Box) | `edge-app/nodered/vp-palette/lib/limit-protection.js` |
| Der Knoten, Palette **0.13.0** | `nodes/vp-limit-guard.js`, Katalogtyp `vp.bms.limit` |
| Wächter-Kappe | `edge-app/core/internal/guards/guards.go` (`BmsEnvelope`, `BmsKw`, `StageBmsLimit`) |
| Auflösung auf der Box | `edge-app/core/internal/agent/entities.go` (`bmsEnvelope`) |
| Cloud-Regeln | `UserDefinedBatteryDefinition.checkProtection` (+ `checkDirection` / `checkHysteresis`) |
| Vorlage | `services/api/src/main/resources/protectionprofiles/catalog.json` |
| Compiler | `UserDefinedBatteryFlowCompiler.appendLimitNode` — der Knoten hängt am ENDE der Kette |

## Tests (alle ohne Docker)

`vp-palette/test/limit_guard_spec.js` (fährt die Vektoren durch die echte Rechnung),
`guards/bmslimit_test.go` (fährt den Block `waechter` durch die echte Kappe),
`agent/bms_envelope_test.go` (die Strecke Batterie → Bindung → Wächter),
`ProtectionProfileTest` (die ausgelieferte Vorlage ist Stufe für Stufe der Beleg),
`UserDefinedBatteryProtectionTest` (die Regeln + der generierte Flow),
`UserDefinedBatteryProtectionPersistenceTest` (Vorlage, Erhalt, Entfernung),
`flowc/compile.test.js` (die Kette und der gepinnte Hash).

## Was NICHT hier ist

Die Portal-Fläche zum Eintragen der Treppen (der Assistent kennt den Block noch nicht — er
reist heute nur über die API, und ein Speichern ohne ihn behält ihn), P4 (BMS-Block über den
Deye), P8 (Stammdaten) und jedes Scharfschalten eines Schreibpfads.
