# Steuerung Stufen 8+9: die Umzüge im Portal

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 21).


Die Fläche der Abschluss-Stufen (Regeln, Katalog und Migration stehen in der Root-`AGENTS.md`
„Steuerung Stufen 8+9"). Alles ist ADDITIV bzw. reine Umbenennung; **eine Anlage ohne die
betroffenen Zeilen rendert zeichengleich wie vorher** (`migration.test.ts`).

- **⚠ „Eigene Auswertung" hat KEIN Tor mehr — das ist ein ersatzloses ENTFERNEN.**
  `useCockpitLayout` hatte den Eingang `eigeneAktiv` und trennte `alleEigene` (wandert immer ins
  Dokument) von den sichtbaren; beides ist weg. Der Knopf „+ Eigene Auswertung" steht im
  Anpassen-Modus IMMER, ohne vorheriges Einschalten, und `AnlagenPage` liest die Regal-Karten
  nicht mehr (der Grund, aus dem es sie überhaupt holte). `anwendungen.istCockpitGesteuert` ist
  die Lese-Schicht der neuen Klasse; sie urteilt über eine UNBEKANNTE Id nie „ja".
- **„Komponenten & Regeln" heisst überall „Komponenten"** — Nav-Titel (`anlageNav.ANLAGE_TABS`),
  Karten-Kopf, Zustands-Hebel (`health.LEVERS.device.label`), Rückwege der Geräte-/Box-Seite,
  der Baukasten-Ausweg und die Katalog-Leerzustände. **⚠ Die Nav-Id `modell` und JEDE Route
  bleiben unverändert** — es ist die Anzeige, nicht die Adresse.
- **`src/steuerungAufmerksamkeit.ts` (rein) ist das Nav-Abzeichen**: `aufmerksamkeit(input)`
  zählt laufende Handeingriffe (inkl. der Anlagen-Pause) + Regeln, die die Automatik bremsen,
  `aufmerksamkeitTitel` schreibt den Grund. **⚠ Ein abgelaufener Eingriff zählt nicht** (die
  §16-Regel „ein verfallener Wunsch ist abwesend"), und ein Anspruch OHNE `claimedAt` zählt
  trotzdem — er ist der Beleg, der Zeitstempel nur seine Beschriftung.
  - **⚠ VORSCHLÄGE sind bewusst NICHT gezählt** (an firstmate gemeldet): sie kosten drei weitere
    Abrufe je Anlagen-Wechsel, und ein Abzeichen, das erst nach dem Besuch der Seite erscheint,
    wäre unehrlicher als keines. Die Schale übergibt `vorschlaege: null`; das Feld existiert,
    damit eine spätere Server-Zahl es ohne Umbau füllen kann.
  - **⚠ `SidebarItem.badgeTitel` ist der Grund, nicht die Zahl** — `NavItem` setzt ihn als
    `title` („Steuerung — 1 Handeingriff läuft"). Ein nacktes „2" beantwortet nichts, und die
    alte `activeModeCount`-Bedeutung ist als Rückfall erhalten (ein Aufrufer ohne das Argument
    bekommt zeichengleich das frühere Verhalten).
- **`src/steuerungIntro.ts` + `components/SteuerungIntro.tsx` sind der Erklärkasten** (drei Zonen
  in drei Sätzen, einmal wegklickbar, **je ORGANISATION** gemerkt). **⚠ Er benutzt weder
  `localStorage` noch `sessionStorage`** — die Marke liegt server-seitig im freien
  `tenant/eigen/cockpit`-Fach von `cockpit_layout` (`mitGesehen` ist additiv und dedupliziert).
  Solange das Dokument `undefined` ist, rendert er NICHTS (fail-soft = bleibt versteckt); das
  Wegklicken wirkt SOFORT, das Speichern ist best-effort.
- **`copy.test.ts` verbietet „Anwendung/Anwendungen" in Kundenflächen** und scannt zusätzlich die
  Preset-Sätze/Baustein-Labels des Katalogs (er liegt als JSON, der Datei-Walker erfasst ihn
  sonst nicht; die `_comment`-Blöcke bleiben ausgenommen). **Wer eine Kunden-Zeile schreibt,
  sagt „Betriebsmodell".**

