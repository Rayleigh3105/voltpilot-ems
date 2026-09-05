# OCPP-Lastmanagement: die Verteilung ist REIN (`internal/lastmgmt`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 69).


Stufe 1 des Konzepts (`vp-ocpp-lastmgmt-konzept-w4` §4.1/§4.2) plus die zwei
Produkt-Details, die erst die abgenommenen Mockups festgeschrieben haben
(`vp-ocpp-mockups-r5` §2.7/§2.8). Kein I/O, keine eigene Uhr (jede
zeitabhängige Funktion nimmt ihr `now`), kein OCPP-Import — das
`Tagesprotokoll`/`FleetPflege`/`otaapply`-Muster, also ist jede Regel ohne
Websocket, Station oder Container beweisbar.

- **⚠ Die Reihenfolge der Budget-Rechnung ist NICHT vertauschbar:** der
  Sicherheitsabstand kommt von der ANSCHLUSSGRENZE, und erst was danach übrig
  bleibt teilt sich mit dem Gebäude — `277 → nie über 249,3 geplant → 249,3 −
  167 = 82,3 kW Ladebudget` (die Mockup-Arithmetik). Den Abstand vom REST zu
  nehmen ergäbe 99 kW und damit ein drittes ladendes Fahrzeug, das nicht laden
  darf. Der Abstand schützt den ANSCHLUSS, also wird er am Anschluss genommen.
- **Pausieren schlägt Aushungern** (die D4-Regel auf n Fahrzeuge): unter der
  Mindestleistung wird GAR NICHTS zugeteilt — ein Wert zwischen 0 und dem
  Minimum ist kein langsamerer Ladevorgang, sondern gar keiner, das Budget wäre
  also für nichts ausgegeben. Wer wartet, WECHSELT im festen Takt
  (wall-clock-ausgerichtete Epochen ⇒ zustandslos und reproduzierbar), und die
  Zeile trägt ihren geschätzten Termin (`NextTurnAt` — aus derselben Rotation
  abgeleitet, nie erfunden; `0` heißt „der Termin käme nie" und die Fläche sagt
  dann nichts).
- **⚠ Die site-weite Mindestleistung wird auf die Steckdose GEKLEMMT.** 30 kW
  (eine DC-Park-Zahl) darf eine 11-kW-AC-Box nicht unbedienbar machen — 11 kW
  IST ihre volle Leistung. Ein Gerät-eigenes Minimum steht auf der `Session`
  und schlägt die Vorgabe.
- **Vorrang ist ein RANG, kein Freibrief** (Captain-Entscheid): die
  Vorrang-Gruppe wird ZUERST und auf ihre VOLLE Nachfrage bedient, der Rest
  teilt fair (inkl. Rotation) — aber sie wird selbst wassergefüllt und selbst
  vom Budget gedeckelt, kann den Anschluss also so wenig überschreiten wie
  jede andere. Die Folge (die anderen warten länger) ist echt, und die Fläche
  ist verpflichtet, sie zu nennen.
- **⚠ Mindestleistung und Ausfall-Profil sind ZWEI Zahlen** (Mockups §2.8):
  die eine ist Zuteilungs-Politik, die andere Notbetrieb. `DeriveSafeDefault`
  rechnet `(Grenze − höchste Gebäudelast) ÷ Steckerzahl` und liefert die
  TERME mit, damit die Fläche dem Kunden die Rechnung zeigen kann
  (`6 × 15 kW + 180 kW = 270 < 277 ✓`). Wer die beiden gleichsetzt, macht die
  Rechnung auf genau den Anlagen unmöglich, für die es das Produkt gibt
  (`TestMindestleistungAndAusfallProfilAreDifferentNumbers` rechnet das
  Gegenbeispiel vor).
- **⚠ Die Ausfall-Zahl wird ABGERUNDET, nie kaufmännisch.** Aufrunden liess
  `Stecker × Wert` das Freie um Haaresbreite überschreiten (277 kW auf 6
  Stecker → 16,167 → 277,002). Vom Sweep-Test gefunden, nicht beim Lesen der
  Formel; die Invariante wird jetzt an der Erzeugungsstelle geprüft, nicht nur
  im Test. **Ein Sicherheitswert rundet nie auf.**
- **Pacing hält nur ERHÖHUNGEN.** Jede Verringerung (und jedes Pausieren /
  Fortsetzen) geht sofort durch — sie schützt den Anschluss, und ein
  aufgeschobener Schutz ist keiner. Der Halt erneuert sich nicht selbst
  (`ChangedAt` wandert mit), sonst hinge eine kleine Erhöhung für immer fest.
- **Einstellungen** in `lastmgmt.json` (das `despike.json`/`balance.json`-Muster,
  tmp+rename, PATCH-Semantik: ein abwesendes Feld BEHÄLT den Wert). Ohne
  hinterlegte Anschlussgrenze ist das Budget 0 und es lädt nichts — der
  ehrliche Zustand einer Box, die niemand eingerichtet hat.

