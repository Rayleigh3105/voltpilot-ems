# Register schreiben über das Portal, Stufe 3 „Bis zum Endkunden"

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 100).


Die dritte Stufe des Konzepts `data/vp-reg-schreib-konzept-p8` (§2.8 Stufenplan; Captain-Entscheide
**D1 = freie LAN-Adresse auch für Endkunden · D2 = Box-Flag-Vorgabe AN, Cloud-Kill-Switch bleibt ·
D4 = `betreiber-admin` GAR NICHT**). Sie fügt **keinen neuen Schreibpfad** hinzu: der Endkunde fährt
auf seiner eigenen Anlage GENAU DIE Zwei-Schritt-Strecke, die die Plattform-Geräteseite seit Stufe 1
fährt — Reichweite ist RLS, Herkunft im Journal ist `kunde`, und die Rollen unterscheiden weiterhin
nur, WESSEN Anlagen jemand erreicht, nie WELCHE Register.

- **Portal-seitig entsteht NICHTS Zweites.** Der Kunden-Aufklapper im Anlagen-Modell hostet den
  BESTEHENDEN `RegisterWriteDrawer` (Konzept §2.7); es gibt weiterhin eine Zwei-Schritt-Strecke, eine
  Warnklassen-Tabelle, eine Beleg-Ableitung. Damit ist der Verantwortungs-Satz per Konstruktion auf
  beiden Wegen derselbe. Details + die Ehrlichkeitsregeln der Fläche: `frontend/portal/AGENTS.md`.
- **D1-Folge:** der Kunde bekommt denselben Geräte-Picker UND die freie LAN-Adresse. Sie ist LAN-only,
  und **belegbar privat ist sie NUR, weil die BOX es prüft** (`probe.IsPrivateHost` + die geteilten
  Vektoren) — im Portal steht ausdrücklich keine zweite Wahrheit über ein Netz, das es nie gesehen hat.
- **⚠ D2-Folge, und sie ist die tragende Umkehrung dieser Stufe: auf der Box gibt es KEIN
  Feature-Flag mehr.** Bis Stufe 2 war `VP_INSTALLER_WRITE_ENABLED` die eigentliche Sicherung („eine
  nicht armierte Box antwortet `gate_disabled`"); Stufe 3 drehte seine Vorgabe auf AN, und die
  **Captain-Korrektur vom 20.08.2026 (D2 KORRIGIERT) hat es ERSATZLOS entfernt** — aus
  `edge-app/core/internal/config`, aus beiden Edge-Composes und aus `install.sh`. Der
  Einmal-Schreibpfad (lokale `:8484`-Tür UND Portal-Downlink-Konsument) ist damit auf jeder Box
  immer verfügbar, ohne Armierung und ohne `404`-Zustand; der plattformweite Hebel musste deshalb
  ein echter werden — siehe den nächsten Punkt. **Unverändert gelten ALLE inhaltlichen Tore**
  (Zwei-Schritt-Strecke, `expected_before`, Einmaligkeit, Lane-Politik inkl. Wertgrenzen /
  Selbstkonflikt-Sperre / LAN-only, das Betreiber-Kennwort `calGuard` an der lokalen Tür, RLS/JWT auf
  dem Portal-Weg, Box-Audit + D6-Uplink). Das Wort `gate_disabled` bleibt im KONTRAKT und in der
  Cloud-Whitelist, weil eine Box mit ÄLTEREM Image es noch senden kann; kein aktueller Build erzeugt
  es. **Wirksam wird die Umstellung erst mit dem NÄCHSTEN Edge-Release** — eine laufende Box behält
  ihr Image und ihr `.env` (ein dort gesetztes `VP_INSTALLER_WRITE_ENABLED` wird vom neuen Build
  schlicht ignoriert).
- **⚠ Der Cloud-Not-Aus `voltpilot.register-write.enabled` wirkt seit dieser Stufe im DIENST, nicht an
  der Route.** Vorher nahm `@ConditionalOnProperty` dem Controller die Bohne: die Routen
  antworteten mit einem nackten **404** — zeichengleich mit der Antwort des Mandanten-Zauns auf eine
  FREMDE Anlage (ein Kunde hätte in seiner eigenen Anlage einen Fehler gesucht, den es nicht gab) —
  und der VERLAUF verschwand mit, obwohl das Journal genau dann interessant ist, wenn jemand den
  Not-Aus gedrückt hat. Jetzt refüsieren nur die zwei SCHREIBENDEN Schritte, mit **503** und einem
  deutschen Grund, der die PLATTFORM nennt; `targets`, das Register-Wissen und `history` bleiben
  lesbar. Die Prüfung ist die ERSTE Anweisung beider Schritte — kein Ziel wird aufgelöst, keine Runde
  zum Broker gedreht, keine Journal-Zeile geschrieben. Vorgabe unverändert AN (die gitops-Falle), in
  BEIDEN Composes gesetzt.
- **D4-Folge:** die im Konzept optionale Realm-Rolle `betreiber-admin` entfällt ERSATZLOS — zwei
  Stufen (Endkunde · Plattform-Admin) reichen, und `RegisterWriteService.Actor.origin()` leitet die
  Herkunft weiterhin allein aus den validierten Realm-Rollen ab.
- **⚠ Ein auf `main` schon STALER Go-Test wurde mitrepariert** (`agent.TestPolicyRefusalsComeFrom
  TheSharedCoreVerbatim`): sein Vektor war „Wert 9000 > Deckel 7000", und Stufe 2 hat genau diesen
  Deckel für den Portal-Kanal abgelöst (`AdmitExpert` lässt 0..65535 frei; der Deckel gehört allein
  der engen `:8484`-Taste). Der Auftrag lief seither in den Bus statt in eine Politik-Ablehnung und
  der Test lief in seinen 10-s-Timeout. Der Vektor ist jetzt ein **Funktionscode-Widerspruch**
  (FC5 auf ein Holding-Register), über den dieselbe geteilte Schicht urteilt — und der Test prüft
  zusätzlich, dass der deutsche Satz WÖRTLICH aus `installerwrite` kommt.
- **Beweise:** rein `RegisterWriteKillSwitchTest` (3: beide Schritte 503 mit deutschem Grund, KEIN
  Mitspieler berührt, Verlauf bleibt lesbar, eingeschaltet kommt die Ablehnung von weiter unten) ·
  Go `config_test.go` (es gibt keinen Umgebungs-Schalter mehr — jeder Wert lässt die Konfiguration
  byte-gleich), `agent/register_write_test.go` („der Pfad braucht keinen Armierungs-Schritt" +
  Struktur-Wächter gegen ein wieder eingeführtes Feld), `web/web_test.go` (die Routen existieren
  ohne Armierung, der Schreib-Aufruf bleibt hinter dem Betreiber-Kennwort) ·
  Portal `registerWrite.test.ts` (+5) / `RegisterWriteDrawer.test.tsx` (+2) /
  `AnlagenModellSection.test.tsx` (+2). Im echten Chrome bei 1440 und 375 durchgespielt: Aufklapper →
  Ziel → Ist-Wert → Wert + Pflicht-Grund → Rückfrage mit dem Verantwortungs-Satz; 0 px horizontaler
  Überlauf, keine Konsolenmeldungen.

