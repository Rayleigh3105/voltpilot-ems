# Cockpit anpassen: der LAYOUT-SPEICHER mit drei Schichten (Anwendungs-Programm Stufe 3)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 120).


Captain-Entscheide **E1** (Layout an der Anlage + optionale kunden-weite Betreiber-Vorgabe, die
Anlagen-Vorgabe gewinnt) · **E2** (Kunde gewinnt: Eigen > Vorgabe > Preset > Katalog; Pflicht-
Bausteine sind KATALOG-Eigenschaft, keine Admin-Sperre in V1; Layout je ORGANISATION; der Reset
SAGT, worauf er fällt) · **E4** (Inline-Anpassen-Modus auf dem Cockpit; am Telefon eine Liste
derselben Bausteine), alle vom 24.08.2026. Bis hierher war die Komposition des Cockpits
deterministisch und UNGESPEICHERT — `cockpitBlocks` + `BLOCK_ORDER` + `leadSlot` entschieden alles,
es gab weder Editor noch Ablage. **Alles ist additiv: eine Anlage ohne Zeile in `cockpit_layout`
rendert Zeichen für Zeichen wie vorher**, und das ist zweifach festgenagelt (rein in
`migration.test.ts`, am DOM in `pages/AnlagenPage.test.tsx`).

- **`cockpit_layout` (Migration `V20260839000000`) ist SCOPE-GENERISCH von Anfang an** (E1 + die
  Stufe-4-Vorbereitung): `scope_kind` trägt `site` (das Anlagen-Cockpit) und `tenant` (die
  kunden-weite Vorgabe), `surface` ist für `portfolio` vorbereitet, `layer` ist `vorgabe|eigen`.
  Mandantengebunden mit RLS + FORCE wie `site_profile_state` — das sind KUNDENDATEN; die App-Rolle
  braucht hier auch **DELETE, denn der Reset IST ein Löschen**. `updated_by` ist die Papier-Spur
  (das `site_forecast_model_choice`-Muster). Bewusst KEIN Fremdschlüssel auf `site` (die Spalte
  zeigt je nach Art auf zwei Tabellen) — deshalb räumt `SiteController.deleteSite` sie mit ab.
- **⚠ GESPEICHERT WIRD NUR ABSICHT, nie die Fläche** (die M3-Regel von `site_profile_state`,
  wörtlich übernommen). Welche Bausteine eine Anlage hat, bleibt Anwendungen × Fähigkeiten und wird
  bei jedem Rendern neu abgeleitet. Daraus folgen die zwei tragenden Eigenschaften: keine Zeile =
  das heutige Verhalten, und **ein Baustein, dessen Anwendung gerade nicht aktiv ist, wird STILL
  übersprungen, seine Präferenz bleibt gespeichert** — ein späteres Wiedereinschalten stellt das
  alte Bild her.
