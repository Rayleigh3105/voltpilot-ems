# ⚠ Die PV-Abregelung wird als EIN FC16-Block geschrieben - ein Einzelregister wird gespeichert, aber nicht ÜBERNOMMEN (09.08.2026, live Pilsting)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 45).


Die Begrenzung geht seither als EINE Modbus-Transaktion (fn 0x10) über die fünf
ZUSAMMENHÄNGENDEN Register `WMaxLimPct .. WMaxLim_Ena` hinaus. Betreiber-Bild +
Messwerte: `nodered/FRONIUS.md` §6e. Was hier gelten muss:

- **Der Befund, weil die Fehlerform wiederkommt:** drei einzelne FC6-Schreibbefehle
  wurden ANGENOMMEN, der Wert stand die vollen 120 s im Register
  (`register_confirmed: true`) - und die Leistung folgte NICHT (Cap 13,1 kW,
  gemessen 13,8-17,5 kW bei 20,4 kW Ambient-Referenz, Plateau 0/3). Gleichzeitig
  kam `pv_limit_revert_tms` (befohlen 60) nie an und las dauerhaft 12000, den
  Wert des Vorgänger-Reglers. **Ein bestätigtes Register ist kein aktiver
  Befehl** - genau dafür existiert der Klemm-Plateau-Beweis.
- **Zwei unabhängige Quellen tragen den Fix**, er ist nicht geraten: das
  Fronius-Modbus-Handbuch („All 5 registers … can be written with one command",
  fn 0x10) und Victrons produktive Umsetzung (`victronenergy/dbus-fronius`,
  `sunspec_updater.cpp` `SunspecLimiter::writePowerLimit`: EIN
  `writeMultipleHoldingRegisters` mit `[pct, 0, timeout, 0, 1]` auf
  Modell-123-KOPF + 5). Victrons Adresse ist byte-für-byte unsere
  (Kopf + 5 = Rumpf + 3 = `WMaxLimPct`) - die Adress-Arithmetik war also richtig,
  nur die SCHREIBFORM war es nicht. Dieselbe Fehlerklasse wie bei Deye
  (dort ebenfalls FC6 angenommen und still ignoriert).
- **`WinTms`/`RmpTms` werden AUSDRÜCKLICH als 0 mitgeschrieben** (wie bei
  Victron): sie gehören zum Satz, und Reste eines Fremdreglers dürfen unsere
  Begrenzung nicht verzögern. Wer den Block kürzt, macht wieder ein „partielles"
  Kommando daraus.
- **⚠ `WMaxLimPct_RvrtTms = 0` heißt NICHT „kein Timeout", sondern „aktiv bis
  MANUELL deaktiviert"** (Fronius: „die Dauer, die der Betriebsmodus aktiv
  bleibt", 0..28800 s, Timer startet mit jeder neuen Modbus-Nachricht neu). Der
  Vorgänger-Regler hinterließ 12000 s, und als er verstummte, hingen BEIDE
  Wechselrichter 3,3 h bei ~0,135 kW fest. Nie 0 schreiben; die Kette
  `REFRESH_MS 20 s < DEFAULT_RVRT_TMS 60 s < Test-TTL 120 s` gilt unverändert.
- **Der Rückfall ist konfigurierbar, nie der Default:**
  `connection.curtail_write_fc` (0/absent = FC16, 6 = die alte Einzelregister-
  Form) - der Zwilling von `control_write_fc` für den ANDEREN Steuerpfad.
  **Er muss DREI Whitelists überleben**, sonst ist er unerreichbar: Go
  `sources.busEntry` → der `sunspec_live`-Zweig des `sources-store`-Knotens in
  `build-flows.js` → `sunspec/curtail.js`, das ihn an `planCurtailment` reicht.
  Er reitet bewusst auf der QUELLEN-Konfiguration, weil ein Fronius als
  Erzeuger-QUELLE abgeregelt wird, nicht als Primär-Wechselrichter.
- **`plan.writes` hat jetzt ZWEI Formen** - ein Block-Op trägt `values` (+ `parts`
  als die eine Beschreibung der fünf Register), ein Legacy-Op `value`. Wer
  `writes` konsumiert, muss beide kennen: `curtail.commandSignature` faltet
  DESHALB jedes Register des Blocks (signierte es nur das erste, läse ein
  geänderter Timer oder ein umgelegtes Enable als „unverändert" und würde nie
  neu angewandt). `writes[0].encode.sf` bleibt für die kW-Rückrechnung erreichbar.
- **Es wurde KEINE Anlagen-Adresse erfunden.** In SunSpec gibt es kein
  anlagenweites Modell 123, das Handbuch kennt nur Wechselrichter- und
  Zähler-Adressen, und Victron schreibt pro Wechselrichter. Dass beide Geräte
  gleichzeitig klemmten, erklärt der gemessene Register-Zustand vollständig
  (beide trugen den gelatchten Zustand des Vorgängers). Die Anlagen-Semantik
  macht weiterhin `splitPlantCap`.
- Beweise: `curtail-lease.e2e.test.js` „PILSTING" (In-Process-Gateway mit
  `transactionalOnly`: FC6 wird bestätigt UND gespeichert, aber nur ein
  FC16-Block übernommen - der Block-Pfad regelt wirklich, der FC6-Rückfall
  reproduziert das Feld-Symptom „Register bestätigt, nichts übernommen"), dazu
  der FC16-Verweigerungsfall, `modbus-tcp.test.js` (Rahmenformat + Ausnahmen),
  `sunspec/model-discovery.test.js`, `sunspec/curtail.test.js`, Go
  `inverter_test.go` / `sources_test.go`.

