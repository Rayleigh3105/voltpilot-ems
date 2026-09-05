# Die ABREGELUNG folgt der Messung, nicht dem 15-Minuten-Planwert

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 81).


Der dritte Fix aus dem Herzogau-Vorfall (Scout `vp-herzogau-einspeisung-statt-laden-h3`
§2 Glied 1b / §8 Fix D). Cloud-Seite: es gibt keine - die Wolke ist unberührt.
Was HIER gelten muss:

- **Der behobene Befund ist ein REGELKREIS, nicht eine falsche Zahl.** Der
  10:30-Lauf plante `pv_limit_kw = 36,869` = 6,5 kW Haus + 30 kW Speicher, also
  „nichts ins Netz" - richtig um 10:30 und falsch für die folgenden zehn
  Minuten, weil das Haus auf 27-29 kW stieg, während die Kappe stillstand: die
  Anlage hing ~20 kW unter ihrem Können. Und die gekappte Ausgangsleistung war
  genau das, was der PV-Nowcast des nächsten Laufs maß - der unterschätzte den
  Überschuss und ließ die Kappe zusammenfallen („die Abregelung frisst ihre
  eigene Messung").
- **`core/internal/guards/curtailtrack.go` ist FEED-FORWARD, nicht ein
  geschlossener Regelkreis:** `Kappe = Haus_gemessen + max(Batterie-Befehl, 0)`.
  Wallboxen und alles Übrige stecken in der Hausmessung; der Batterie-Term ist
  der BEFOHLENE Sollwert nach der ganzen Guard-Kette, nicht seine momentane
  Leistung - die ist selbst eine FOLGE der Kappe (bei 36,9 kW fand der Speicher
  nur ~8 kW Überschuss zum Laden, und genau das fror den Kreis ein).
- **⚠ EIN GESCHLOSSENER REGELKREIS AUF DER NETZMESSUNG KANN DAS NICHT**, und das
  ist der Grund, warum diese Datei neben `exportlimit.go` steht statt in ihr:
  dessen Gesetz `cap = pv + (limit − export)` hat bei `limit = 0` JEDEN Punkt
  mit Export 0 als Fixpunkt - es kann anziehen, aber nie freigeben, und hätte
  die 36,9 kW zehn Minuten lang gehalten. Der Compliance-Wächter hat das Problem
  nicht, weil seine Grenze (30 kW) weit über dem Arbeitspunkt liegt.
- **Autorisierung ist die Abregelung des PLANS** (der laufende Slot trägt
  `pv_limit_kw`). Die PREIS-Entscheidung hat damit die Wolke getroffen; dieser
  Regler führt sie nur gegen die Messung aus statt gegen eine
  viertelstundenalte Prognose. Ohne die Marke ist er INAKTIV und die Anlage
  verhält sich byte-identisch wie vorher.
- **⚠ Er ERSETZT den Planwert in BEIDE Richtungen, und das ist sicher per
  Konstruktion:** er zielt auf NULL Netzaustausch, und das ist mindestens so
  eng wie jede Einspeise- oder §14a-Grenze im System - der Planwert kann also
  nur ein gleich enges oder engeres Export-Ziel gewesen sein. **Der
  Compliance-Wächter bleibt übergeordnet:** der Aufrufer komponiert danach mit
  `guards.ExportLimiter` most-restrictive-wins.
- **⚠ Der Frische-Anker ist die LASTMESSUNG, nicht der Takt.** `Observe` bekommt
  `lastReadingAt`; mit `now` zu stempeln würde eine veraltete Messung bei jedem
  Tick auffrischen und die Ausfall-Kette könnte nie greifen. Ohne Messung wird
  gar nichts beobachtet - eine Null-`Reading` ist kein gemessenes Haus.
- **⚠ Die Ausfall-Kette ist der PLAN, nie eine Freigabe:** frisch → das Gesetz ·
  Lücke ≤ 90 s → letzte Kappe EINFRIEREN · länger / nie gemessen → der Planwert,
  also exakt das Verhalten vor diesem Wächter. **`t.seen` gehört zwingend in die
  Halte-Bedingung** - ohne es meldet ein Tracker, der NIE gemessen hat, Alter 0,
  friert auf der ersten Kappe ein und ein späterer Planwert könnte nie mehr
  wirken (im Testlauf als echter Defekt gefunden).
- **Anziehen ist sofort, Freigeben ratenbegrenzt** (`CurtailReleaseRateKwPerSec`),
  damit der Kreis der WMaxLimPct-Rampe des Wechselrichters nicht hinterherjagt.
- **⚠ Ehrliche Grenze, unverändert:** die EIGENE PV des primären Hybriden ist
  nicht abregelbar (der Deye-Fernsteuerpfad meldet `pvLimitSupported:false` -
  seine Einspeisegrenze wäre das Installateur-EEPROM-Register, das dieser Pfad
  grundsätzlich nicht anfasst). Die Kappe ist ein ANLAGEN-Gesamtwert, den die
  bestehende Aufteilung des Executors um den nicht regelbaren Anteil kürzt -
  „Export 0" ist also nur erreichbar, solange Haus + Speicher ≥ der Deye-eigenen
  Erzeugung; darüber fällt das schreibbare Budget auf 0 und der Rest geht
  sichtbar ins Netz.
- **Sichtbar statt still:** additiver `curtail_track`-Block im
  `curtailment`-Herzschlag (Zustand, deutscher Grund, `cap_kw` UND `plan_cap_kw`)
  und eine Zeile auf der `:8484`-Steuerkarte, die NUR erscheint, wenn der
  befohlene Wert wirklich vom Planwert abweicht. Eine ältere Cloud ignoriert den
  Block (die api liest den Herzschlag als `JsonNode`).
- Regressionsvektoren (Ring 10:30-10:50): 10:30 Haus 6,5 + Speicher 30 → 36,5 ·
  10:44 Haus 29 + Speicher 30 → **59,0** (Plan stand auf 36,869) · Haus fällt
  auf 6,5 → **sofort** 36,5 · Messausfall → halten → Planwert.

