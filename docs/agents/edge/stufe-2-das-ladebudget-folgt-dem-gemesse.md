# Stufe 2: das Ladebudget FOLGT dem gemessenen Netzanschluss (`lastmgmt/budget.go`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 70).


Der Import-ZWILLING von `guards/exportlimit.go`, mit derselben Arbeitsteilung
und derselben umgekehrten Fail-Safe-Regel. Konzept §4.2 Nr. 2. Alles ist
additiv: eine Anlage, die ihren Netzanschluss nie misst, rechnet weiter
byte-gleich mit den gepflegten Zahlen (`TestWithoutAMeasurementTheBudgetIsByteForByteStufe1`).

    rest   = gemessener Netzbezug − gemessene Ladeleistung
    budget = planbar − rest

- **⚠ Die gemessene LADELEISTUNG muss zurückaddiert werden, sonst schwingt die
  Schleife.** Die Säulen stecken schon im gemessenen Netzbezug: `planbar − netz`
  würde das Budget genau um die Leistung kürzen, die es gerade vergeben hat,
  die Autos kappen, den Netzbezug fallen sehen, wieder vergeben — eine Dauer-
  Schwingung im Takt der Schleife. Es ist derselbe Grund, aus dem der
  Einspeise-Wächter `pv_gesamt` wieder addiert.
- **⚠ Eine UNVOLLSTÄNDIGE Messung ist keine Messung.** Meldet ein Stecker, dem
  wir Leistung zugeteilt haben, keinen frischen Messwert
  (`csms.Snapshot.ChargingTotal`), wird die Probe VERWORFEN und die Stufen-
  Kette übernimmt — genau der Fall, aus dem sonst die Schwingung würde. Eine
  getrennte Säule macht sie NICHT unvollständig: deren Zug steckt im Netzbezug
  und zählt damit als Gebäudelast (konservativ und stabil).
- **⚠ EIN MESSWERT AUS DER VORIGEN REGIME-PHASE IST AUCH KEINE MESSUNG**
  (`csms.Connector.MeterInTransit`, CI-Ausfall der Rig-Fälle L15b, 01.09.2026).
  Beide Hälften des Gesetzes müssen DENSELBEN Moment beschreiben: der
  Netz-Zähler folgt einer geänderten Ladeleistung in SEINER Kadenz, die
  `MeterValues` der Säule kommen in IHRER (10 s ist ein normaler Wert). Für ein
  Melde-Intervall nach JEDER Änderung ist `grid(neu) − charging(alt)` deshalb um
  genau den befohlenen Schritt falsch — und weil das Glättungsfenster das
  MAXIMUM nimmt, regiert dieser EINE Messwert danach eine ganze
  `BudgetSmoothWindow` lang Budget UND Überschuss. **Jede ERHÖHUNG knickte die
  Quellen-Bahn also für eine Minute ein, die nächste Entscheidung nahm sie
  zurück, und die Anlage pendelte sich in einer Treppe weit unter ihrem
  wirklichen Überschuss ein** (am Rig gemessen: 14 kW von 22, dauerhaft; im
  reinen Modell 22 → 0 → 22 → 0). Ein solcher Messwert wird deshalb wie ein
  FEHLENDER behandelt — das PAAR wird verworfen, nie halb geglaubt.
  - **Die Marke ist `Connector.CommandedChangedAt`, NICHT `CommandedAt`:** der
    Executor schreibt eine unveränderte Grenze in JEDEM Takt neu (der
    Schreibvorgang IST der Totmann-Aufzug), also bewegt sich `CommandedAt`
    ständig, während sich am Regime nichts ändert. Ein Stempel bei jedem
    Schreibvorgang markierte jeden Stecker für immer „in transit" und hungerte
    das Budget aus. Die Schwelle ist der 0,05-kW-Totband von `CompareReadback`.
  - **⚠ Die Regel kann NIE LÄNGER halten als die Frische-Regel ohnehin:** ist
    `MeteredAt` älter als `CommandedChangedAt` und die Änderung selbst älter als
    `maxAge`, dann ist `MeteredAt` erst recht älter als `maxAge`. Sie verengt
    also WELCHE Messwerte zählen, nie für wie lange.
  - **Sie gilt an BEIDEN Stellen, die die Ladeleistung paaren** —
    `csms.Snapshot.ChargingTotal` und die eigene Schleife von
    `agent.carsBeforeStorageKw` (P6): dieselbe Frage darf nicht zwei Antworten
    haben.
  - **⚠ Folge für TESTS: ein Prüfstand muss FORTLAUFEND messen.** Eine
    Attrappe, die ihre `MeterValues` EINMAL veröffentlicht und dann auf
    „complete" wartet, wartet auf einen Bericht, den niemand sendet, sobald der
    Executor im Hintergrund eine Grenze ändert. `publishAndSettle` (und damit
    `measureSite`/`measureSurplus`) veröffentlicht deshalb INNERHALB der
    Warteschleife — genauso, wie eine echte Säule sich verhält.
