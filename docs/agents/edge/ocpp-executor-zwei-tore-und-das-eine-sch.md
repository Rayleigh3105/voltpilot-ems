# OCPP-Executor: ZWEI Tore, und das eine schuetzt ohne das andere (`agent/ocpp.go`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 67).


Die Verdrahtung zwischen der reinen Verteilung (`internal/lastmgmt`) und den
OCPP-Profilen (`internal/csms`). Sie enthaelt keine Verteilungsregel und kein
OCPP-Vokabular — sie ist bewusst duenn.

- **⚠ Die zwei Tore sind verschieden, und der Unterschied ist tragend:**
  `VP_OCPP_ENABLED` startet den SERVER und hinterlegt die zwei SCHUETZENDEN
  Profile (Saeulen-Kappe + sicheres Default) — die REDUZIEREN nur, machen eine
  Anlage also sicherer, nie gesteuerter. Die LEBENDE Zuteilung braucht
  zusaetzlich `VP_CONTROL_ENABLED ∧ VP_CONSUMER_CONTROL_ENABLED` (Konzept
  §7.5). Ohne sie laeuft die Anlage auf `n × Sicherheitsprofil`, was per
  Konstruktion unter der Anschlussgrenze liegt — **sicher, nur nicht
  optimiert — und die Oberflaeche SAGT das** (`ControlNote`; eine Verweigerung,
  die niemand sieht, ist ein Raetsel — die Canary-Soak-Lehre).
- **⚠ WAS WIR NICHT SEHEN, ZIEHT TROTZDEM.** Eine Saeule mit totem Websocket
  laedt nicht nichts: sie haelt ihr eigenes Sicherheitsprofil, und ihre Autos
  nehmen es womoeglich. Das volle Budget an die ERREICHBAREN zu verteilen
  gaebe dieselbe Leistung zweimal aus. Der Anteil der unerreichbaren Stecker
  wird deshalb aus dem Budget RESERVIERT (`ReservedKw` auf der Oberflaeche) —
  der Import-Zwilling der exportlimit-Doktrin „blind heisst nie unbegrenzt".
  Bewusst pessimistisch: ein nicht belegter Stecker an einer toten Saeule
  reserviert Leistung, die er nicht braucht, und das ist die richtige
  Richtung, in der man falsch liegt.
- **⚠ Die Auffrischung ist BEDINGUNGSLOS.** Auch eine unveraenderte Grenze
  wird jeden Takt neu geschrieben, denn es ist der SCHREIBVORGANG, der den
  Totmann neu spannt. Das Verhaeltnis `ocppTickInterval : csms.TxProfileDuration`
  (20 s : 120 s) IST die Zahl der verpassten Takte, die ein ladendes Fahrzeug
  ueberlebt. Die Schonung gegen sinnloses Hin und Her passiert eine Schicht
  hoeher, am WERT (`lastmgmt.Pacing`), nie am Schreibvorgang.
- **Das Sicherheitsprofil ist eine ANLAGEN-Groesse**, also wird bei jeder
  Aenderung der Steckerzahl (eine Saeule kommt dazu) JEDE Saeule neu
  eingerichtet. Der Fingerabdruck enthaelt zusaetzlich die
  Verbindungs-Generation, damit eine neu gestartete Saeule ihre Profile
  wiederbekommt.
- **Eine beendete Sitzung verliert ihre Grenze** (`ClearLimit`): OCPP sagt,
  eine Saeule verwirft ein TxProfile mit seiner Transaktion — eine Firmware,
  die es behaelt, liesse das NAECHSTE Fahrzeug still die Grenze des vorigen
  erben.
- Fehler werden **je Schluessel gedrosselt** protokolliert (5 min): eine seit
  einer Stunde unerreichbare Saeule schreibt sonst 180 identische Zeilen.
- **`internal/ocppsim`** ist der Ladesaeulen-Simulator (das
  `consumersim`-Gegenstueck): eine reine Haelfte loest den OCPP-Profil-Stapel
  und den Ablauf auf und rechnet die simulierte Leistung daraus, eine zweite
  bindet sie an eine echte ocpp-go-Ladesaeule. **Damit ist „das Budget wird
  gehalten" an den simulierten Zaehlerwerten beweisbar, nicht nur an den
  Quittungen.** Dev-/Rig-Werkzeug, nie in einem Kunden-Image.

