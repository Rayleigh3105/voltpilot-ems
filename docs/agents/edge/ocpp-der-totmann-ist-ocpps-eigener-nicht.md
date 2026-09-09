# OCPP: der Totmann ist OCPPs eigener, nicht unserer (`csms/profiles.go`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 68).


Die Smart-Charging-Hälfte des CSMS (Konzept §3.1/§4.3). Drei Profile, und die
Arbeitsteilung zwischen ihnen IST die Ausfallsicherheit:

    ChargePointMaxProfile  harte Kappe der ganzen Säule, PERMANENT
    TxDefaultProfile       sicherer Vorgabewert je Stecker, PERMANENT
    TxProfile              die LEBENDE Zuteilung, mit kurzer `duration`,
                           alle paar Sekunden aufgefrischt

- **⚠ Stirbt die Box, läuft das TxProfile AUF DER SÄULE ab und sie fällt von
  selbst auf ihr gespeichertes Default zurück — dafür muss NICHTS von uns
  funktionieren.** Genau deshalb ist der Rückfall der OCPP-Mechanismus und kein
  Wachhund, den wir schreiben. `TestThePermanentProfilesNeverExpireAndTheLiveOneAlways`
  nagelt beide Hälften fest; `TestTheLiveLimitExpiresOnItsOwn` beweist es gegen
  eine simulierte Station, die den Profil-Stapel und den Ablauf wirklich
  auflöst (der in-process-Zwilling der SAP-Simulator-Semantik).
- **Eine PAUSE ist ein Limit von 0, kein fehlendes Limit.** Das Profil zu
  LÖSCHEN nähme die Beschränkung weg und das Fahrzeug zöge den Default — das
  Gegenteil von „pausieren".
- **⚠ Profil-Ids sind je Stecker verschieden** (`TxProfileID(connector)`): ein
  `SetChargingProfile` mit bekannter Id ERSETZT das Profil, zwei Stecker mit
  derselben Id überschrieben also gegenseitig ihre Grenze.
- **Erst FRAGEN, dann befehlen** (die Anti-Deye-Disziplin vor dem ersten
  Schreibvorgang statt nach der ersten Überraschung): `GetConfiguration` liest
  `ChargingScheduleAllowedChargingRateUnit`, `ChargeProfileMaxStackLevel`,
  `ChargingScheduleMaxPeriods`, `MaxChargingProfilesInstalled`. **Ein FEHLENDER
  Einheiten-Schlüssel gilt als „W erlaubt"** — er ist in 1.6 optional und viel
  Firmware lässt ihn weg, während sie Watt-Grenzen anstandslos nimmt; die
  Antwort der Säule auf `SetChargingProfile` bleibt das echte Urteil.
- **Ampere braucht bestätigte Anschlussdaten.** Ohne obere Betriebsspannung,
  tatsächliche Phasen und reservierte Phasenbudgets bleibt eine Ampere-only-Säule
  gesperrt. Profile und Rücklesung verwenden diese Daten; keine geratenen Werte.
  Die Grenzen und der Kundenablauf stehen in `docs/ocpp-control.md`.
- **Rücklesen ist Pflicht, und Schweigen ist keine Zustimmung**
  (`GetCompositeSchedule` → `CompareReadback`): `ok` · `abweichend` ·
  `unbekannt`. Ein angenommener Befehl ist kein Befehl in Kraft — die
  PR-280-/Deye-Lehre auf OCPP übertragen. Eine Antwort in AMPERE wird nur mit passender erklärter Verdrahtung
  umgerechnet; fehlende oder abweichende Phasen bleiben `unbekannt`.
- **`Commission` läuft bei JEDEM (Wieder-)Verbinden**, nicht einmal beim
  Koppeln: eine Säule, die neu gestartet hat, kann ihr Sicherheitsprofil
  verloren haben, und eine Anlage mit geänderten Grenzen muss die neuen lernen.
  Ein Fehlschlag wird protokolliert UND zurückgegeben — nie bleibt eine Säule
  „eingerichtet" aussehend zurück.
- **⚠ Für TESTS mit einer simulierten Station: EINE Uhr.** Der Profil-Start
  kommt vom Server, den Ablauf beurteilt die Station — zwei auseinanderlaufende
  Uhren lassen ein Profil im Moment des Schreibens abgelaufen aussehen
  (`startServerWithClock`). Und `connectStation` WARTET, bis das CSMS die
  Verbindung verbucht hat: die Bibliothek meldet den Dial fertig, bevor ihr
  Server-Callback gelaufen ist.