- **⚠ Die Fail-Safe-Regel ist die UMKEHRUNG jedes ökonomischen Guards:** frisch
  → Schleife · kurze Lücke → das letzte Budget HALTEN · längere Lücke → auf das
  SICHERE Budget zusammenziehen · nie gemessen → das hinterlegte (Stufe-1-)
  Budget. Eine Kontraktion HEBT nie an. Das sichere Budget rechnet mit
  `max(HouseReserveKw, MaxHouseLoadKw)` und liegt damit nie über dem statischen.
- **⚠ Die Trägheit steckt an GENAU EINER Stelle und ist asymmetrisch:** die
  Standortlast wird als MAXIMUM über ein nachlaufendes Fenster
  (`BudgetSmoothWindow`, 60 s) genommen. Ein Lastsprung verkleinert das Budget
  im nächsten Messwert, ein Lastabfall vergrößert es erst, wenn das Fenster
  durch ist. Ein Mechanismus, beide Aufgaben.
- **⚠ Über die Anschlussgrenze hinaus wird NIE geplant**, auch nicht, während
  die Anlage einspeist und die Arithmetik es hergäbe: der PV-Überschuss ist
  hinter einer Wolke in Sekunden weg, und kein Sekunden-Regelkreis (und kein
  rampendes Fahrzeug) folgt dem. Der Überschuss senkt weiterhin den Bezug, er
  hebt nur nicht das Budget.
- **§14a ist most-restrictive-wins und gilt in JEDEM Modus** (es ist Gesetz,
  keine Optimierung) — aber nur eine WIRKLICH gemeldete Hülle zählt: `0` heißt
  null Kilowatt, nur ein ABWESENDER Kanal heißt unbekannt (die dokumentierte
  `guards.Reading`-Falle). Eine einmal beobachtete Hülle wird gehalten, nicht
  gealtert — genau wie beim Batterie-Guard. Sie bindet die LEBENDE Zuteilung,
  NIE die zwei permanenten Profile (ein Dimm-Ereignis ist vorübergehend und darf
  keine Sicherheits-Vorgabe überleben, die es an der Säule tut).
- **⚠ Die Reserve für unerreichbare Säulen entfällt im gemessenen Modus** — ihr
  Zug steckt schon in der Messung, sie ein zweites Mal abzuziehen wäre eine
  Über-Vorsicht, die keine Fläche erklären kann. Jede blinde Stufe bekommt sie
  zurück.
- **Der Schalter heißt `static_budget` und ist NEGATIV formuliert**, damit sein
  Nullwert die gewollte Vorgabe ist („nimm die Messung, wenn es eine gibt") —
  ohne Zeiger, ohne `WithDefaults`-Eintrag, also kann ein ausdrückliches „aus"
  des Betreibers nie überschrieben werden.
- **⚠ Die Fläche RECHNET dieselbe Ableitung, sie liest kein zwischengespeichertes
  Ergebnis** (`agent.ocppBudget`, geteilt von `ocppStep` und `ocppInfo`). Ein
  gespeichertes Urteil war beim ersten Wurf drin und zeigte nach jedem Speichern
  der Einstellungen bis zu einen Takt lang die alte Zahl — im Rig als „Budget ist
  0 kW" aufgefallen. `Budget()` ist für einen Zeitpunkt idempotent, ein Rendern
  wertet also genau das aus, was der nächste Takt täte.
- Gefüttert wird der Tracker am EINEN Telemetrie-Chokepoint
  (`agent.ocppObserve` aus `onLocalTelemetry`, derselbe gefilterte Komposit-Wert
  `power_kw`, den jeder andere Guard liest) — und beide Hälften des Regelgesetzes
  werden DORT gepaart, nicht erst zur Entscheidungszeit: die Netzmessung enthält
  den Zug der Säulen von genau diesem Moment. Ein Messwert, der ein deutlich
  kleineres Budget verlangt, weckt den Executor sofort (`rt.wake`); die Schwelle
  ist die halbe Ingenieurs-Marge, denn genau die absorbiert einen ungeplanten
  Bezug zwischen zwei Entscheidungen.
- Beweise: `internal/lastmgmt/budget_test.go` (18 reine Fälle) ·
  `internal/csms/chargingtotal_test.go` (7) ·
  `internal/agent/ocpp_dynamic_test.go` (7 — an den SÄULEN gemessen: die
  gepflegte Reserve wird durch die Messung ersetzt und das dritte Fahrzeug lädt;
  das Vergeben des Budgets schrumpft es nicht; ein Stecker ohne Messwert fällt
  zurück statt zu schwingen; die Reserve wird nicht doppelt abgezogen; §14a
  erreicht die Säule; der Lastsprung weckt sofort).

