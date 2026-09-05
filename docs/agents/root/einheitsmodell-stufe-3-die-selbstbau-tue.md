# Einheitsmodell Stufe 3: die SELBSTBAU-TÜR — der Kunde legt sein eigenes Modbus-Gerät an

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 28).


Die dritte Tür des Assistenten (Konzepte `vp-modbus-baukasten-k6` §2.2/§2.3/§2.6 und
`vp-komponenten-einheit-h2` §4.1 Tür c, Stufenplan Stufe 3). Der Kunde beschreibt sein Gerät
selbst — Adresse, Register, Messwerte — und SIEHT beim Anlegen echte Werte. Alles ist ADDITIV:
eine Anlage ohne selbst gebautes Gerät verhält sich zeichengleich wie vorher.

- **⚠ DER BESITZER-ZAUN: eine eigene mandantengebundene Tabelle, NICHT `component_template`.**
  Stufe 0a hatte `kind='custom'` reserviert und den Zaun als offene Aufgabe dieser Stufe vermerkt.
  Entschieden wurde gegen die nullbare `site_id` auf der globalen Tabelle; die vier Gründe stehen
  ausführlich in der Migration `V20260818000000__site_component_template.sql`, der tragende ist der
  vierte: (1) zwei Fragen, zwei Lebenszyklen (Aussage über ein PRODUKT vs. Kundendaten); (2) die
  RLS-Form wäre eine ZWEITE, einmalige Semantik („`site_id IS NULL` ist öffentlich"), während jede
  andere RLS-Tabelle des Hauses ohne Mandanten default-deny ist; (3) die Rechte ließen sich als
  GRANT gar nicht ausdrücken (auf globalen Zeilen nur lesen, auf eigenen schreiben) — der Zaun wäre
  wieder Anwendungscode; (4) die Spalten passen nicht aufeinander — `channels` sind hier PFLICHT
  (die Kanal-Liste IST die Vorlage), dort ehrlich NULL. **Folge, die bestehen bleibt:**
  `component_template.kind='custom'` wird von NIEMANDEM geschrieben, und `ComponentTemplateApiTest`
  legt weiterhin von Hand eine solche Zeile an, um zu beweisen, dass sie nie ausgeliefert wird.
- **Die REGELN sind rein** (`components/SelfBuildDefinition`, das `Tagesprotokoll`/`FleetPflege`-
  Muster — ohne DB, ohne Spring, ohne Uhr): LAN-only · Poll-Budget (max. 16 Kanäle, Abstand ≥ 5 s,
  Vorgabe 10) · Kanal-Form mit ABGELEITETEM Slug · Plausibilität als HINWEIS statt Sperre. **Der
  Slug wird nie getippt** — der Kunde benennt einen Messwert, keine Kennung; eine getippte Kennung
  wäre eine zweite Wahrheit über denselben Messwert. ⚠ Die deutsche Umschrift läuft VOR der
  NFD-Zerlegung (andersherum ist das „ä" längst zerlegt und aus „Zähler" wird „zahler" — im Test
  genau so aufgefallen).
- **⚠ DIE LAN-REGEL HAT VIER ZWILLINGE und EINE Vektor-Datei** (`docs/contracts/lan-host-vectors.json`,
  per PFAD gelesen): Go `probe.IsPrivateHost` (kanonisch), Java `SelfBuildDefinition.isPrivateHost`,
  TS `frontend/portal/src/selbstbau.ts`, Palette `vp-palette/lib/private-host.js`. **Alle vier plus
  die Vektoren zusammen ändern.** Es ist eine WHITELIST der Formen, die sich aus der Zeichenkette
  BELEGEN lassen — ein NACKTER Hostname ist deshalb abgelehnt (er wird über die Suchdomänen der Box
  aufgelöst, ist also nicht nachweisbar privat), und die Ablehnung nennt den Weg (die IP eintragen).
  Der Java-Zweig **löst dabei NIE einen Namen auf**: das wäre ein Netzzugriff auf einem
  Validierungspfad und beantwortete die falsche Frage.
- **Der generierte Lese-Flow ist der BESTEHENDE Weg, kein neuer** (`SelfBuildFlowCompiler`): je Kanal
  EIN `vp.modbus.read` mit seinem `{entity_id, channel}`-Mapping, ausgerollt über flowc →
  `upsertGenerated` → retained `v2/flows` → Geräte-Ack. Damit hängt die ganze Kette dahinter
  unverändert (gepufferter v2-Uplink → `telemetry_v2` → Rollups → Historie → Messwerte-Explorer);
  es gibt keine zweite Ingest-Mechanik. Die Flow-Id ist aus der Komponenten-Id ABGELEITET, damit
  jede weitere Fassung DENSELBEN Flow ersetzt statt einen zweiten anzulegen, und die
  Definitions-Fassung IST die Flow-Version (ein Rollback bringt seinen eigenen Leseplan zurück).
- **Vertrags-Entscheid D-21:** `origin` ist jetzt ein diskriminierter `oneOf` aus GESCHLOSSENEN
  Zweigen (`consumer-policy` | `modbus-device`) — beide behalten `additionalProperties:false`, ein
  Dokument kann die zwei Vokabulare also nie mischen. Die Marke schaltet hier NICHTS frei (ein
  Lese-Flow trägt nur freie Bausteine); sie sagt, dass die Plattform den Flow besitzt, damit das
  Portal den Geräte-Assistenten öffnet statt des Flow-Editors. Die D-19-Regel „die Save-API
  verweigert JEDE kunden-gelieferte origin" ist unberührt und deckt jetzt beide Arten.
- **⚠ DER BOX-SCHUTZ, der diese Stufe erst sicher macht** (`componentapply.ParseDriver`):
  `Derive` ist alles-oder-nichts und `roleFor` kennt `modbus-generic` nicht — **ohne den
  `CommunicationSelfBuild`-Skip hätte EIN selbstgebauter Sensor den GANZEN Push scheitern lassen**,
  die Anlage also mit ihrem ersten eigenen Gerät die Anwendung ihres Wechselrichters UND aller
  Quellen verloren. Der Skip sitzt VOR der Marken-Prüfung (ein Selbstbau-Gerät trägt per
  Konstruktion keine Marke); die Konstante ist wörtlich mit der Cloud geteilt. Der Leseplan reist
  ohnehin im FLOW, nicht in `sources.json`.
- **Routen** (`SiteComponentController`, RLS-gefenced wie jede `/sites/**`-Route, fremde Anlage 404):
  `POST …/components/custom/read` („Jetzt lesen" = zugleich der Verbindungstest von Schritt 1) ·
  `POST/PUT/DELETE …/components/custom[/{entityId}]` · `POST …/components/custom/{id}/duplicate` ·
  `GET …/component-templates` + `DELETE …/component-templates/{ref}`. In `openapi.yaml`.
- **Die Verbindungstest-PFLICHT gilt weiter, aber der Beleg hängt an der VERBINDUNG**, nicht am
  Kanal: eine geänderte Skalierung erzwingt keinen neuen Test, eine geänderte Adresse sehr wohl.
  Der Flow wird VOR dem ersten Schreibvorgang kompiliert (das `ConsumerPolicyActivationService`-
  Muster) — eine Komponente, deren Leseplan nicht gebaut werden konnte, verspräche ein Gerät, das
  nichts liefert.
- **⚠ Der COMPILER ist ein harter 503, das VERTEILEN ist best-effort — und die Reihenfolge ist der
  Grund** (im Testlauf als echter Defekt gefunden): `FlowActivationService.republishForSite` meldet
  `false` AUCH dann, wenn gar kein Broker konfiguriert ist (die Vorgabe ohne
  `voltpilot.provisioning.*`) — daraus einen Fehler zu machen wäre eine Aussage über die UMGEBUNG
  statt über die Anfrage, und der Wurf käme NACH dem Schreiben von Definition, Fassung und aktivem
  Flow, behauptete also ein Scheitern über eine Komponente, die es gibt (der nächste Versuch liefe
  in einen 409). Also: alles, was scheitern darf, wird VOR dem ersten Schreibvorgang gefragt
  (Gateway-Gerät → 409 mit dem Satz des Probe-Kanals, Compiler → 503), das Verteilen danach ist
  best-effort mit lautem WARN wie der Registry-Push daneben. Der ehrliche Ort dafür ist das
  dreiwertige Soll/Ist: `unreported` heißt „die Box hat sich noch nicht geäußert", NIE „die
  Änderung ist verloren".
- **⚠ Die ERSTE gespeicherte Fassung ist 2, nicht 1** — `measurement_point.definition_version` steht
  per `DEFAULT 1` und `applyDefinition` zählt hoch. Das ist die Zählung der Stufe-1-Maschinerie,
  die diese Tür wiederverwendet (`ComponentApiTest` erwartet für ihren ersten Anlege-Vorgang
  dasselbe); zwei Bedeutungen von „Fassung 1" wären genau die zweite Wahrheit, die das
  Einheitsmodell vermeidet.
- **Nur „Nur messen" (Sensor).** Der Typ ist `modbus-generic`/measure-only, die Box ist damit
  strukturell unfähig, so ein Gerät zu schalten; Schalten samt Freigabe-Test ist Stufe 4, und bis
  dahin gibt es keinen halben Schreibpfad, den man später absichern müsste. **Bilanz-Ehrlichkeit:**
  ein Selbstbau-Sensor ist ein Topologie-Knoten mit eigenen Messwerten und geht NICHT in die
  Energiebilanz ein — der Assistent sagt das in einem Satz. **⚠ Seit dem 31.08.2026 ist das eine
  REGEL statt einer Zusage:** `topology.DefaultRole` gibt jedem Selbstbau-Typ die Rolle `""`
  (siehe den AE1-Abschnitt). Bis dahin hielt sie nur zufällig — nämlich solange der Kunde keinen
  Kanal `power_kw` nannte; tat er es, entschied die Kategorie `meter` und sein Gerät wurde zum
  Netz-Knoten der Anlage (Scout `vp-portal-box-spiegel-s2`, L5).
- **Beweise:** rein `SelfBuildDefinitionTest` (12, inkl. der geteilten Vektoren) · Testcontainers
  `SelfBuildComponentApiTest` (5: der Besitzer-Zaun in beide Richtungen + „custom nie öffentlich",
  die Reise Lesen→Anlegen→aktiver Flow→Ändern→Löschen, Poll-Budget/Kanal-Form/LAN mit deutschem
  Grund, eine Anlage OHNE verbundenes Gerät wird beim Namen genannt und schreibt nichts,
  RLS 404 auf jeder Route) · Go `componentapply` (der Skip + „nur Selbstbau ⇒
  ErrNoConfiguration") · Portal `selbstbau.test.ts` (20) + `selbstbauBruecke.test.ts` (11) +
  `AnlegenFlow.test.tsx`. Portal-Seite in `frontend/portal/AGENTS.md`.
- **NICHT in dieser Stufe:** Schalten/Sollwert + Freigabe-Test (Stufe 4) · weitere Anbindungs-Arten
  HTTP/MQTT (Stufe 3b) · Vorlagen-Verwaltung (Stufe 6) · Bilanz-Rollen aus dem Baukasten.

