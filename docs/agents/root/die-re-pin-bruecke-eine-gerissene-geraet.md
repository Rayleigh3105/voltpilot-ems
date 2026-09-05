# Die RE-PIN-BRÜCKE: eine gerissene Geräte-Bindung heilt sich selbst

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 26).


Der Live-Defekt (Anlage Pilsting/Herzogau, Edge-Update edge-2026.08.5 → .10,
20.08.2026): beide Fronius-Komponenten lasen „nicht mehr mit einem gemeldeten
Gerät verbunden", während DIESELBEN Wechselrichter daneben als „Neues Gerät
gefunden" auftauchten und ungestört weiter Messwerte lieferten. Der Deye blieb
gebunden. **Nur die Zuordnung riss** — die Quellen-Kennungen der Box hatten sich
geändert, und `measurement_point.edge_source_id` ist der Pin, an dem die
Komponente hängt.

- **Die WURZEL liegt auf der Box und ist dort behoben** (`edge-app/AGENTS.md`
  „Eine Kennung, die auf dieser Box schon läuft, wird NIE neu vergeben"):
  `sources.DeterministicID` kam ohne Migration (PR 270), jede vorher
  eingerichtete Anlage trägt deshalb bis heute ZUFÄLLIGE Kennungen — und die
  Bestands-Übernahme (Einheitsmodell Stufe 2) leitete sie deterministisch neu ab
  und schrieb `sources.json` neu. **Die dokumentierte No-op-Zusage der Übernahme
  galt nur für Anlagen ab PR 270.** Der Fix braucht eine Edge-Auslieferung.
- **Diese Brücke ist die zweite Hälfte und wirkt SOFORT nach dem Deploy**, ohne
  Edge-Release: eine Box, die den Riss schon vollzogen hat, meldet ab jetzt die
  neuen Kennungen — die Cloud erkennt dasselbe Gerät wieder und pinnt neu.
- **`components/ComponentRebind`** ist die reine Regel (Docker-frei, das
  `ComponentAdoption`/`Tagesprotokoll`-Muster). Vier Ehrlichkeitsregeln:
  **nur verwaiste Pins und nur freie Geräte** (eine lebende Bindung wird nie
  angefasst); **nur ein eindeutiges 1:1** (sonst passiert NICHTS und der manuelle
  Weg „Wieder verbinden" bleibt — die Lehre aus der Doppel-Adoption
  `vp-vier-erzeuger-p9`, deren Geister-Erzeuger niemand mehr auseinanderbekam);
  **ohne gespeicherte Anbindung wird nichts behauptet**; und der Fingerabdruck
  ist **STRENGER als die Identitäts-Regel der Box, nie gleich**.
- **⚠ Der Fingerabdruck ist ABSICHTLICH keine zweite Identitäts-Wahrheit.**
  Verglichen werden Rolle + Kommunikationsart + die GANZE kanonisierte Verbindung
  (ohne `interval_s` — die Kopie, die die Übernahme selbst hineinschreibt, und die
  die Box nie in der Verbindung meldet). Ein Java-Zwilling von
  `sources.TransportIdentity` würde von ihr abdriften; eine OBERMENGE kann
  höchstens einen legitimen Re-Pin verpassen (dann greift der manuelle Weg), nie
  einen falschen herstellen.
- **Ausgelöst vom BESTEHENDEN Takt** (`ComponentAdoptionRunner.heal()`, vor der
  Übernahme, `voltpilot.components.adoption.*`): kein neuer Zuhörer, **kein neues
  per Vorgabe ausgeschaltetes Flag**, das im gitops-Repo nachgezogen werden müsste
  (die dokumentierte OTA-Listener-Falle). Er betrachtet — anders als die Übernahme
  — auch PORTAL-verwaltete Anlagen, denn genau dort ist der Riss entstanden; die
  Kandidatenabfrage ist ein schmaler Scan über Anlagen, die tatsächlich einen
  verwaisten Pin UND eine meldende Box haben.
- **Der Push gehört dazu:** der Pin reist im Registry-Push (`edge_source_id`,
  D-17), mit dem die Box ihre eigenen Quellen-Messwerte auf die Entität abbildet —
  ein Re-Pin, den das Gerät nie erfährt, bliebe auf `:8484` die alte Zuordnung.
  Best-effort wie jeder andere Push.
- **⚠ Bekannte Grenze, und sie folgt aus der dritten Regel:** eine Komponente, die
  über den U2-Dialog („als Entität übernehmen") adoptiert wurde und deren Anlage
  NIE die Bestands-Übernahme durchlaufen hat, trägt gar keine
  `connection_json` — sie hat also nichts, woran ein Gerät wiederzuerkennen wäre,
  und bleibt sichtbar verwaist für den manuellen Weg. Der Herzogau-Fall ist davon
  nicht betroffen: die Übernahme schreibt die Anbindung, BEVOR die Box ihre
  Kennungen neu ableitet. Auf Marke/Modell auszuweichen hilft nicht — zwei
  baugleiche Fronius wären damit ununterscheidbar und fielen ohnehin in die
  Mehrdeutigkeits-Regel.
- **Beweise:** rein `ComponentRebindTest` (10: der Herzogau-Fall, lebende Bindung
  unberührt, Mehrdeutigkeit in beide Richtungen, fremdes Gerät, andere Rolle,
  fehlende Anbindung, `interval_s`, Schreibweisen) · Testcontainers
  `ComponentAdoptionApiTest.aBrokenBindingHealsItselfOnTheNextHeartbeatWithoutGuessing`
  (echte DB + Keycloak, echter Herzschlag-Zuhörer: Übernahme → Umbenennung →
  beide Pins verwaist → ein Takt heilt beide an IHR eigenes Gerät → der zweite
  Takt tut nichts → der Pin reist im Push) + `anAmbiguousRenameIsLeftToTheOperator`.
  Beide Hälften sind mutationsgeprüft.

