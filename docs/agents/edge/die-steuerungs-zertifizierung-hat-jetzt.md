# Die Steuerungs-Zertifizierung hat jetzt DREI Quellen - die dritte ist die Plattform

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 50).


`agent.controlCertified` (`internal/agent/calibration.go`) ist die EINE Stelle,
an der sie ODER-verknuepft werden:

  1. die flottenweite env-Allowlist (`config.ControlCertified`, auf die FAMILIE),
  2. die First-Light-Freigabe DIESER Box (`calibration-certified.json`, Familie),
  3. das PLATTFORM-Register (`internal/controlcert` + `agent/controlcert.go`,
     auf brand+MODELL - einmal am Pruefstand, danach flottenweit).

Weil sie ODER-verknuepft sind, kann Quelle 3 nur HINZUFUEGEN: eine Box mit
First-Light-Grant behaelt ihn auch bei leerem Register und bei retained-clear
(`agent/controlcert_test.go TestAPlatformDocumentNeverRemovesAnExistingLocalGrant`).
Volles Bild (Migration, Endpunkte, Portal): Root-`AGENTS.md`
„Steuerungs-Zertifizierung: das PLATTFORM-Register".

- **Die ENTSCHEIDUNG faellt hier, nicht in der Cloud.** Das retained Dokument auf
  `.../v2/control-certification` sagt, WELCHE Modelle gedeckt sind und ob DIESE
  Anlage scharfgeschaltet ist; `controlcert.Match` vergleicht das mit der
  EIGENEN Auswahl (brand + model + family, und - falls der Pruefstand sie nennt -
  die `invert_control_sign`-Konvention). Dieselbe Disziplin wie beim
  OTA-Sidecar, der dem Kern nichts glaubt.
- **⚠ Beides ist noetig:** `activated` allein steuert nichts, ein Register ohne
  Scharfschaltung auch nicht. Und ein SCHWESTER-Modell derselben Familie ist
  NICHT gedeckt - der Schluessel ist bewusst das Modell.
- **Vier Urteile, weil sie verschiedene Saetze sind** (`granted` ·
  `covered_not_activated` · `not_covered` · `unknown`). ⚠ `unknown` (kein
  Dokument, geloescht, unparsbar, kein Wechselrichter gewaehlt) darf NIE als
  „nicht zertifiziert" gelesen werden.
- **Fail-closed durchgehend:** unbekannte Vertragsversion, kaputtes JSON,
  unvollstaendige Identitaet und ein widersprochenes Vorzeichen geben NICHTS
  frei und protokollieren LAUT. Eine einzelne kaputte Registerzeile wird
  verworfen, nie das ganze Register.
- **Zustand + Bericht:** `platform-cert.json` im Datenverzeichnis (tmp+rename,
  damit eine offline bootende Box einen legitimen Grant behaelt, bis die
  retained Zustellung wieder konvergiert), `Snapshot.PlatformCert` +
  `Snapshot.ControlCertSource`, und im Herzschlag additiv
  `control.cert_source` + `control.platform_cert` - **aus dem KERN, nie aus
  einem Readback-Stempel** (die Regel, an der schon zwei Live-Defekte hingen).
  Ein Geraet ohne Dokument sendet den Block GAR NICHT.
- **⚠ Lock-Reihenfolge:** `invMu` (die Wechselrichter-Auswahl) wird IMMER vor
  `pcMu` genommen, nie umgekehrt - jede Funktion in `agent/controlcert.go` haelt
  sich daran.
- Ein Wechsel der Wechselrichter-Auswahl bewertet das Register neu
  (`refreshPlatformCertAfterSelectionChange`): das Register hat sich nicht
  geaendert, aber das, worauf es angewandt wird.
- Der proven Steuerpfad des Registers speist `device_certified_path`, wenn diese
  Box keine eigene First-Light-Evidenz hat - genau der Fakt, mit dem Layer 1
  seinen sticky Pfad-Entscheid vorsetzen will.

