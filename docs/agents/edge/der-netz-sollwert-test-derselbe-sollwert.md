# Der NETZ-SOLLWERT-TEST: derselbe Sollwert-Pfad, eine andere Regelseite

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 89).


Der begrenzte, armierte Testpfad, der klärt, ob der Deye seine EIGENE PV über den
netzseitigen Fernsteuermodus (`1104 = 2`) regeln kann — die Größe, die der
Fronius-Abregelweg strukturell nicht erreicht. Konzept: Scout
`vp-deye-netzseitig-drossel-k2`; Registerlage `nodered/DEYE.md` →
„Fernsteuerung: drei Regelseiten"; Live-Protokoll `nodered/CONTROL-BENCH.md` →
„Netz-Sollwert-Test". Was HIER gelten muss:

- **⚠ ES GIBT KEINEN PRODUKTIVPFAD.** Kein automatischer Eintritt aus dem
  Fahrplan, keine Cloud-Änderung, kein Vertragsfeld. Der Lauf ist manuell
  armiert, TTL-begrenzt (120 s netzseitig, 60 s AC) und betreiber-gesperrt
  (`calGuard`, dasselbe Kennwort wie die Kalibrierung). Ohne armierten Lauf ist
  der Sollwert-Pfad byte-identisch zu vorher — gepinnt von
  `agent.TestWithoutAnArmedGridTestTheSetpointIsByteForByteUnchanged`.
- **⚠ Er umgeht GAR KEIN Tor — der eine Unterschied zur First-Light-Kalibrierung.**
  Die umgeht bewusst die ZERTIFIZIERUNG (sie verdient sie ja erst); dieser Test
  verlangt Not-Aus AN, Zertifikat vorhanden und Fernsteuerpfad, und das
  veröffentlichte `control_enabled` ist dieselbe Konjunktion wie im Normalbetrieb.
  `CERTIFIED_CONTROL_FAMILIES` wird durch nichts davon geweitet.
- **Die REGELN liegen rein in `internal/curtailcal/gridtest.go`** (Zustandsautomat,
  Zulassung, Abbruch-Hülle, Plateau-Beweis; jede zeitabhängige Funktion nimmt ihr
  `now` — das `otaapply`/`calibration`-Muster), `agent/gridtest.go` ist
  ausschließlich Verdrahtung. Der Sollwert-Überschreiber ist wortgleich zur
  Bauform von `calibrationOverride`.
- **⚠ ZWEI Vorzeichen-Konventionen auf DERSELBEN Adresse 1109.** Batterieseitig
  negiert (`deyeRemoteSetpointUnits`, unser Kontrakt ist `+ = laden`, das Register
  `− = laden`), netz-/AC-seitig NICHT (`deyeGridSetpointUnits` — dort meinen beide
  `− = Einspeisung`). Auch die Rückmeldung dekodiert je ROLLE
  (`battery_power` negiert, `grid_power`/`ac_power` nicht). Wer hier pauschal
  negiert, dreht den Netz-Sollwert um.
- **⚠ Der Moduswechsel braucht den NEUTRALSCHRITT** (Captain-Entscheid E2):
  `1109 ← 0` → `1104 ← neu` → `1109 ← Ziel`, drei Transaktionen in EINEM Takt.
  `1104` wechselt die BEDEUTUNG eines stehenden Wertes — ohne den Zwischenschritt
  wäre der Batterie-Sollwert im selben Augenblick ein Netz-Sollwert. Er wird
  bewusst NICHT zurückgelesen (derselbe Takt überschreibt ihn, ein Rücklesen
  ergäbe eine garantierte Abweichung), und `Neutralize` markiert den TAKT MIT
  SEITENWECHSEL, nie den Neutralschritt selbst.
- **⚠ Das Ziel geht NIE über 0** (`targetFor`): ein positiver Netz-Sollwert ist ein
  BEZUGS-Ziel, und der Deye lüde die Batterie aus dem Netz. Die Klemme ist eine
  Eigenschaft des Codes, keine Zusage.
- **⚠ `1115` wird nur im Band 1..999 geschrieben.** 1000 und darüber heißt auf
  diesem Register „eigene PV auf 0" (Feldbericht, §1.7) — der Pilot steht auf
  1000, und ob HV sich genauso verhält, klärt erst der Live-Test. `parseGridTest`
  lässt deshalb nichts anderes durch, und `readback-verify.js` kennt die
  Skalenfamilie (`VALUE_RANGE.pv_max_permille = [0, 1200]`), damit ein `0xFFFF`
  des Loggers „keine Antwort" bleibt statt eine Abweichung zu werden.
- **Der BEWEIS ist ein PLATEAU am Ziel** (`GridPlateauSamples` = 3, register-gedeckt)
  gegen die Fronius-Einheiten als Umgebungs-Referenz — dieselbe Regel, die die
  Fronius-Freigabe nach zwei Fehlpositiven bekommen hat. Bricht die Referenz um
  mehr als 30 % ein, lautet das Urteil **`nicht_beweisbar`** (eine Aussage über das
  WETTER), nie `kein_nachweis`.
- **⚠ Ein FEHLGESCHLAGENER Schreibvorgang behält seinen armierten Wachhund**
  (`agent.GridTestStart` armiert das automatische Aus, BEVOR geschrieben wird —
  das Kalibrier-Muster): ein Schreibvorgang kann angekommen sein und nur seine
  Antwort verloren haben.
- **Die geplante Fronius-Kappe reist UNVERÄNDERT weiter** (`pv_limit_kw` +
  `curtail`-Block im Testsollwert): ohne sie läse `sunspec/curtail.js` ein
  fehlendes Anlagen-Limit als `release` und gäbe mitten im Test genau die
  Abregelung frei, gegen die gemessen wird.
- **Beweise:** rein `internal/curtailcal/gridtest_test.go` (34 Fälle: Schrittfolge
  und ihre Summe, jede Zulassungsregel mit ihrem deutschen Grund, Abbruch-Hülle,
  Plateau inkl. „ein einzelner Treffer ist kein Beweis", die vier Urteile, TTL und
  Rückkehr-Kulanz) · `internal/agent/gridtest_test.go` (15: die Reise auf dem
  Bus, byte-identisch ohne Armierung, jede offene Voraussetzung ohne
  Schreibvorgang, Not-Aus MITTEN im Lauf, Abbruch nimmt SOFORT zurück) ·
  `internal/web` (Routen, Kennwort-Tor, //go:embed-Vertrag der Karte) ·
  `nodered/inverter-control-routing.test.js` (Reihenfolge, beide Konventionen,
  1115, strenge Form) · `flows-sync.test.js` (die Inline-Kopie == das Modul für
  JEDEN Schritt) · `deye-control.e2e.test.js` (echter Solarman-Logger:
  Seitenwechsel, PV-Kappe, Rückkehr, Totmann je Takt, ohne Freigabe kein Byte) ·
  `readback-verify.test.js` (Ringabstand je Rolle, 1115-Füllwert).

