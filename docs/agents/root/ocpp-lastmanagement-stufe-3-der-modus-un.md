# OCPP-Lastmanagement Stufe 3: der MODUS und die Konfiguration aus dem Portal

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 134).


Der eigenständige Modus als Regal-Profil, die Ableitung, die eine Nur-Ladepunkte-
Anlage anders aussehen lässt, und der EINE Weg, auf dem eine Zahl aus dem Portal
zur Box kommt (Konzept §5.2, PR 11/12). Alles additiv.

- **Viertes Regal-Profil `lastmanagement`** (`SiteProfileCatalog`), und es ist
  das erste OHNE Strategie-Knoten: Lastmanagement ist SCHUTZ, keine
  Marktteilnahme — es gibt nichts freizuschalten (`gatedNodeTypes` leer) und
  keinen Starter-Flow zu säen. **⚠ Ein `strategyType == null` heißt: erst
  prüfen, DANN fragen** — `Set.copyOf`/`Set.of` werfen bei `contains(null)` eine
  NPE, und das hätte das GANZE Regal jeder Anlage in einen 500 gerissen (im
  Testlauf genau so aufgefallen). Es ist ABGELEITET aktiv, sobald die Anlage
  einen Ladepunkt hat: eine Anlage, die Autos lädt, deren Karte aber „aus" sagt,
  wäre eine Falschaussage über eine laufende Anlage.
- **Fünftes AE7-Nutzungsprofil `laden`** (die DREI Zwillinge + `usage-profile-vectors.json`
  zusammen geändert — die dokumentierte Disziplin): abgeleitet, wenn Ladepunkte
  da sind, aber weder Speicher noch PV; Vorrang unverändert
  `peak > arbitrage > laden > private`, die Regel ist also strikt additiv (sie
  greift nur, wo bisher `private` herauskam). **`laden` ist das EINZIGE Profil
  mit `money: hidden`** — genau dafür ist es ein eigenes: ein Ladepark erzeugt
  nichts und rechnet nichts ab (Scope-Zaun E4, Mockups §2: kein einziger Euro
  auf der ganzen Fläche), der Held ist das Budget-Band (`peak: prominent`), und
  ein Energiefluss hätte ohne Erzeugung nichts zu zeigen. Wie `private` ist es
  ABGELEITET und nie wählbar.
- **Die Anschlussgrenze wird im PORTAL gepflegt** (`site_charging_config` +
  `site_charge_point_priority`, Migration `V20260829000000`, RLS): der
  Aktivieren-Dialog fragt genau die EINE Zahl ab, die dem Kunden gehört
  (Captain-Entscheid), plus die Vorrang-Wahl je Säule. Sicherheitsabstand,
  Mindestleistung und höchste Gebäudelast bleiben Einstellungen der BOX („von
  VoltPilot eingerichtet"). Der Vorrang ist eine MENGE, und die ANWESENHEIT der
  Zeile IST die Aussage (das `device_control_activation`-Muster).
- **Verteilweg: retained (QoS1) auf `ems/{t}/{s}/{d}/v2/charging-config`**
  (Kontrakt `docs/contracts/mqtt-charging-config.schema.json` + 3 Fixtures), im
  `v2/#`-Teilbaum der per-Gerät-ACL — **keine Broker-Änderung**. Retained ist der
  ganze Mechanismus: eine Box, die beim Speichern offline war, holt ihre Grenze
  beim nächsten Verbindungsaufbau selbst ab. Leere Nachricht = Rücknahme
  (Unclaim räumt sie ab — nur den Slot, KEINE Zeile: der Aufruf läuft in der
  Unclaim-Transaktion auf dem `@Primary`-Pfad, und ein Löschen von der
  BYPASSRLS-Verbindung aus liefe in die bei der Steuerungs-Freigabe
  dokumentierte Selbst-Blockade).
- **⚠ PATCH-Semantik trägt den Vertrag: ein ABWESENDES Feld behält den Wert der
  Box** — ein Dokument, das jedes Feld immer sendet, setzte beim ersten Speichern
  still zurück, was ein Betreiber auf `:8484` gepflegt hat. Eine LEERE
  Vorrang-Liste ist dagegen eine AUSSAGE („keine Säule hat Vorrang") und wird
  angewandt. Eine Grenze ≤ 0 wird auf BEIDEN Seiten abgelehnt (400 bzw.
  verworfen): ohne Grenze ist das Budget 0 und es lädt nichts — das wäre eine
  Aussage, die niemand treffen wollte.
- **Bekannte Grenze:** die Box bleibt auf `:8484` editierbar, es gilt also
  last-writer-wins, und ein retained Dokument setzt sich beim nächsten
  Verbindungsaufbau wieder durch. Ein `portal_managed`-Spiegel wie beim
  Einheitsmodell Stufe 2 ist Folgearbeit.
- **Der Kommando-Verlauf hat einen fünften Strom `ladepunkt`** (Migration
  `V20260830000000` weitet nur den CHECK — es entsteht KEINE Tabelle, dieselbe
  Form wie die `consumer_audit_event`-Erweiterung): je SÄULE eine laufende
  Periode über die Grenze, die die Box ihr hinterlegt hat. **Je Säule, nicht je
  Stecker** — der Schlüssel der Tabelle ist eine Komponenten-Id, und eine Zeile
  je Stecker vervielfachte den Verlauf, ohne eine Frage zu beantworten, die die
  Ladevorgangs-Liste nicht schon beantwortet. Eine Säule OHNE Komponente wird
  ausgelassen statt mit einer erfundenen Id geführt.
- **Beweise:** `ChargingConfigPublisherTest` (6, rein: die Draht-Form, abwesend
  vs. leer, die Kontrakt-Fixture) · `ChargerApiTest` (+1: der Dialog speichert,
  PATCH lässt die Grenze stehen, unbekannte Säule + Grenze 0 sind 400 OHNE
  Wirkung, das Regal-Profil folgt der Anlage, Mandanten-Zaun auf beiden Verben) ·
  Edge `internal/chargingcfg` (7, inkl. der Fixtures PER PFAD) +
  `agent/charging_config_test.go` (3: PATCH, fremdes/kaputtes Dokument ändert
  nichts, eine Box ohne OCPP überlebt es).

