# Der EINE Anwendungs-Katalog (`anwendungen/catalog.json`, Anwendungs-Programm Stufe 1)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 116).


Der beschreibende Teil einer Anwendung — Id, Label, Nutzen-Satz, Voraussetzungen samt ihren
Sperr-Sätzen, beigesteuerte Bausteine, Einstellungen, Starter, Preset-Zugehörigkeit — lag an
**ACHT Stellen in zwei Sprachen** (Konzept `data/vp-portal-zielbild-anwendungen` §2.2), und zwei
Zwillinge waren ungepinnt. Seit dieser Stufe ist er EINE Ressource
`services/api/src/main/resources/anwendungen/catalog.json` mit einer **byte-gleichen Portal-Kopie**
`frontend/portal/src/anwendungen/catalog.json` (`anwendungen.sync.test.ts` + der Java-Zwilling
`AnwendungKatalogTest.thePortalCopyIsByteIdentical` — **beide zusammen ändern**, das
`flowcatalog`-Muster). Die Stufe ist ADDITIV: eine Bestandsanlage rendert byte-identisch
(`frontend/portal/src/migration.test.ts` „Anwendungs-Katalog Stufe 1", drei Fälle).

- **VIER KLASSEN (`klasse`), und sie bestimmen, was ein Schalter TUT.** `basis` = nicht
  abschaltbar (Regal-Zeile „immer an"; ein Schaltversuch ist ein 400 mit deutschem Grund) ·
  `regel` = der Schalter ist reine ABSICHT (kein Gate, kein Starter) · `geschaeft` = wie bisher
  (eigene gated Knoten öffnen + eigenen Starter säen, sofern vorhanden) · `reserviert` =
  `sichtbar: false`, also **keine Regal-Zeile und kein Schalter** — ein Schalter, der nichts
  bewirken kann, wäre eine Zusage, die niemand einlöst. Das Regal führt seither ACHT Einträge:
  `monitoring` · `speicher-fahrplan` (basis) · `ueberschuss` · `verbraucher` (regel) · die vier
  bekannten Geschäfts-Anwendungen; `eigene-auswertung` und `berichte` liegen im Katalog, aber
  nicht im Regal.
- **⚠ Was NICHT in die Ressource wandert: die Aktivierungs-LOGIK.** Sie bleibt Code — rein in
  `profile/AnwendungDerivation` (Docker-frei, ohne Uhr, das `Tagesprotokoll`/`FleetPflege`-Muster)
  und `frontend/portal/src/anwendungen.ts` `derivedAnwendungen` — und ist beidseitig über
  **`docs/contracts/v2/anwendung-vectors.json`** gepinnt (das `usage-profile-vectors.json`-Muster).
  Der Portal-Test fährt zusätzlich den DRITTEN Zwilling `surface.ts activeModes` gegen dieselben
  Vektoren und vergleicht ihn Fall für Fall mit `derivedAnwendungen` — genau die zwei Zwillinge,
  die §2.2 als „ohne gemeinsame Vektor-Datei" gefunden hat. **Regeln und Vektoren zusammen ändern.**
- **Zwei Ehrlichkeitsregeln der Ableitung, beide dokumentiert und gepinnt:** `verbraucher` gilt als
  abgeleitet aktiv, sobald ein AKTIVER Flow den generierten Verbraucher-Executor
  `vp.consumer.reactive` trägt (beweisbar); **`ueberschuss` wird NIE abgeleitet** — eine
  Überschuss-Regel und eine Zeitplan-Regel entstehen beide im Verbraucher-Baukasten und sind
  serverseitig nur an ihrem Bedingungsbaum zu unterscheiden, daraus einen Zustand zu behaupten wäre
  eine Erfindung. Und der Leer-Zustand einer eingeschalteten Regel-Anwendung wird nur BELEGT
  gesagt: erst wenn die Anlage **keinen einzigen** aktiven Flow ohne Strategie-Knoten trägt.
- **`SiteProfileCatalog` ist ERSETZT durch `profile/AnwendungKatalog`** (eine `@Component` wie
  `EntityTypeCatalog`/`FlowCatalog`; die Id-Konstanten sind mitgewandert). `SiteProfileService` hat
  seither KEINE Hand-Tabelle mehr: `requirements`/`unlocks`/`blockedReason` kommen aus dem Katalog,
  die Urteile aus `AnwendungDerivation`. `blockedReason` ist dabei byte-gleich zur früheren
  Index-0-Kaskade: ein IMMER geltender Satz (nur die atypische Netznutzung) schlägt alles, sonst
  gewinnt die ERSTE unerfüllte Voraussetzung mit ihrem eigenen Satz.
- **Portal:** `src/anwendungen.ts` ist die typisierte Lese-Schicht; `surface.ts MODE_LABELS` +
  `manifestFor(...).settings`, `profiles.ts` (Nutzen + Freischaltungs-Chips) und
  `modeSettings.ts SETTING_DEFS.claimedBy` (die Umkehrung von `einstellungen`) lesen alle aus ihr.
  **⚠ EINE bewusste Copy-Vereinheitlichung:** der Markt-Modus heißt seither überall
  **„Marktoptimierung"** — der Server (und damit die Regal-Karte) sagte das schon immer, nur
  `MODE_LABELS` sagte „Marktvermarktung"; zwei Namen für dieselbe Sache direkt nebeneinander waren
  genau die Doppeldeutigkeit, gegen die der Katalog gebaut ist.
- **⚠ `MODE_RANK` bleibt Code und wird NICHT katalog-gespeist.** Der Katalog-`rang` ordnet das
  REGAL, `MODE_RANK` die aktiven Modi der Projektion (Cockpit-Blöcke, Nav-Gruppen) — sie zu
  verschmelzen würde die Reihenfolge einer Bestandsanlage sichtbar ändern. Der Migrations-Wächter
  nagelt beide Mengen fest.
- **Ein Konsistenz-Test verhindert einen Katalog-Eintrag ohne Fläche** (`anwendungen.test.ts`): für
  jede der vier Modus-Arten müssen `bausteine.cockpit`/`ansichten`/`geldstrom` und `einstellungen`
  exakt dem entsprechen, was `surface.ts manifestFor` beisteuert, jede Baustein-Id muss ein
  bekanntes Vokabular treffen, und `einstellungen_verweis` muss zur `home` ihrer Einstellungen
  passen. Für Basis- und Regel-Anwendungen sind die `bausteine` DOKUMENTATION dessen, was die
  Fläche schon heute rendert — **Stufe 1 ändert die Fläche nicht** (Stufe 3 löst das Layout daraus
  auf).
- **⚠ Der Kunden-Copy-Wächter liest den Katalog mit** (`frontend/portal/src/copy.test.ts`): er ist
  ein KUNDEN-Textwohnort, liegt aber als JSON und würde vom Datei-Walker sonst nicht erfasst. Die
  `_comment`-Blöcke sind ausdrücklich ausgenommen (Entwickler-Doku, kein Kundentext).
- **`/overview` meldet endlich `laden`** (§2.7): `OverviewController.usageProfile` stempelte über
  den 7-Arg-Konstruktor `hasChargePoint` auf `false`, konnte also NIE `laden` melden, während
  `GET /sites/{id}/profile` es sehr wohl tut — dieselbe Frage mit zwei Antworten. Der Ladepunkt
  keyt jetzt auf den TYP (`ChargerComponentComposer.TYPE_EV_CHARGER`), wie in
  `UsageProfileService.signals`. Dafür trägt `UsageProfileService` das neue package-private
  `plantSignals(siteId, site)` (AE7-Signale PLUS `hasMeasurement`, in EINEM Durchlauf) —
  `Signals` selbst ist unverändert, sonst hätte sich der AE7-Vertrag samt seiner geteilten Vektoren
  geändert.
- **Beweise:** rein `AnwendungKatalogTest` (8) + `AnwendungDerivationTest` (31, die geteilten
  Vektoren) · Testcontainers `SiteProfileApiTest` (das Regal führt acht Einträge, Basis ist immer
  an und nicht abschaltbar, eine reservierte Anwendung ist von einer unbekannten nicht zu
  unterscheiden, Regel-Anwendungen werden nie erfunden) +
  `PortalApiTest.overviewReportsLadenForAChargePointOnlySiteLikeTheProfileEndpointDoes` · Portal
  `anwendungen.test.ts` (58) + `anwendungen.sync.test.ts` + der erweiterte `migration.test.ts`.
- **NICHT in dieser Stufe:** das Profil-Preset an der Anlage (Stufe 2, siehe den nächsten
  Abschnitt) · der Layout-Speicher (Stufe 3) · das komponierte Portfolio (Stufe 4).

