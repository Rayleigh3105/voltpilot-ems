# Stufe 3: der Herzschlag trägt die Ladepunkte, und die Einrichtung kennt sie

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 71).


Die Box-Hälfte des eigenständigen Modus (Konzept `vp-ocpp-lastmgmt-konzept-w4`
§5, PR 9/10). Beides ist ADDITIV: eine Box ohne eine einzige eingetragene
Ladesäule sendet einen BYTE-GLEICHEN Herzschlag und sieht dieselben vier
Einrichtungs-Schritte wie vorher.

- **Der `chargers`-Block ist das ACHTE Geschwister** (`cloud.ChargersSummary`,
  gebaut von `agent.chargersSummary()` aus GENAU der Sicht, die die
  `:8484`-Karte rendert). Er **wiederholt die Worte der Box**, er formuliert
  nie neu: Budget, Ausfall-Profil, Zuteilungs-Gründe und jeder deutsche Satz
  entstehen EINMAL in `internal/lastmgmt` — zwei Renderings desselben Urteils
  könnten es sonst verschieden sagen, und nur die Box kennt die Zahlen dahinter.
  Gedeckelt (16 Säulen × 8 Stecker), fehlende Messwerte bleiben ABWESEND statt
  0, und `safe_default_holds` reist mit: ein `false` ist eine ANLAGEN-Tatsache,
  die kein Ladeprofil reparieren kann, und „hält" wäre eine bequeme Lüge über
  die Sicherung eines Kunden.
- **⚠ Ein Ladepark hat gar keinen Wechselrichter** (Konzept §5.1): die
  Einrichtungsseite nennt seine Säulen als Geräte und liest die Messwerte aus
  ihnen (`charge_point_connected` im Umschlag, `commissioning.js` Schritte 2/3).
  Die Kopplung hängt an keinem Gerät - die Referenz steht von Anfang an auf
  der Seite. Die Regel „Säule hat sich gemeldet" wohnt EINMAL, als
  `state.Snapshot.HasReportedChargePoint()`, damit Weboberfläche und
  Herzschlag nicht in zwei Antworten auf eine Frage auseinanderlaufen.
- **⚠ Sie keyt auf „hat sich JE gemeldet", nicht auf den lebenden Socket:** ein
  Schritt, der bestanden war, darf nicht wieder zufallen, weil eine Verbindung
  flatterte — und eine BootNotification IST der Verbindungsnachweis einer
  Ladesäule (der „Verbindungstest" des Assistenten ist genau das).
- **Schritt 4 („Messwerte prüfen") liest auf einem Ladepark die SÄULEN**, nicht
  `last_telemetry`: dort misst kein Wechselrichter, das Feld bliebe für immer
  leer, und „noch keine Messwerte" wäre die falscheste aller Aussagen über eine
  Anlage, die gerade Autos lädt. Ohne Ladevorgang sagt es ehrlich „keine
  Ladevorgänge — keine Messwerte" statt einen Fehler zu behaupten.
- Beweise: `agent/ocpp_heartbeat_test.go` (die Reise über den ECHTEN Executor,
  „ohne Ladepunkte KEIN Block", abwesende Messwerte werden weggelassen statt
  genullt, die EINE Säulen-Regel) · `web/web_test.go`
  (`TestChargePointFactWithoutAnInverter`: die Säule meldet sich, OHNE je
  einen Wechselrichter zu behaupten, ein flatternder Socket nimmt das nicht
  zurück) · `web/jstest/ui.test.js` (die Ladepark-Fälle inkl. „ohne
  Ladepunkte ändert sich KEIN Wort").
- **⚠ `static/*` ist `//go:embed`-t — nach jeder Änderung den Core neu bauen.**

