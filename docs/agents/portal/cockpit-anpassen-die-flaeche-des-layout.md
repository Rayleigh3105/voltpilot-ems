# Cockpit anpassen: die Fläche des Layout-Speichers (Anwendungs-Programm Stufe 3)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 14).


Die Portal-Hälfte des Layout-Speichers (Backend, Schema und die vier Schichten stehen im
Wurzel-`CLAUDE.md` „Cockpit anpassen"). Alles ist additiv: **eine Anlage ohne gespeicherte Zeile
rendert Zeichen für Zeichen wie vorher** — bewiesen am echten DOM in
`pages/AnlagenPage.test.tsx` („rendert OHNE gespeicherte Zeile Zeichen für Zeichen dasselbe wie
ohne die Route", zwei DOMs verglichen).

- **Der Stapel entsteht seither aus einer AUFGELÖSTEN REIHENFOLGE, nicht mehr aus einer hart
  codierten JSX-Folge.** `pages/AnlagenPage.tsx` baut eine Karte `bausteinNodes: Record<BausteinId,
  ReactNode>` und rendert `layout.resolved.order.map(...)`. Wer einen neuen Cockpit-Baustein
  einführt, trägt ihn an DREI Stellen ein: den Katalog (`anwendungen/catalog.json` `bausteine`),
  beide kanonischen Listen (`cockpitLayout.ts`) und diese Karte — sonst steht er im Anpassen-Modus,
  rendert aber nichts.
- **⚠ `verfuegbar` ist die EHRLICHKEITS-Grenze.** Ein Baustein ist verfügbar, wenn diese Anlage ihn
  wirklich hat (Block vorhanden, Zeile nicht null, Widgets nicht leer) — was keine Quelle hat, ist
  gar nicht erst anordenbar. Eine Präferenz über einen gerade fehlenden Baustein bleibt trotzdem
  GESPEICHERT (die Server-Regel), sie wird beim Rendern nur still übersprungen.
- **⚠ Zwei kanonische Listen, nicht eine** (`CANONICAL_DESKTOP` / `CANONICAL_PHONE`): am Telefon
  führen Fahrplan und Preis als Zeilen, am Rechner die Kacheln — die abgenommene Entscheidung des
  Mobil-Umbaus. `layoutResolve` bekommt die passende als PARAMETER; der gespeicherte Wille nennt nur
  relative Reihenfolge, also gilt dieselbe Anordnung auf beiden Fassungen. **Beide Listen stehen
  wörtlich in `migration.test.ts`** — sie sind der Wächter über das Bestandsverhalten.
- **⚠ Die Mobil-Dedupe (`mobileWidgets`) läuft NACH der Auflösung**, wie der Stufenplan verlangt:
  sie entfernt Kacheln, deren Aussage am Telefon schon woanders steht, und darf die Baustein-Menge
  nicht vorab beschneiden.
- **Der Anpassen-Modus ist INLINE am Rechner und eine LISTE am Telefon** (E4,
  `components/CockpitAnpassen.tsx`): am Rechner bekommt jeder Baustein eine Steuerzeile ÜBER seinem
  echten Inhalt (`AnpassenHuelle`) — der Kunde sieht beim Anordnen, was er anordnet; auf 375 px wäre
  ein Overlay über einem Diagramm nicht bedienbar, dort steht `AnpassenListe`. Die Zeile
  „Ausgeblendet (n)" bleibt in beiden Fassungen erreichbar: ausblenden darf kein Weg ohne Rückweg
  sein.
- **⚠ Barrierefreiheit ist hier die Bedienform, kein Zusatz: es gibt KEIN Drag-and-Drop.** Die
  Reihenfolge ändert man mit ▲/▼ — echten Knöpfen, die Tastatur, Screenreader und Touch gleich gut
  bedienen; `anpassenZeilen` liefert `kannHoch`/`kannRunter` dafür. Ein Layout-Editor, den man nur
  mit der Maus bedienen kann, ist für einen Teil der Kunden gar keiner.
- **⚠ Der Stern ist ein SCHALTER, kein Einweg-Knopf**: ein zweiter Klick nimmt die Hervorhebung
  zurück und überlässt sie wieder der M0-Regel (peak → Geld → Fluss). Ohne den Rückweg käme ein
  Kunde, der einmal umgestellt hat, nur über „Zurücksetzen" zurück — und das verwürfe auch seine
  Reihenfolge. Er erscheint nur an den Bausteinen mit `lead_block` (Energiefluss, Erlöse); führt ein
  KACHEL-Block (peak-band, lade-budget), ist kein Stern erleuchtet, und das ist ehrlich — nichts
  behauptet etwas anderes.
- **⚠ Kopf und Bühne tragen ihre Zeile, obwohl sie am Rechner keinen eigenen Stapel-Knoten haben**
  (`ortsHinweis` nennt den Ort): der Status-Kopf steht über dem Stapel, Geld-Leiste und
  Steuerungs-Fuß wohnen IN der Bühne. Ohne ihre Zeile wären sie am Rechner die einzigen Bausteine,
  die man nicht ausblenden oder hervorheben kann — und der Kunde suchte einen Knopf, den es nur am
  Telefon gibt.
- **Der Reset SAGT, worauf er fällt** (`resetZiel`, E2): auf die Vorgabe des Betreibers, auf den
  Standard des Profils oder auf den VoltPilot-Standard. Ein Admin bekommt zusätzlich den sichtbaren
  Schalter „Als Vorgabe speichern" (VORGEWÄHLT — er handelt als Betreiber) und das Band
  `vorgabeBand`.
- **Fail-soft ist tragend** (`useCockpitLayout`): ein älteres Backend oder ein Netzfehler führt zu
  `layers = null` und damit zur Auflösung OHNE Schicht — dem deterministischen Katalog-Standard. Das
  Cockpit darf an seinem Layout-Speicher nie scheitern.
- **Hausregel gewahrt:** der Speicher ist SERVER-seitig, `cockpitLayout.ts`/`useCockpitLayout.ts`
  benutzen weder `localStorage` noch `sessionStorage` (in `migration.test.ts` festgenagelt) — der
  Admin gestaltet für den Kunden, also muss die Ablage RLS-gefenced sein.
- **Neue Design-System-Icons:** `eye`, `eye-off`, `star` (Lucide-Pfade in `designsystem/components/
  core/Icon.jsx` + `.d.ts`). Der Anpassen-Modus benutzt so wenig Unicode-Glyphen wie jede andere
  Fläche.
- **Beweise:** `src/cockpitLayout.test.ts` (35, rein) · `src/migration.test.ts` (+5) ·
  `pages/AnlagenPage.test.tsx` (+7: Bestands-Gleichheit, der Knopf erst mit Stapel, ausblenden +
  erreichbar + gespeicherte Absicht, Pflicht ohne Auge, Tastatur-Umordnung mit stehender Bühne,
  Reset-Ansage, Admin-Schalter). Im echten Chrome bei 1440 px und 375 px durchgespielt (anordnen,
  ausblenden, hervorheben, speichern, neu laden, zurücksetzen): 0 px horizontaler Überlauf, 0
  überstehende Elemente, keine Konsolenmeldungen.

