# ⚠ `Bus.Close()` umgeht mochi-mqtts SHUTDOWN-DEADLOCK (echter CI-Ausfall 2026-08-26)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 77).


`mochi-mqtt/server/v2` verklemmt seinen EIGENEN Shutdown, sobald ein Client
abfällt, während `Server.Close()` läuft - in v2.7.9 **und in jeder früher
veröffentlichten Fassung**, es gibt also nichts, worauf man hochziehen könnte:
`Clients.GetByListener` hält die Lese-Sperre der Client-Karte und ruft darin
`Clients.Len()`, das dieselbe Sperre ERNEUT nimmt. Gos `sync.RWMutex` verbietet
genau diese Rekursion, sobald ein Schreiber wartet (sonst könnte man ihn
aushungern) - und der Schreiber ist das völlig gewöhnliche
`Clients.Delete` NACH dem Verbindungsabbruch eines beliebigen Clients. Beide
Goroutinen warten dann FÜR IMMER.

- **Das ist kein Test-Problem.** Denselben `Close()` ruft `Agent.Stop()` auf
  jedem Gerät, mit Node-RED als dem abfallenden Client.
- **Der Ausweg nimmt die deadlockende Aufrufstelle aus dem Spiel, statt ihr
  Rennen zu umgehen** (`internal/localbus` `Bus.Close`): erst den Listener
  SELBST schließen und seine Clients über einen Lauf trennen, der nie
  rekursiv sperrt (`Clients.GetAll` kopiert unter EINER RLock) - `TCP.Close`
  schützt seinen Client-Lauf mit `CompareAndSwapUint32(&l.end, 0, 1)`, also
  überspringt der danach laufende Bibliotheks-`Close()` `GetByListener`
  vollständig. Auf die Client-Goroutinen wartet er weiterhin
  (`Listeners.CloseAll` endet in `ClientsWg.Wait()`), es leckt also nichts, und
  jeder Client bekommt sein gewohntes „server shutting down"-DISCONNECT.
- **Der Wächter prüft die REIHENFOLGE, nicht den Hänger**
  (`TestCloseShutsTheListenerDownBeforeHandingOverToTheLibrary`): die Klemme
  selbst braucht eine Entfernung in einem nanosekundenschmalen Fenster, ein
  Test darauf allein wäre also ein Münzwurf. Beobachtbar ist dagegen exakt,
  worauf der Fix beruht - die Bibliothek protokolliert „gracefully stopping
  server" als ERSTES in ihrem `Close()` und schliesst den Netz-Listener erst
  weiter unten. Mit dem Fix nimmt zu dieser Zeile schon nichts mehr an; mit
  einem nackten `b.server.Close()` steht der Port offen, und genau in diesem
  Zustand kann ein abfallender Client die Abschaltung endgültig verklemmen.
  Daneben steht `TestCloseReturnsWhileClientsAreDropping` als
  Lebendigkeits-Probe.
- **⚠ Dieselbe Bibliothek hat ZUSÄTZLICH ein Datenrennen zwischen ANNEHMEN und
  `Close()`** (`Server.NewClient` liest `s.done` in server.go:401, `Close`
  schliesst es in server.go:1499) - von diesem Fix unberührt. Wer hier einen
  Test schreibt, der WÄHREND der Abschaltung neue Verbindungen aufbaut, wird
  unter `-race` sporadisch rot, und zwar aus diesem fremden Grund; die Wächter
  hängen ihre Clients deshalb VORHER an.
- **Symptom-Erkennung im CI:** ein `panic: test timed out` im Paket
  `internal/agent`, dessen Stapel `localbus.(*Bus).Close` in einem `t.Cleanup`
  zeigt (`inverter_test.go` `startBusOnlyAgent`), plus eine zweite Goroutine in
  `attachClient` → `Clients.Delete`. Das ist DIESER Deadlock, kein langsamer
  Testlauf.

