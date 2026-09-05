# Stufe 4: die FAHRPLAN-Bahn — der Plan reicht eine OBERGRENZE herunter

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 74).


Die dritte Bahn desselben Verteilers (Captain-Entscheid „Weg A" vom
20.08.2026). Physisch begrenzt der Anschluss (`budget.go`), wirtschaftlich die
Quellen-Wahl (`surplus.go`) — und der FAHRPLAN reicht ein Ziel herunter, das
die Box allein nicht kennen kann. **Alle drei komponieren
most-restrictive-wins, und keine kann eine andere aufweichen.**

- **⚠ STRIKT FAIL-OPEN, und das ist die tragende Zusage:** kein Plan, ein
  VERALTETER Plan, kein Ziel im Plan, kein Lastspitzen-Zähler oder keine
  Messung am Netzanschluss ⇒ die Bahn wird ABGERÄUMT und die lokale Logik gilt
  unverändert. **Ein Fahrzeug darf NIE wegen eines fehlenden Plans stehen
  bleiben; im Zweifel lädt es.** Die Ablauffrist (`PlanLimitFreshWindow`) ist
  die zweite Hälfte davon: ein Deckel, den niemand mehr auffrischt, ist keiner
  — ein steckengebliebener Aufrufer kann keine Anlage drosseln.
- **⚠ Die Frische-Regel weicht BEWUSST von der des Batterie-Wächters ab.**
  `plan.PeakImportLimit` ist dort staleness-UNABHÄNGIG, weil das Verteidigen
  eines alten Ziels dort nichts kostet (es verschiebt nur Batterieleistung).
  Hier könnte dasselbe alte Ziel ein Auto stehen lassen — also gilt es nur,
  solange der Plan frisch ist (`p.Fresh(now)`, dieselbe Staleness wie der
  Plan-Ausführer: „der Plan gilt" heisst auf dieser Box EINE Sache).
- **Getragen wird genau EINE Grösse: das Lastspitzen-ZIEL.** Anschlussgrenze
  und §14a-Hülle hat die Box längst selbst (Einstellung + beobachtete Hülle),
  und die Einspeisegrenze ist eine Export-Schranke und kann das Laden gar
  nicht begrenzen. Das Ziel dagegen kennt nur die Cloud — und ohne diese Bahn
  konnte der Ladepark genau die Spitze sprengen, die die Batterie daneben
  teuer hält (PS-3).
- **Die Umrechnung ist geteilt, nicht nachgebaut:**
  `guards.PeakTracker.AllowedImport` macht aus dem Viertelstunden-MITTEL, was
  der Standort im REST dieser Viertelstunde noch ziehen darf — dieselbe
  Projektion, die der Batterie-Wächter benutzt, also verteidigen beide
  Instrumente EINE Zahl. Der Anteil der Fahrzeuge daran ist
  `max(0, erlaubt − Rest des Standorts)`, wortgleich die Rechnung der
  physischen Bahn.
- **⚠ Der Deckel wirkt NUR im gemessenen Zweig und nur nach unten.** Die
  statischen und blinden Stufen bleiben unberührt (fail-open by construction),
  ein weiterer Deckel hebt nichts an, und eine unlesbare Zahl räumt die Bahn ab
  statt „null Kilowatt" zu bedeuten.
- **Er NENNT sich** (`budget_note` + `ocpp.js planCapLine`), aber nur wenn er
  wirklich bindet: eine Begrenzung ohne Namen liest sich wie ein Defekt (die
  Canary-Soak-Lehre), und eine, die gerade nicht greift, ist keine Auskunft.
- **Bewusst NICHT dabei:** das v2-Plan-Ziel (`peakTargetV2`) — die v2-Planung
  ist ein Schattenlauf ohne eine einzige geflaggte Anlage, und der
  Batterie-Wächter verteidigt es ohnehin. Wer sie scharfschaltet, nimmt sie
  hier mit auf, mit ihrer EIGENEN Frische.
- **⚠ Ein Test über diese Bahn hängt AN DER UHR, wenn man ihn naiv schreibt.**
  Die Projektion ist `(Ziel·900 s − bisher Bezogenes) / Restsekunden`: eine
  RUHIGE Viertelstunde erlaubt kurz vor ihrem Ende völlig zu Recht ein
  Vielfaches des Ziels (der MITTELWERT ist die Grösse, nicht der Augenblick),
  also band der Deckel je nach Tageszeit oder eben nicht — zwei Paket-Timeouts,
  bis es auffiel. Der Ausweg ist physikalisch statt kosmetisch: läuft der
  Standort die bisherige Viertelstunde GENAU auf dem Ziel, kürzt sich der
  Fortschritt heraus und die Projektion ist exakt das Ziel, an jeder Sekunde
  (`feedAtTheTarget`, belegt von
  `TestTheProjectionIsExactlyTheTargetWhenTheSiteRanAtIt` samt Gegenprobe).
  **Wer hier einen Fall ergänzt, füttert den Zähler so — oder prüft etwas, das
  nicht an der Projektion hängt.**
- Beweise: `internal/lastmgmt/planlane_test.go` (7 reine Fälle: verengt,
  hebt nie an, Abräumen, Ablauf, blinde Stufen unberührt, überzogene
  Viertelstunde pausiert statt negativ, kaputte Zahl fällt offen aus) ·
  `internal/agent/ocpp_planlane_test.go` (4 an den SÄULEN: der Deckel kommt am
  Ladeprofil an, ein VERALTETER Plan hält kein Fahrzeug zurück, ein Plan ohne
  Ziel ist byte-gleich, ohne Messung greift er nie) — die zwei tragenden Regeln
  (fail-open bei Staleness, restrict-only) sind mutationsgeprüft, und die
  Uhr-Unabhängigkeit ist ein eigener Fall.

