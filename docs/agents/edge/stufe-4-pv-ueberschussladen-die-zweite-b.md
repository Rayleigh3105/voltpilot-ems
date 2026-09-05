# Stufe 4: PV-ÜBERSCHUSSLADEN — die zweite Bahn desselben Verteilers

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 72).


Der ZWEITE Eingang des EINEN Verteil-Mechanismus (Konzept §8 Stufe 4 / PR 13,
Mockups §2a/§2b): das Ladepark-Lastmanagement liefert die OBERGRENZE
(physisch, `budget.go`), das PV-Überschussladen die QUELLEN-Politik
(wirtschaftlich, `internal/lastmgmt/surplus.go`). **Die niedrigere Grenze
gewinnt, und keine von beiden kann die andere aufweichen.**

- **⚠ DIE VORGABE IST `schnell` = GAR KEINE QUELLEN-BAHN**, und das ist die
  Kompatibilitätszusage der ganzen Stufe: eine Anlage, deren Kunde die Karte
  nie geöffnet hat, verteilt byte-gleich wie in Stufe 1-3.
  `NormalizePolicy("")` und `NormalizePolicy("<unbekannt>")` liefern beide den
  NEUTRALEN Wert — eine Wahl, die wir nicht lesen können, darf weder eine
  RESTRIKTION erfinden (das strandete eine Flotte wegen eines kaputten Bytes)
  noch ein VERSPRECHEN. Der Schreibpfad (`Settings.Apply`) lehnt ein unbekanntes
  Wort dagegen BENANNT ab: dort tippt ein Betreiber, und ein stiller Rückfall
  ließe ihn glauben, er hätte etwas eingestellt.
- **⚠ Der Überschuss ist das `rest` des Budget-Trackers, keine zweite
  Messung.** `budget.go` paart Netz- und Ladeleistung längst; ist
  `rest = Netz − Laden` negativ, würde die Anlage einspeisen, und genau das ist
  der Überschuss: `max(0, −rest)`. PV, Gebäude und Speicher sind automatisch
  verrechnet, weil sie in dieser EINEN Zahl stecken. Dasselbe nachlaufende
  Fenster dient beiden Zwecken: ein MAXIMUM des Rests ist ein MINIMUM des
  Überschusses — konservativ in beide Richtungen mit einem Mechanismus.
- **⚠ Blind fällt in ENTGEGENGESETZTE Richtungen, je Politik**, weil die
  Versprechen entgegengesetzt sind: ohne frische Messung PAUSIERT „Nur
  Sonnenstrom" (wir können keinen Überschuss belegen), während „Sonne zuerst"
  gar nicht deckelt (sein Versprechen ist „zuerst", nicht „nur"). Beide sagen
  es in ihrem eigenen deutschen Satz. Nichts davon rührt die physische Bahn an.
- **Die Speicher-Arbitrierung ist EINE Subtraktion EINER gemessenen Größe:**
  `S = max(0, batt − rest)` ist der GANZE Überschuss, unabhängig von der
  aktuellen Aufteilung; `speicher_vor_auto` (Vorgabe = der gemessene Status
  quo) gibt den Fahrzeugen `max(0, −rest)`, `auto_vor_speicher` gibt ihnen `S`.
- **⚠ „Auto vor Speicher" ist nur eine REGEL, weil der Speicher geklemmt wird**
  (`BudgetTracker.StorageChargeCap` → `Agent.OcppBatteryChargeCap` →
  `applySetpoint`). Ohne die zweite Hälfte beanspruchten Speicher und Autos
  dieselben Kilowatt und die Anlage kaufte die Differenz — genau das, was „Nur
  Sonnenstrom" verspricht nie zu tun. Die Klemme ist **restrict-only und
  lade-only** (hebt nichts an, rührt keine Entladung an, dreht keine Richtung
  um), also halten Nennband, SoC-Fenster, EEG-Solar-Klemme und §14a erst recht;
  sie läuft NACH `guards.SurplusCharger` (mit cars-first gehört dieser
  Überschuss nicht dem Speicher) und ist ohne Kundenwahl, ohne ladendes
  Fahrzeug oder ohne frische/vollständige Messung INAKTIV — eine blinde Klemme
  wäre eine Vermutung über den Speicher eines Kunden. Sie wird auf der
  Steuerungs-Karte BENANNT (`control.js deriveCarsFirst`): eine unbenannte
  Begrenzung liest sich wie ein Defekt.
- **„Jetzt voll laden" übersteuert die ÖKONOMIE, nie die PHYSIK.**
  `Session.BoostUntil` nimmt eine Sitzung von der Quellen-Bahn aus; Budget,
  Sicherheitsabstand, §14a und das Ausfall-Profil binden sie unverändert. Sie
  ändert den Vorrang-RANG NICHT — weil sie aber gar nicht um denselben Topf
  konkurriert, wird sie innerhalb ihres Ranges zuerst bedient (das „wirkt wie
  temporärer Vorrang mit Quelle-egal" der Mockups). Sie gilt GENAU EINER
  Transaktion (eine neue Sitzung am selben Stecker ist ein anderes Fahrzeug und
  erbt sie nie), höchstens `lastmgmt.BoostMaxDuration` (4 h), und sie wird
  **bewusst NICHT persistiert**: eine Box, die nach einem Neustart Stunden
  später still weiter Netzstrom kauft, gäbe ein Versprechen, das niemand
  gemacht hat.
- **Ein pausierendes Fahrzeug nennt den HEBEL:** `ReasonNoSurplus` ist ein
  eigenes Wort neben `ReasonBudget` (die Anschlussgrenze WÜRDE es bedienen —
  es ist die eigene Priorität des Kunden), und `lastmgmt.TextFor` hängt die
  gewählte Priorität an den Satz.
- **Die Fläche zeigt BEIDE Wahrheiten** (`ocpp.js sourceCapLine`): „110 kW aus
  Sonnenüberschuss · physisch möglich 197 kW" — ohne beide läse die Drosselung
  an einem freien Anschluss wie ein Defekt.
- Beweise: `internal/lastmgmt/surplus_test.go` (12) + `source_test.go` (11) ·
  `internal/agent/ocpp_surplus_test.go` (7, AN DEN SÄULEN gemessen) ·
  `internal/web/jstest/ui.test.js` + `web_test.go` (Seiten-Struktur, Route).
- **⚠ `static/*` ist `//go:embed`-t — nach jeder Änderung den Core neu bauen.**

