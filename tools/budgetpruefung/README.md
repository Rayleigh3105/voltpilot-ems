# Budget-Prüfung der Bestandsboxen vor Edge-Release A

Das Werkzeug prüft den gegenwärtig gespeicherten Mess-Plan jeder aktiven Box mit dem
`MeasurementBudgetContract` und den Kosten der neuen Palette. Es startet keine API, bietet keine
Route an und läuft nie geplant. Der Betreiber startet es genau einmal vor Release A.

Es gilt ausschließlich für das **UEMS-Schema nach dem Rollout**. Gegen das heutige `main`-Schema
läuft es nicht: Erst UEMS enthält unter anderem die zeitgültigen Kadenzfassungen und die
Quellenübergabe, die der echte Publisher beim gegenwärtigen Drahtplan berücksichtigt.

## Aufruf

Die Datenbankrolle muss für diesen Betreiberlauf `BYPASSRLS` besitzen; das Werkzeug setzt
`row_security = off`, aber verschafft sich dieses Recht nicht selbst. Die URL soll `sslmode=require`
oder die strengere betriebliche Vorgabe enthalten. Ein Passwort wird nie ausgegeben.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export VOLTPILOT_BUDGET_DB_URL='jdbc:postgresql://…/voltpilot?sslmode=require'
export VOLTPILOT_BUDGET_DB_USER='…'
export VOLTPILOT_BUDGET_DB_PASSWORD='…'
bash tools/budgetpruefung/run.sh
```

Die gesamte Abfrage läuft in einer erzwungenen `READ ONLY`-Transaktion mit 30 Sekunden
Statement-, 5 Sekunden Lock- und 60 Sekunden Leerlaufzeitlimit. Teil A–C enthalten ausschließlich
Zählungen. Teil D bleibt beim Betreiber und nennt interne Mandanten-, Anlagen- und Boxkennungen,
Ablehnungsgründe sowie einen kleinsten einzelnen Takt-/Abwahl-Ausweg, soweit das Vertragsurteil
ihn ohne Annahme hergibt. Exitcode 2 bedeutet: mindestens eine Box wurde abgelehnt; Exitcode 0:
keine Ablehnung.

Der geprüfte Plan ist nicht aus SQL nachgebaut: Das Werkzeug ruft denselben `forPublishing`-Pfad
wie der MQTT-Publisher auf und teilt mit ihm `MeasurementPlan` (Quellenübergabe, eine Zeile je
`point_key`, schnellste wirksame Kadenz einschließlich zeitgültiger Fassung). Die Kosten und
Grenzen kommen weiterhin allein aus `docs/contracts/v2/measurement-budget-vectors.json`.

## Nachweis

`BestandsboxBudgetPruefungTest` migriert eine Wegwerf-Datenbank, sät eine Box ohne Plan sowie U12
mit 5 s und 10 s und prüft `READ ONLY`, die Ausgabegrenze A–C/D, alle
`free-register-duty-*`-Vektoren und die Grenzen 120/600 Samples, 30 Anfragen und 20 % Buszeit.
