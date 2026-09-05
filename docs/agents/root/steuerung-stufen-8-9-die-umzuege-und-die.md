# Steuerung Stufen 8+9: die UMZÜGE und die Datenbereinigung

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 159).


Der Abschluss des Steuerungs-Umbaus (Konzept `data/vp-steuerung-konzept-b3` §5 Stufen 8+9;
Portfolio/Nav `data/vp-portfolio-konzept-r2` §5.5/§8 S8). Sie räumt auf, nachdem alles Neue
steht: was einen Wohnort bekommen hat, verliert seinen alten, und was seit Paket 1 keine
Bedeutung mehr trägt, wird gelöscht. **Für eine Anlage ohne die betroffenen Zeilen ist alles
byte-identisch** (Portal `migration.test.ts` „Steuerung Stufen 8+9").

- **⚠ FÜNFTE Katalog-Klasse `cockpit`, und sie ist NICHT `basis`.** `eigene-auswertung` ist von
  `regel` auf `cockpit` gewechselt (`anwendungen/catalog.json`, beide byte-gleichen Kopien,
  `catalog_version` 1.3.0): sie hat keinen Schalter mehr, aber nicht weil sie immer läuft,
  sondern weil sie **AN EINEM ANDEREN ORT gesteuert wird** — im Cockpit unter „Anpassen".
  `SiteProfileService.setState` lehnt sie deshalb mit einem EIGENEN 400 ab, der den WEG nennt
  („… im Cockpit unter „Anpassen" legen Sie eine eigene Kachel oder einen eigenen Verlauf an"),
  statt „ist immer an" zu behaupten. Ihr `preset` steht in BEIDEN Profilen auf `abgeleitet` —
  ein Preset kann sie nicht wählen. `AnwendungKatalog.KLASSE_COCKPIT`/`Anwendung.istCockpit()`
  und der TS-Zwilling `anwendungen.istCockpitGesteuert` sind die Leser.
  - **⚠ „Anlage beobachten" (`monitoring`) bleibt BEWUSST `basis`.** Sie läuft wirklich immer
    und hat schon vorher keinen Schalter gehabt (`abschaltbar:false`, `regal:false`) — ihre
    Klasse zu wechseln änderte nur den Ablehnungs-SATZ, nicht das Verhalten. Nur die Anwendung
    mit einem anderen WOHNORT wechselt die Klasse.
  - **Der Portal-Effekt ist ein ersatzloses ENTFERNEN eines Tors:** `useCockpitLayout` hatte den
    Eingang `eigeneAktiv` und trennte `alleEigene` von den sichtbaren; beides ist weg, „+ Eigene
    Auswertung" steht im Anpassen-Modus IMMER, ohne vorheriges Einschalten. Damit entfällt auch
    der einzige Leser, für den `AnlagenPage` die Regal-Karten holte.
- **Stufe 9 · Migration `V20260847000000` (DATEN-only, idempotent, prod-safe):** sie löscht die
  `site_profile_state`-Zeilen der Klassen `basis` und `regel` — die vier Ids stehen
  AUSGESCHRIEBEN (`monitoring`, `speicher-fahrplan`, `ueberschuss`, `verbraucher`), weil eine
  angewandte Migration ihre Wirkung nicht von einer Ressource abhängig machen darf, die sich
  morgen ändert. **⚠ Was BLEIBT, ist die eigentliche Entscheidung:** die vier Betriebsmodelle
  (der gespeicherte Kundenwille, an dem Exklusivität und Overlay hängen) UND die
  `cockpit`-Zeile — sie hatte bis Stufe 8 eine ECHTE Wirkung (sie blendete die eigenen Kacheln
  ein und aus), sie zu löschen vernichtete eine Entscheidung, die der Kunde wirklich getroffen
  hat (die „eine Rücknahme ist keine Beweisvernichtung"-Disziplin). Ein Doppel-Wächter hält
  beide Mengen fest: `SiteProfileApiTest.theIntentOnlyProfileStatesAreDroppedAndTheOperating
  ModelsSurvive` (echte DB, die Anweisung in ISOLATION + Idempotenz) und der Katalog-Wächter in
  `migration.test.ts` — wer eine Anwendung in eine der zwei Klassen schiebt, muss die
  Migrations-Liste bewusst mitziehen.
- **„Komponenten & Regeln" heisst überall „Komponenten"** (Nav-Titel, Copy, Katalog-Leerzustände,
  Doku): die Regeln wohnen seit dem Einheitsmodell Stufe 5a in der Steuerung, der Doppelname
  behauptete einen Ort, den es nicht gibt. **Die Nav-Id `modell` und jede Route bleiben** — es
  ist eine Umbenennung der ANZEIGE, kein Routen-Wechsel; jedes Lesezeichen gilt.
- **Das Nav-Abzeichen an „Steuerung" zählt AUFMERKSAMKEIT, nicht Regeln** (`src/steuerung
  Aufmerksamkeit.ts`, rein): laufende Handeingriffe (inkl. der Anlagen-Pause) + Regeln, die die
  Automatik bremsen. **⚠ Ein nacktes „2" ist ein Rätsel**, deshalb trägt `SidebarItem` jetzt
  additiv `badgeTitel` und der Nav-Eintrag seinen Grund im `title` („Steuerung — 1 Handeingriff
  läuft · 1 Regel bremst die Automatik").
  - **⚠ BEWUSSTE ENGE (an firstmate gemeldet): offene VORSCHLÄGE werden NICHT gezählt.** Sie
    bräuchten je Anlagen-Wechsel drei weitere Abrufe (Fahrplan + Verbraucher + Vorschlags-
    Zustände), und ein Abzeichen, das erst NACH dem Besuch der Seite erscheint, wäre unehrlicher
    als keines. Die reine Schicht nimmt das dritte Signal trotzdem entgegen (`vorschlaege`), also
    füllt eine spätere billige Server-Zahl es ohne Umbau; die Schale übergibt heute `null`.
  - Gespeist wird es aus `useAnlageSurface` (zwei zusätzliche fail-soft Abrufe:
    `siteInterventions` + `entityStrategies`) — ohne sie ist das Abzeichen der Zähler von vorher.
- **Der ERKLÄRKASTEN der Steuerung („Drei Zonen, drei Fragen") wird je ORGANISATION gemerkt**
  (`src/steuerungIntro.ts` + `components/SteuerungIntro.tsx`). **⚠ Er braucht KEINEN neuen
  Speicher:** die Marke wohnt in `cockpit_layout` unter `scope=tenant` / `layer=eigen` /
  `surface=cockpit` — ein Feld, das `CockpitLayoutService.forSite` für Mandanten-Zeilen NUR
  unter `layer=vorgabe` liest, und das das Portal sonst nirgends beschreibt. `LayoutDoc`/
  `LayoutDocumentDto`/`LayoutRequest`/`CockpitLayoutRepository` tragen dafür das additive
  `seen: string[]`; **`istLeer()` zählt es bewusst NICHT** (ein Dokument, das nur eine Marke
  trägt, ist keine Layout-Schicht — `saysSomething` im Portal ignoriert es ebenso).
  `localStorage` bleibt verboten. Fail-soft: solange das Dokument nicht geladen ist, rendert der
  Kasten NICHTS, und ein fehlgeschlagenes Speichern schliesst ihn trotzdem.
- **Wortprüfung:** „Anwendung/Anwendungen" kommt in KEINER Kundenfläche mehr vor — `copy.test.ts`
  hat den Eintrag (`\bAnwendung(en)?\b`) und scannt zusätzlich die Preset-Sätze und
  Baustein-Labels des Katalogs. „Anwendung" bleibt das INTERNE Modell und jede Code-Id
  (`AnwendungKatalog`, `anwendungen.ts`, `site_profile_state.profile`, die Route `/profiles`).