- **⚠ Deshalb lehnt der Schreibpfad einen momentan NICHT VERFÜGBAREN Baustein ausdrücklich NICHT
  ab** (eine argumentierte Abweichung vom Auftrags-Wortlaut „lehnt … für diese Anlage nicht
  verfügbare Bausteine ab"): ein Gate auf die momentane Verfügbarkeit zerstörte genau die Regel
  darüber, und der Server weiß ohnehin nicht, was die Fläche gerade rendert. Geprüft wird die FORM
  (`CockpitLayoutService.validate`): unbekannter Schlüssel · Baustein einer anderen Fläche ·
  Pflicht-Baustein in `hidden` · doppelte Nennung · ein nicht lead-fähiger `lead` — je ein **400 mit
  deutschem Grund, und keine Zeile wird geschrieben**.
- **Der BAUSTEIN-KATALOG wohnt im EINEN Anwendungs-Katalog** (`anwendungen/catalog.json`,
  top-level `bausteine`; §3.2 C „abgeleitet aus A, keine zweite Datei"), Portal-Kopie byte-gleich
  gepinnt. Je Baustein: `pflicht` (nie ausblendbar — **nur `status` und `zustand`**), `beweglich`
  (false = bleibt an seiner kanonischen Stelle), `lead_block` (die `CockpitBlockId`, die sein Stern
  setzt) und `bloecke`. **`beigesteuertVon` wird ABGELEITET** (`bloecke` × den Cockpit-Bausteinen
  der Anwendungen), nie ein zweites Mal aufgeschrieben.
- **⚠ Die KANONISCHE Reihenfolge steht bewusst NICHT im Katalog, sondern im Portal**
  (`cockpitLayout.ts` `CANONICAL_DESKTOP` / `CANONICAL_PHONE`): sie ist je Bildschirmbreite
  verschieden (am Telefon führen Fahrplan und Preis als Zeilen — eine abgenommene Entscheidung des
  Mobil-Umbaus), und der gespeicherte Wille nennt nur RELATIVE Reihenfolge. Der Server braucht sie
  nicht, um einen Schlüssel zu prüfen. **Beide Listen sind der Wächter über das Bestandsverhalten
  und stehen wörtlich in `migration.test.ts`** — wer sie ändert, ändert das Cockpit JEDER
  Bestandsanlage.
- **⚠ Der Kopf und die BÜHNE sind unbeweglich** (`beweglich: false` für `status`, `energiefluss`,
  `geld`, `steuerung`): am Rechner wohnen Geld-Leiste und Steuerungs-Fuß IN der Bühne, und der
  Stufenplan verlangt ausdrücklich, dass ein Lead-Wechsel sie nicht zerlegt. `layoutResolve.pinFixed`
  setzt sie nach JEDER Schicht an ihre kanonische Stelle zurück — auch ein handgeschriebenes
  Dokument kann sie nicht verschieben. Ihre ZEILE erscheint im Anpassen-Modus trotzdem (mit
  `ortsHinweis`), sonst wären sie am Rechner die einzigen Bausteine, die man nicht anfassen kann.
- **Die Auflösung ist rein** (`frontend/portal/src/cockpitLayout.ts` `layoutResolve`, Docker-frei
  getestet — das `Tagesprotokoll`/`FleetPflege`-Muster): Katalog → Preset (`site.profil`) →
  kunden-weite Vorgabe → Anlagen-Vorgabe → Eigen. Jede Schicht setzt an: `order` relativ
  (**ungenannte Bausteine an ihrer KANONISCHEN Stelle, nicht hinten** — so erscheint der Baustein
  einer frisch aktivierten Anwendung dort, wo er hingehört), `hidden` addiert, **`shown` nimmt einer
  TIEFEREN Schicht ihr `hidden` zurück** (ohne das könnte ein Kunde die Vorgabe seines Betreibers
  nie zurücknehmen — und eine Sperre gibt es in V1 nicht), `lead` ersetzt. Ein leeres Dokument ist
  KEINE Schicht. Die Mobil-Dedupe (`mobileWidgets`) läuft unverändert NACH der Auflösung.
- **⚠ Es gibt bewusst KEIN `GET /surface`** (BUILD.md §4.1): der Server hält Katalog und Absicht und
  liefert ALLE Schichten GETRENNT — nur so kann die Fläche sagen, worauf ein „Zurücksetzen" fällt
  („auf die Vorgabe Ihres Betreibers" / „auf den VoltPilot-Standard", `resetZiel`).
- **Rechte an EINER Stelle** (`SiteCockpitLayoutController.requireVorgabeRecht`): `eigen` schreibt
  der Kunde über den RLS-gefencten Pfad (kein `@PreAuthorize`, fremde Anlage **404, nie 403**),
  `vorgabe` nur ein `platform-admin` über den `X-Tenant-Id`-Umschalter — eine METHODEN-Prüfung, kein
  zweiter Datenpfad. Ein Admin schreibt **standardmäßig die Vorgabe** (er handelt als Betreiber);
  der Support-Fall „als Kunde anpassen" ist derselbe Aufruf mit `layer=eigen`, sichtbar als Schalter.
  Kommt eine Betreiber-Rolle, hängt sie sich genau dort ein.
- **Routen** (in `openapi.yaml`, tag `profile`): `GET/PUT/DELETE
  /api/v1/sites/{siteId}/cockpit-layout?layer=` und `GET/PUT/DELETE /api/v1/tenant/cockpit-layout?layer=`.
  Die Mandanten-Route trägt **keine `{tenantId}`-Variable** — der Mandant kommt aus dem validierten
  Token bzw. dem Umschalter; ein Admin ohne gewählten Kunden bekommt 404.
- **Das Preset ist die zweite Schicht** (`presets[].layout` im Katalog) und bewusst MINIMAL:
  `privat` hebt den Energiefluss hervor, **`gewerbe` sagt NICHTS** und lässt damit die M0-Regel
  peak → Geld → Fluss stehen. Ein Preset, das viel umstellt, macht den Reset-Knopf zu einer
  Überraschung.
- **Beweise:** rein `frontend/portal/src/cockpitLayout.test.ts` (35) + `migration.test.ts` (+5) +
  Java `cockpit/CockpitLayoutServiceTest` (8, ohne Docker) · DOM `pages/AnlagenPage.test.tsx` (+7,
  u. a. **„rendert OHNE gespeicherte Zeile Zeichen für Zeichen dasselbe wie ohne die Route"**) ·
  Testcontainers `CockpitLayoutApiTest` (3: die Reise Kunde/Admin mit beiden Schichten nebeneinander,
  Reset als DELETE, alle fünf Form-Ablehnungen ohne Schreibvorgang, die NICHT-Ablehnung des gerade
  fehlenden Bausteins, RLS 404 + anonym 401). Fläche und ihre Regeln: `frontend/portal/AGENTS.md`.
- **Ops:** keine neue Pflicht-Variable, kein Flag. Portal-Seite fail-soft — ein älteres Backend
  (Route unbekannt) oder ein Netzfehler führt zur Auflösung OHNE Schicht, also zum Katalog-Standard.
- **NICHT in dieser Stufe:** das komponierte Portfolio-Cockpit (Stufe 4 — es baut auf demselben
  `scope_kind='tenant'`/`surface='portfolio'` und auf `layoutResolve` auf, die deshalb
  scope-generisch sind) · eigene Kacheln aus Messwerten (Stufe 5, seither GEBAUT — sie leben in
  `document.custom`, siehe „Eigene Auswertung") ·
  eine Admin-Sperre einzelner Bausteine (E2: ausdrücklich nicht in V1; additiv nachrüstbar).

