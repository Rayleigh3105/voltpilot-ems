# Keine Seitenleisten: jede Aufgabenfläche ist das zentrierte `Modal`

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 44).


Captain-Entscheid 04.09.2026, wörtlich: **„search for sidebars. I dont want them in my
project. Every Sidebar should be a modal."** Das rechts einfahrende Design-System-`Drawer`
ist ERSATZLOS in `designsystem/components/shell/Modal.jsx` aufgegangen — dieselbe
Prop-Schnittstelle (`open`/`onClose`/`title`/`icon`/`footer`), derselbe Aufbau
(`.dhead`/`.dbody`/`.dfoot`), also tauschten die 39 Aufrufer in 30 Dateien nur Import und
Namen. Fachlogik, Formulare und Texte sind unverändert; es änderte sich nur, WORIN sie stehen.

- **⚠ Es rendert nach `document.body` (`createPortal`)** — anders als das alte Drawer, das im
  Fluss seines Aufrufers stand. Eine zentrierte Fläche darf nicht am `overflow`/`transform`
  eines Vorfahren hängen. **Folge für JEDEN Test: die Fläche über `screen`/`document.body`
  suchen, nie im Render-Container** (`render(...).container` ist danach leer).
- **Neu gegenüber dem Drawer sind genau zwei Dinge:** die zentrierte Geometrie
  (`width: min(640px, 100%)` im gepolsterten Schleier, `max-height: calc(100dvh - 2rem)`) und
  eine **Fokusfalle** (Tab/Shift-Tab bleiben in der Fläche). Wörtlich ERHALTEN sind der
  Stapel (Escape trifft nur das oberste Modal), die GEZÄHLTE Scroll-Sperre (erst nach dem
  letzten Modal freigegeben), die Fokus-Rückgabe, `onClose` in einer Ref (ein kontrolliertes
  Feld darf den Effekt nicht je Tastendruck abreißen) und die **Telefon-Vollbildform**
  (≤ 720 px: `inset: 0`, Radius 0, Safe-Area-Polster, `.dfoot` gestapelt).
- **⚠ Die Liste der fokussierbaren Elemente wohnt jetzt EINMAL im Design-System**
  (`shell/fokus.js` `fokussierbareElemente`); `src/components/VpPanel.tsx` `fokussierbare`
  reicht sie unter dem eingeführten Namen weiter (Bottom-Sheet, Picker,
  `CenteredConfirmDialog`, `AnlegenDialog`, `OcppWallboxPage`). Die Richtung stimmt (src →
  designsystem), und es gibt keinen zweiten Selektor, der driften kann.
- **Wächter `src/keineSeitenleisten.test.ts`** (mutationsgeprüft): er verweigert den
  Bausteinnamen `Drawer`, die Klasse `vp-drawer` UND jede handgebaute, seitlich verankerte
  Vollhöhen-Fläche (`position: fixed` + `left|right: 0` + `height: 100vh|100dvh`) in `src/`
  und `designsystem/`. **Die drei Ausnahmen sind benannt und tragen kein Formular:** die linke
  HAUPTNAVIGATION der Schale (`.vp-sidebar`, `shell/Shell.css`), das Desktop-Rail des
  Messwerte-Explorers (`.vp-verlauf-rail`) und das `BottomSheet` (die Telefon-Form von UNTEN).
- **Die Dateinamen `*Drawer*.tsx` sind ABSICHTLICH geblieben** (`CreateSiteDrawer`,
  `DeviceDrawers`, `RegelDrawer`, …): das Umbenennen von 30 Dateien samt ihrer Tests und
  Importe ist ein eigenes, rein mechanisches Folgepaket — es hätte den Diff dieser Runde
  verdeckt, in dem es um das VERHALTEN geht.

