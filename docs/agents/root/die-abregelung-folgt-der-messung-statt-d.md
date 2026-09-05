# Die ABREGELUNG folgt der Messung statt dem 15-Minuten-Planwert (2026-08-29)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 83).


Der dritte Fix aus dem Herzogau-Vorfall (Scout `vp-herzogau-einspeisung-statt-laden-h3`
§2 Glied 1b / §8 Fix D). **Reine Edge-Arbeit — die Wolke, der Kontrakt und der
Optimierer sind unberührt;** eine Anlage ohne geplante Abregelung verhält sich
byte-identisch wie vorher.

- **Der behobene Befund ist ein REGELKREIS.** Der 10:30-Lauf plante
  `pv_limit_kw = 36,869` = 6,5 kW Haus + 30 kW Speicher (also „nichts ins Netz").
  Richtig um 10:30 — und falsch für die zehn Minuten danach, in denen das Haus
  auf 27–29 kW stieg, während die Kappe stillstand und die Anlage ~20 kW unter
  ihrem Können festnagelte. **Und die gekappte Ausgangsleistung war genau das,
  was der PV-Nowcast des nächsten Laufs maß** — der unterschätzte den Überschuss
  und ließ die Kappe zusammenfallen. Kappen → weniger messen → weniger planen →
  Kappe fällt → PV springt → exportieren.
- **Die Regel ist FEED-FORWARD** (`edge-app/core/internal/guards/curtailtrack.go`):
  `Kappe = Haus_gemessen + max(Batterie-Befehl, 0)`. Wallboxen und alles Übrige
  stecken in der Hausmessung; der Batterie-Term ist der BEFOHLENE Sollwert nach
  der ganzen Guard-Kette, nicht seine momentane Leistung — die ist selbst eine
  FOLGE der Kappe.
- **⚠ Ein geschlossener Regelkreis auf der Netzmessung KANN das nicht**, und das
  ist der Grund für eine eigene Datei neben `exportlimit.go`: dessen Gesetz
  `cap = pv + (limit − export)` hat bei `limit = 0` jeden Punkt mit Export 0 als
  Fixpunkt — es kann anziehen, aber nie freigeben.
- **⚠ Er ERSETZT den Planwert in BEIDE Richtungen, sicher per Konstruktion:** er
  zielt auf NULL Netzaustausch, und das ist mindestens so eng wie jede
  Einspeise- oder §14a-Grenze — der Planwert kann also nur ein gleich enges oder
  engeres Export-Ziel gewesen sein. Der Compliance-Wächter
  (`guards.ExportLimiter`, 30 kW) bleibt übergeordnet und komponiert danach
  most-restrictive-wins.
- **⚠ Der Frische-Anker ist die LASTMESSUNG, nicht der Takt** (`lastReadingAt`);
  mit `now` zu stempeln frischte eine veraltete Messung bei jedem Tick auf und
  die Ausfall-Kette könnte nie greifen. Die Kette ist der PLAN, nie eine
  Freigabe: frisch → das Gesetz · Lücke ≤ 90 s → letzte Kappe einfrieren ·
  länger / nie gemessen → der Planwert.
- **⚠ Ehrliche Grenze, unverändert:** die eigene PV des primären Hybriden ist
  nicht abregelbar (`pvLimitSupported:false` — ihr Register ist eine
  Installateur-EEPROM-Einstellung, die dieser Pfad nie anfasst). „Export 0" ist
  damit nur erreichbar, solange Haus + Speicher ≥ der Deye-eigenen Erzeugung.
- **Sichtbar statt still:** additiver `curtail_track`-Block im
  `curtailment`-Herzschlag (Zustand, deutscher Grund, `cap_kw` UND `plan_cap_kw`)
  plus eine `:8484`-Zeile, die NUR bei echter Abweichung erscheint. Eine ältere
  Cloud ignoriert den Block (die api liest den Herzschlag als `JsonNode`), es
  gibt also **keine api- und keine Portal-Änderung**.
- **Beweise:** rein `guards/curtailtrack_test.go` (die Ring-Minuten 10:30–10:50
  in beide Richtungen, „Netz landet auf 0", eine Entladung ist kein Spielraum,
  ohne geplante Abregelung inaktiv, die ganze Ausfall-Kette, „nie gemessen folgt
  jedem neuen Planwert", nur der Anstieg ist ratenbegrenzt) ·
  `agent/curtail_track_test.go` (dieselben Vektoren durch den ECHTEN
  Setpoint-Pfad und den echten Bus, plus „der Einspeisewächter zieht die
  verfolgte Kappe weiter an") · `web/jstest/ui.test.js`.
- **Ops:** keine neue Pflicht-Variable, keine Migration, kein Vertragsfeld. Die
  Edge-Hälfte reist mit dem nächsten Edge-Release.

