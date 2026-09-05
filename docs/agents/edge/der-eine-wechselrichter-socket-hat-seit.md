# Der EINE Wechselrichter-Socket hat seit dem 20.08.2026 eine WARTESCHLANGE

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 58).


`edge-app/nodered/bus-arbitration.js` (rein, unit-getestet) ist die Quelle der
Schluessel und der Zeitfenster; die drei Knoten des Tabs „Wechselrichter
(automatisch)" tragen sie als Literale und `flows-sync.test.js` pinnt sie gegen
das Modul. Der Anlass ist ein Produktionsvorfall (Anlage Pilsting/Herzogau, Box
edge-45gz7da, 20:08-20:10Z): eine Einmal-LESUNG aus dem Portal verhungerte am
Bus, der Kern gab nach 30 s auf und die Cloud meldete `timeout` auf einer
kerngesunden Anlage. Drei Befunde, alle reproduziert:

1. **EINE Absichts-Fahne fuer ZWEI Schreiber.** Steuer-Executor und
   Einmal-Auftrag benutzten beide `sv5_write_want:`; der Steuer-Executor setzt
   sie am Ende JEDER Runde (und beim Verschieben) auf 0 - und loeschte damit die
   Absicht eines noch WARTENDEN Einmal-Auftrags. Der Lese-Poll, der genau auf
   diese Fahne zuruecktritt, nahm sich den Socket danach wieder.
2. **Keine UEBERGABE.** Wer freigab, entliess den Socket ins Rennen: der
   naechste Inject-Takt (Lesen 5 s, Steuern ~10 s) prueft EINMAL synchron und
   greift zu, waehrend ein Wartender nur alle 300 ms nachsah. Es gab keine
   Reihenfolge und damit keine endliche Zusage.
3. **⚠ DIE ZEITFENSTER-KETTE WAR GERISSEN.** Der Einmal-Knoten durfte 12 s
   warten UND danach 25 s am Socket verbringen - zusammen 37 s, waehrend der
   Kern nach 30 s aufgibt. Seine spaetere, korrekte Antwort fiel in einen
   laengst vergessenen Wartenden.

**Die Regel, in einem Satz:** ein Einmal-Auftrag RESERVIERT den Bus
(`sv5_oneshot:<host:port>`, EIGENER Schluessel - kein anderer Schreiber fasst
ihn an); wer den Socket haelt, UEBERGIBT ihn beim Beenden an diese Reservierung
(`sv5_grant:`); Lese-Poll und Steuer-Executor behandeln die Uebergabe wie
„belegt" und warten sie AB. Damit steht zwischen einem Einmal-Auftrag und seinem
Slot HOECHSTENS EINE laufende Socket-Runde.

- **⚠ STEUER-VORRANG BLEIBT DAS PRINZIP.** Eine Reservierung bricht NIE eine
  laufende Steuerrunde ab und weist NIE einen Steuer-Schreibvorgang zurueck; der
  Steuer-Executor wartet eine Uebergabe innerhalb seines EIGENEN, unveraenderten
  Budgets ab (9 s / 14 s calibration) und verschiebt im schlimmsten Fall einen
  Takt - genau das, was er heute schon tut, wenn der Lese-Poll den Socket haelt.
- **Der Lese-Poll tritt fuer eine Reservierung zurueck, aber GEBUNDEN**
  (`ONESHOT_READ_YIELD_TICKS`, 6 × 5 s = 30 s ≥ dem ganzen Worst Case eines
  Einmal-Auftrags): er erzwingt also nie mitten in einem legitimen Auftrag, und
  eine haengende Reservierung kann die Telemetrie trotzdem nicht aushungern (das
  Erzwingen bleibt hoerbar).
- **Reservierung und Uebergabe VERFALLEN** (20 s bzw. 5 s); die Reservierung
  wird bei jedem Wartetakt aufgefrischt, gilt also genau so lange, wie wirklich
  gewartet wird. Ein abgestuerzter Auftrag kann den Bus nie festhalten.
- **⚠ Die drei Zahlen sind eine KETTE**
  (`ONESHOT_ACQUIRE_MS + ONESHOT_SOCKET_MS ≤ installerWriteTimeout <
  voltpilot.register-write.read-timeout`, heute 15 s + 12 s ≤ 30 s < PT40S) und
  `ONESHOT_ACQUIRE_MS > CONTROL_SOCKET_MS`, damit der Auftrag EINE volle
  Steuerrunde ueberdauern kann. Gepinnt in `flows-sync.test.js` („die
  Zeitfenster-Kette", liest die Go-Datei per PFAD),
  `agent.TestTheCoreOutwaitsTheNodesOwnBudget` und - fuer die Cloud-Haelfte -
  `RegisterWriteBudgetTest`.
- **Der lokale `:8484`-Weg und der Portal-Downlink teilen sich das alles**: sie
  rufen denselben `Agent.WriteOnce` und damit denselben Knoten. Der Vormittag
  war nur deshalb schnell, weil die Anlage damals NICHT steuerte - der
  Unterschied war die LAST, nie der Ausloeser.
- **Eine verspaetete Antwort wird BENANNT** (`onInstallerWriteResult` warnt bei
  einer Antwort ohne Wartenden), sonst ist aus dem Geraeteprotokoll allein „zu
  spaet" nicht von „nie geantwortet" zu unterscheiden.
- **⚠ Der Timeout-Satz folgt dem MODUS.** `Agent.WriteOnce` weiß über
  `AdmittedWrite.Apply()`, ob der Auftrag nur las oder wirklich schrieb: beim
  Probelauf ist „Es wurde nichts geschrieben“ belegbar, beim Schreibauftrag
  bleibt der Zustand unbekannt. Den alten, mode-blinden Satz („nicht sicher, ob
  geschrieben wurde“) auch bei einer Lesung zu zeigen, war eine falsche
  Gerätewirkung und wird von
  `TestASilentDeviceGetsModeSpecificHonestFailureAndOnlyWritesAreAudited`
  verhindert.
- Beweise: `bus-arbitration.test.js` (die reinen Regeln) · `flows-sync.test.js`
  (die drei Knoten sprechen EINE Warteschlangen-Sprache, die Kette, der
  gebundene Rueckzug) · `deye-control.e2e.test.js` („EINMAL-LESUNG UNTER
  STEUERLAST" - Lese-Poll und Steuer-Executor takten ohne Pause gegen einen
  Ein-Klient-Logger, die Lesung kommt trotzdem durch; die zwei BEFUND-Tests und
  „eine TOTE Reservierung kann den Bus nicht festhalten"). Der Lasttest FAELLT
  auf dem alten Stand mit `busy` nach 12 s um - er ist der Repro, nicht nur die
  Zusage.

