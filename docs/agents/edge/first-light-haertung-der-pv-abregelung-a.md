# First-Light-Härtung der PV-Abregelung: Auffrischung, Klemm-Plateau-Beweis, Ena-Quirk (06.08.2026, live Pilsting)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 44).


Vier belegte Live-Defekte am selben Tag (`nodered/FRONIUS.md` §6b/CONTROL-BENCH.md
für den Betreiber-Ablauf) führten zu einer HÄRTUNG der Freigabe-Prüfung, NICHT
zu einer Lockerung - restrict-only, Kill-Switch, Freigabe je Einheit und der
native Totmann bleiben unangetastet.

- **Einmal-Schreiben reichte nicht: der Cap braucht eine AUFFRISCHUNG.**
  `sunspec/curtail.js` `writeDecision`/`noteWrite`/`noteVerdict` sind die reine
  Zustandsmaschine (Flow-Kontext `curtail_cmd:<unitKey>`), die eine AKTIVE
  Begrenzung alle `REFRESH_MS` (20 s) neu anwendet, bevor der native
  `WMaxLimPct_RvrtTms` (60 s) sie aufheben kann - die KETTE
  `REFRESH_MS < DEFAULT_RVRT_TMS < DefaultTTL` (20 s < 60 s < 120 s) ist auf
  BEIDEN Seiten gepinnt (`curtail.test.js` + Go `curtailcal_test.go
  TestTheRefreshRevertTTLChainHolds`) - ändere sie nur zusammen. Ein laufender
  First-Light-Test frischt JEDEN Takt auf (sein Beweisfenster ist kurz, seine
  Anspruchslast durch die 120-s-TTL begrenzt).
- **Der Datamanager verschluckt Befehle - bounded Retry, dann eine EHRLICHE
  Ursache.** Eine deviante Rücklesung wird SOFORT einmal neu geschrieben,
  begrenzt auf `REWRITE_MAX_ATTEMPTS` (3) Versuche derselben Signatur; danach
  stoppt der Executor `REWRITE_COOLDOWN_MS` (60 s) lang und nennt
  `REJECTED_REASON` (deutscher Text, benennt den EVU-Editor / die IO-Regel
  "100 %" als wahrscheinlichste Ursache + den Hebel: die Regel deaktivieren,
  NICHT Prioritäten umbauen) statt weiter zu schreiben - nie eine heiße
  Schleife, nie ein stilles Aufgeben.
- **Der Klemm-Plateau-Beweis ersetzt die alte "Minimum ≤ Cap"-Regel
  (`internal/curtailcal`).** Zwei live Fehlpositive (Cap 17,4 → gemessen
  12,9 kW; Cap 9,7 → gemessen 9,5 kW - beides Wolken, keine Klemmung) zeigten:
  ein echter Cap KLEMMT die Leistung AM Cap (Plateau), er drückt sie nicht
  darunter. `Session.CanCertify` verlangt jetzt `PlateauSamples` (3)
  aufeinanderfolgende, register-gedeckte (`RegisterHoldFresh`, 45 s) Messwerte
  IN BAND um den Cap, WÄHREND der geschätzte Ambient-Wert klar über dem Cap
  liegt (`ambientMargin`). Eine Schwester-Einheit am selben Standort (Pilsting
  WR1/WR2) dient als Ambient-Referenz (Verhältnis bei Test-Start eingefroren -
  fällt NUR die getestete Einheit relativ zur Referenz aufs Cap-Niveau, ist es
  der Cap; fallen beide proportional, ist es die Wolke); ohne Referenz ist der
  eigene Vor-Test-Wert die (konservative) Schätzung, abgesichert durch die
  Kopfraum-Pflicht beim Teststart (`Start` verweigert einen Test ohne
  genügend Marge zum Cap). Verdikte: `bestanden` / `nicht_beweisbar` (die
  Ambient-Schätzung sank auf/unter den Cap - eine Aussage über das WETTER, nie
  über den Wechselrichter) / `kein_nachweis` / `laeuft`.
- **Die Ena-Kennung (`WMaxLim_Ena`) ist ein bekannter Firmware-Quirk, kein
  Fehler.** Dieser Datamanager beantwortet einen befohlenen `Ena=0` dauerhaft
  mit `1`. `sunspec/curtail.js` `evaluateReadback` toleriert das EINSEITIG
  (befohlen 0 / ist 1 = Quirk, weil das bindende Register `WMaxLimPct` bei
  einer Freigabe ohnehin auf 100 % steht und nichts mehr drosselt; befohlen 1 /
  ist 0 bleibt ein ECHTER Mismatch - genau der Fall, den das Rücklesen fangen
  soll). Der Quirk reist als `quirk_roles`/`quirk_note` getrennt vom
  `mismatch_roles`/`last_error`-Pfad bis auf die `:8484`-Karte
  (`curtail.js` UI: "Hinweis: …", nie das Warndreieck).
- Beweise: `sunspec/curtail.test.js` (Auffrisch-/Retry-/Cooldown-Zustandsmaschine,
  Ena-Toleranz), `curtail-lease.e2e.test.js` (SCHLUCKER/REVERTER/KLEMMER/
  ENA-QUIRK gegen einen In-Process-SunSpec-Server mit den drei Fehlerarten),
  Go `internal/curtailcal/curtailcal_test.go` (Plateau, Ambient-Referenz,
  beide live Fehlpositive als Regressionstests, Register-Frische) +
  `agent/curtail_test.go` (First-Light-Reise: Register allein reicht nie,
  eine einzelne Cap-Messung reicht nie, erst das Plateau zertifiziert).

