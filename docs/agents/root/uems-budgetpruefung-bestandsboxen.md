# Budget-Prüfung der Bestandsboxen (AP-14 IP-17, X5)

Vor Edge-Release A fährt der Betreiber `tools/budgetpruefung/run.sh` lesend gegen Produktion. Das
Werkzeug gilt nur für das UEMS-Schema nach dem Rollout und startet weder API noch Route noch Takt.
Aufruf und Ausgabegrenze stehen im [Werkzeug-README](../../../tools/budgetpruefung/README.md).

Die Prüfung benutzt keine SQL-Nachbildung: `MeasurementSelectionService.forPublishing` bestimmt
wie beim MQTT-Weg die heute ausführende Box; `MeasurementPlan` ist die gemeinsame reine
Zusammenstellung für Publisher und Prüfung (je `point_key` einmal, schnellste wirksame Kadenz,
zeitgültige Kadenzfassung); `MeasurementBudget` lädt Kosten und Grenzen aus
`measurement-budget-vectors.json`. Dadurch zählen Katalogpunkte, freie Register und die im
Katalog liegenden Verbraucher-/Ladepunkt-Messungen genau so, wie sie im heutigen Drahtplan stehen.

Die ganze Flottenabfrage läuft in einer erzwungenen `READ ONLY`-Transaktion mit `row_security =
off` über eine ausdrücklich dafür vorgesehene `BYPASSRLS`-Rolle. Teil A–C sind nur Zählungen;
interne Mandanten-, Anlagen- und Boxkennungen stehen ausschließlich in Teil D. U12 ist festgenagelt:
ein freies Register zu 5 s ergibt 40 % und wird abgelehnt; 10 s ergibt genau 20,0 % und ist erlaubt.
