# Defizit-Deckung: gekauft wird nichts, worauf die Anlage steht

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 79).


Cloud-Seite, Kontrakt und die Begründung: root `AGENTS.md` „Defizit-Deckung im
Fahrplan-Modus". Was HIER gelten muss:

- **`core/internal/guards/deficitcover.go` ist eine reine Entscheidung je Tick**
  (`CoverDeficit` bleibt zustandslos - die einzige Hysterese, auf die es ankommt,
  ist das symmetrische Engage/Release-Dwell des `LoadFollower` auf dem Defizit).
  Sie läuft am GLEICHEN Ort wie die beiden Wolken-Pflichten: nach jeder
  Compliance-Klemme, nach der Holder-Übersteuerung, VOR dem Peak-Guard.
- **⚠ Die Haltezeit gehört dem Folger, nicht der Regel (Entscheid A, 13.10.2026;
  E2 A vom 10.10. kannte sie nur in der Lade-Viertelstunde).** `CoverDeficit`
  kennt keine Zeit mehr (kein `PlannedKw`, kein `Held`). `LoadFollower.ApplyAuthorized`
  bekommt das Urteil der einen Uhr (`deficitSustained` aus `guards.DeficitHold`,
  60 s = `DeficitCoverHold`) und hebt ohne es KEINE Entladung an - für
  `deficit_cover`, `follow` und `idle_follow` gleich. Bis dahin deckt er höchstens
  den Stand des Takts davor (`levelKw`): eine laufende Deckung überlebt eine
  Messlücke, wächst aber nicht; in der Deck-Viertelstunde wird der Prognose-Planwert
  auf diesen Stand begrenzt, sonst brächte ein kurzer Verbraucher ihn zurück.
  Absenken ist immer sofort. `FollowResult.Held` -> Zustand `deficit_hold`.
  Die Uhr zählt vom ersten TAKT bis zur MESSZEIT des jüngsten Defizit-Messwerts
  (unter dem gedämpften Folger die Paarzeit der Regelmessung) - Takte ohne neue
  Messung zählen nicht. Sie wird in JEDEM Takt gefüttert, auch wenn gerade niemand
  darf (Pause, verlorene Rücklesung, anderer Slot): ein stehendes Defizit wartet an
  der Slot-Grenze nicht erneut. Wer die Uhr an `Eligible` hängt, macht aus jedem
  Rücklese-Aussetzer eine neue Minute Netzbezug. In Tests, die eine Deckung im
  ersten Takt erwarten: `standDeficit(a, now, pv, load)` (das Defizit steht schon).
  Seit der Stufen-Haltezeit (19.10.2026) gibt die Uhr die Höhe zurück, die
  gestanden hat (`Observe` → kW, kleinstes Defizit der Haltezeit): auch ein
  Anstieg wartet (`TestShortConsumersOnTopOfAStandingDeficitWait`), und die
  Dämpfer-Reserve wird am deckbaren Defizit gemessen (`FollowResult.CoverKw`). Der Eigenmodus des Geräts wartet nicht (`agent/native.go`).
- **⚠ DEEPEN-ONLY.** Der Follower kennt seither drei Autorisierungen:
  `coverLoad` (Wolke, beidseitig), `unplannedLoad` (Wolke, nur aus echter Ruhe)
  und `deficitCover` (lokal, aus JEDEM nicht-ladenden Befehl, aber nur
  vertiefend). Eine Entladung zu BEGRENZEN ist ein Preis-Entscheid; er bleibt
  bei `cover_load_from_battery`, sonst schnitte die Box einen Verkauf zurück,
  den niemand als Fehler gemeldet hat.
- **Ein Befehl, ein Boden:** die Entscheidung und der Follower bekommen
  DIESELBE Zahl (`effective_floor` mit dem Peak-Reserve-Rückfall), damit sie
  nicht über den Boden streiten können. Der `PeakShave`-Aufruf im
  Deepen-Zweig liefert weiterhin Nennband, Boden und Nie-anheben.
- **Die Freigabe verlangt dieselben Tore wie jede lokal GESTARTETE Richtung:**
  `VP_CONTROL_ENABLED`, die Zertifizierung der Familie UND ein frisch gehaltenes
  Rücklesen (`idleReadbackHealthy`). Ohne sie BEGINNT nichts.
- **Eine LAUFENDE Deckung übersteht einen Lesefehler** (`runningReadbackHealthy`,
  `selfstarted.go`): erst drei erfolglose Rücklesungen in Folge (abweichend oder
  unbeantwortet) oder 30 s ohne gehaltene Rücklesung nehmen sie auf den Planwert
  zurück; `not_held`, `no_answer` und ein blockiertes Rücklesen sofort. „Läuft"
  heisst: der zuletzt veröffentlichte Sollwert WAR die selbst begonnene Entladung
  - eine Korrektur, die noch 0 kW befiehlt, hat nichts begonnen. Herzogau
  10.10.2026: ein einzelner 65535-Zyklus liess die Deckung dreimal in sieben
  Minuten für 8-22 s auf 0 fallen. Entlade- und Ladeseite (`surplus_store` aus
  der Ruhe) führen getrennte Merker; die OCPP-Freigabe „Sonne + Speicher" bleibt
  beim strengen Tor.
- **⚠ Die enge Vollakku-Entlastung ist ENTFALLEN** (`HighSocRelief` samt
  `high_soc_follow`): ihr Eintritt ab `soc_max − 1` und ihr Fünf-Punkte-Boden
  sind in der allgemeinen Regel enthalten, deren Boden der volle Reserve-Stapel
  ist. **Die LADE-Hälfte `guards.HighSocCharge` (`high_soc_charge`) ist am
  29.08.2026 denselben Weg gegangen** und in `guards.StoreSurplus`
  (`surplus_store`) aufgegangen - siehe „Überschuss-Einlagerung" weiter unten.
  Die native Automatik wird während einer solchen Nachladung weiterhin
  zurückgenommen, weil ihr Beleg nur autonome ENTLADUNG zertifiziert.
- **⚠ Die lokale Regel autorisiert die native Automatik NICHT.**
  `nativeDutyFor` liest weiterhin ausschließlich die zwei Wolken-Pflichten: der
  native Modus ist eine prüfstand-gegatete Gerätefähigkeit, keine Folge einer
  Vertrauensregel.
- Heartbeat/API/Portal nennen die Richtung als **`deficit_cover` /
  „Live-Lastdeckung"**. Regressionsvektoren: 92 % / 1,3 / 2,7 -> −1,4 kW bis zum
  Reserve-Boden (0 Netz), 91 % / 11,4 / 2,9 -> +8,5 kW bis 95 %.

