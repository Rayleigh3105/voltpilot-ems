# VpPicker: EIN Picker fuer die ganze Plattform - kein natives `<select>` mehr

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 13).


Konzept `data/vp-picker-system` (Captain-genehmigt 21.08.2026, woertlich: „alle
Picker … eigene Komponenten erstellen wo man drin suchen kann. Ich will nichts
Browser-Standard-Zeug."). Welle 1 = Basis + Datum/Zeit + die Vorzeige-/
Schmerzflaechen; Welle 2 tauscht die restlichen Selects durch, Welle 3 die
Edge-`:8484`-Fassung.

- **Die Anatomie liegt in `components/VpPanel.tsx`** (Ausloeser in Feld-Optik +
  Panel: Verankerung, Kollisions-Umschlag, Bottom-Sheet, Fokus-Falle, Escape,
  Klick-daneben, Wisch-Schliessen). DREI Inhalte teilen sie sich:
  `VpPicker` (Auswahl) · `VpDatePicker` (Tag/Woche/Monat) · `VpTimePicker`.
  Eine vierte Variante haengt sich HIER ein, nie als eigene Schale - sonst
  laufen vier Panels mit der Zeit auseinander.
- **Die REGELN sind rein und Docker-frei geprueft: `src/picker/`** - `suche.ts`
  (Toleranz), `optionen.ts` (Filtern/Gruppieren/Tastatur-Arithmetik/Ansagen),
  `datum.ts` (Kalendergitter, deutsche Formate), `zeit.ts` (Raster + tolerantes
  Lesen). Das ist der Grund, warum der Picker in `src/components/` wohnt und
  nicht in `designsystem/`: der Ordner traegt `.jsx` + handgeschriebene `.d.ts`
  und wird vom `tsc`-Lauf gar nicht erfasst (`tsconfig.json` `include: ["src"]`).
  Die OPTIK kommt unveraendert aus den Designsystem-Tokens.
- **⚠ Die tolerante Suche gibt es GENAU EINMAL** (`picker/suche.ts`). Sie kam
  aus der Modell-Suche (PR 461); `komponentenAssistent.ts` REICHT sie durch
  (`export { … } from './picker/suche'`), damit jeder alte Aufrufer gilt. Wer
  eine zweite Normalisierung baut, laesst dieselbe Eingabe auf zwei Flaechen
  Verschiedenes finden.
- **⚠ KEIN verstecktes natives Element als Kruecke.** Ein `<select hidden>`
  daneben waere eine zweite Wahrheit ueber denselben Wert, und Vorlesesoftware
  faende beide. Wer den Wert in einem `<form>` braucht, nimmt `name` - der
  Picker haengt dann einen reinen `<input type="hidden">` DANEBEN (nicht ins
  Panel: das rendert nur im offenen Zustand).
- **⚠ Das Panel haengt an `document.body`** mit festen Koordinaten, nie
  `absolute` im Feld - die Wirte (`Card`, Tabellen, Seitenleiste) tragen
  `overflow: hidden` (der `RowMenu`-Praezedenzfall).
- **⚠ DER FUND, DEN NUR DER BROWSER ZEIGT: `element.focus()` unter
  `visibility: hidden` ist ein NO-OP.** Das unvermessene Panel stand genau so
  da, das Suchfeld bekam den Fokus nie und die Tastatur-Bedienung war auf dem
  Desktop TOT - waehrend jeder jsdom-Test gruen blieb (jsdom kennt keine
  Sichtbarkeit). Zwei Riegel: der unvermessene Zustand ist `opacity: 0` +
  `pointer-events: none`, und der Fokus WARTET auf die Verankerung
  (`VpPanel.bereit`). Waechter: „das unvermessene Panel bleibt FOKUSSIERBAR" in
  `VpPicker.test.tsx`. **Dieselbe Falle trifft jedes kuenftige Panel.**
- **⚠ Ein Feld oeffnet nicht auf blossen FOKUS.** Der Zeit-Picker tat es und
  riss sich damit selbst wieder auf (Schliessen fokussiert das Feld zurueck) -
  eine Auswahl liess sich gar nicht abschliessen. Geoeffnet wird auf Klick und
  Pfeil-ab; wer mit Tab durch ein Formular geht, will kein Panel je Halt.
- **⚠ Das Zeit-RASTER ist ein VORSCHLAG, keine Validierung.** Getippt wird frei
  (`zeitLesen`: `1830`/`18.30`/`18` → `18:30`/`18:00`), der Wert bleibt
  `HH:MM`. Ein Raster als einzige Eingabe wuerde aendern, WELCHE Werte ein
  Formular annimmt - die Zusage der Umstellung ist das Gegenteil.
- **Die WERTE bleiben ueberall byte-gleich mit dem abgeloesten nativen Feld**
  (`JJJJ-MM-TT` / `JJJJ-Www` / `JJJJ-MM` / `HH:MM`). Deutsch ist nur die
  ANZEIGE. Die Woche beginnt am MONTAG und traegt ihre Kalenderwoche - der
  Browser-Kalender richtet sich nach der System-Sprache und beginnt auf einem
  englischen Rechner am Sonntag.
- **A11y ist Testgegenstand, nicht Beiwerk:** `combobox`/`listbox`,
  `aria-activedescendant`, Pfeile/Pos1/Ende/Bild-auf-ab, Enter, Escape,
  Tippen-zum-Springen, Fokus-Falle, `aria-live`-Trefferzahl. Der komplette
  Durchstich ohne Maus steht als eigener `describe`-Block in
  `VpPicker.test.tsx` und `VpDatePicker.test.tsx`.
- **Ehrlichkeit wie ueberall im Haus:** eine GESPERRTE Zeile bleibt sichtbar und
  nennt ihren Grund (`disabledHint`); Laden/Leer/Fehler werden BENANNT, nie als
  leere Liste gezeigt; die Suche blendet sich unter `SUCHE_AB` (8) Zeilen selbst
  aus; ohne Eingabe bleibt die Reihenfolge des Aufrufers unangetastet.
- **Beweise:** `picker/optionen.test.ts` (33) · `picker/datum.test.ts` (26) ·
  `picker/zeit.test.ts` (15) · `components/VpPicker.test.tsx` (28) ·
  `components/VpDatePicker.test.tsx` (21). Im echten Chrome bei **1440** und
  **375** durchgespielt (Wegwerf-Harness): 0 px horizontaler Ueberlauf, 0
  ueberstehende Elemente, Kollisions-Umschlag am unteren Rand, Sheet am Boden
  mit 62-px-Zeilen und 44-px-Kalendertagen, Wisch-Schliessen, und der
  Tastatur-Durchstich Feld → Suche → Treffer → Enter → Fokus zurueck.

- **Die Vorzeige-Flaeche: der ANLAGEN-Picker der Kopfzeile (Welle 1, Captain-Entscheid 4).** Beide Wechsler (Seitenleisten-Kontextkarte + der Telefon-Ueberzug in der Kopfzeile) sind derselbe `VpPicker` — durchsuchbar, je Anlage ein Gesundheits-Punkt und eine Nebenzeile. Ableitung ist die reine `src/anlagenWahl.ts` (`anlagenWahl.test.ts`).
  - **⚠ Die SCHALE rechnet keine Gesundheit.** `AnlageNav.siteOptions` kommt FERTIG von `App.tsx` — dort liegt beides (Anlagen UND die Geraeteliste samt Bezugszeit), und `anlagenOptionen` geht durch DIESELBE `deviceHealthForSite` → `healthBadge`-Kette wie das Kopfzeilen-Abzeichen. Eine zweite Ableitung liesse Kopfzeile und Liste ueber dieselbe Anlage Verschiedenes behaupten. Fehlt das Feld (aelterer Aufrufer), faellt der Picker auf blosse Namen zurueck.
  - **⚠ DIE DATENLAGE, ehrlich benannt: der Anlagen-Endpunkt traegt KEINE Adresse.** Eine Anlage kennt `latitude`/`longitude` und ihre `biddingZone`, mehr nicht — der Ortsname der Anlege-Suche wird nie gespeichert (`AnlageFlow` schickt nur Koordinaten). Also ist der ORT das LAND aus der Gebotszone, und er steht NUR da, wo er unterscheidet: in einer Ein-Land-Flotte stuende sonst auf jeder Zeile dasselbe Wort. Koordinaten werden NICHT gerendert („48,8790° N" ist keine Ortsangabe, die ein Kunde ueber seine Anlage liest), aber sie sind DURCHSUCHBAR (unsichtbare Stichwoerter). Ein Ortsname wuerde ERFUNDEN — das tut diese Datei nicht.
  - **„Alle Anlagen" steht ganz oben und traegt KEINEN Punkt** — es ist ein Ortswechsel, kein Zustand; ein Punkt behauptete eine Gesundheit ueber eine Flotte, die diese Zeile gar nicht misst.
  - **⚠ Der Telefon-Ueberzug braucht einen SPEZIFITAETS-SCHRITT** (`.vp-app .vp-tb-switchwrap`): `.vp-picker` setzt `display: flex` aus einem komponenten-lokalen Blatt, bei gleicher Spezifitaet entschiede die Buendel-Reihenfolge — und die stand beim Bau auf „Picker gewinnt", der Wechsler war bei 1440 px in der Kopfzeile sichtbar (im Browser gemessen). Waechter in `AppShell.test.tsx`, mutationsgeprueft. **Dieselbe Klippe trifft jede Flaeche, die `.vp-picker` ueberstimmen will.**

- **Die MODELL-Suche des Anlege-Flusses ist EIN Picker mit Gruppen (Welle 1).** Suchfeld + Marken-Auswahl + Modell-Auswahl waren DREI Bedienelemente fuer EINE Frage; jetzt ist es ein `VpPicker` mit den Marken als GRUPPEN. **Die Suche ist dieselbe tolerante wie zuvor** — sie wohnt nur nicht mehr in `komponentenAssistent.ts`, sondern in `picker/suche.ts` und gilt damit fuer jede Auswahlliste des Portals. Familie und Modellcode reisen als unsichtbare `keywords` mit, `modellZusatz` ist die Nebenzeile. Der frueher separate Stufen-Weg ist damit **kein zweiter Pfad mehr, sondern eine Bewegung in derselben Liste**; der Modell-Hebel des Verbindungstests fuehrt zurueck in den Picker, der auf dem gewaehlten Modell (und damit in dessen Marken-Gruppe) oeffnet.

- **Welle 1 · die drei Formular-Flaechen: GuidedRuleBuilder · die (inzwischen entfallene) Befehle-Filterleiste · HistorieWelt-Sprungfeld.** Neun `<select>` und vier native `type="date"`/`type="time"`-Felder sind weg; **die WERTE und jede Pflichtpruefung sind unveraendert** (`schaltFreigabe`/`historieZeit` haben keine Zeile bekommen) - es ist eine reine Darstellungs-Schicht. ⚠ Die Befehle-Filterleiste selbst gibt es seit Geräteseiten Stufe 2 nicht mehr (der Verlauf hat keine Filter); ihre Picker-Faelle sind mit ihr entfallen.
  - **⚠ Eine GESPERRTE Bedingung bleibt SICHTBAR und nennt ihren Grund.** Das native `<option disabled>` konnte den Governance-Satz nur im `title` tragen; die Zeile traegt ihn jetzt als `disabledHint` LESBAR unter dem Namen (die Haus-Regel „ein Zustand ohne Grund ist ein Raetsel"). Wer die Liste vorfiltert, nimmt dem Kunden die Auskunft, WARUM etwas fehlt.
  - **⚠ Das Zeitfenster nimmt weiterhin eine FREI getippte Uhrzeit an.** `VpTimePicker` ist ein Feld mit Vorschlagsliste, kein Auswahlfeld - `18:30`/`1830`/`18` fuehren alle zu `18:30`, und `min`/`max` des abgeloesten nativen Felds gelten unveraendert. Ein Raster als einzige Eingabe wuerde aendern, WELCHE Regeln sich bauen lassen.
  - **⚠ Das Sprungfeld der Historie war NATIV mit der Begruendung „der Browser bringt seinen Kalender mit" - genau die Begruendung ist gefallen** (Captain-Entscheid 1): der System-Kalender beginnt auf einem englisch eingestellten Rechner am SONNTAG, was eine Kalenderwochen-Auswahl unbrauchbar macht. Der Haus-Kalender beginnt am Montag und traegt seine KW-Spalte; der WERT bleibt ISO, `ankerAusWert` liest ihn unveraendert.
  - **⚠ Monat und Woche sind DASSELBE Tages-Gitter** (`art` entscheidet nur, was ein Klick ERGIBT und was hervorgehoben wird): im Monats-Modus leuchtet der ganze Monat, ein Klick auf den 29. Juni ergibt `2026-06`. Die Grenzen kommen aus der Datenlage (`sprungGrenzen`) und stehen als natives `disabled` an der Zelle - **nicht** als `aria-disabled`; ein Test, der nur Letzteres prueft, sieht sie nicht (im Browser gemessen).
  - **⚠ Ein KALENDER folgt nicht der Breite seines Feldes** (`VpPanel.MAX_KALENDER_PX`, 320): eine Auswahl-LISTE darf das - ihre Zeilen sind Text -, ein siebenspaltiges Gitter ueber ein 1136 px breites Feld gezogen wird zur Tapete, in der keine Woche mehr als Zeile lesbar ist (im echten Chrome gemessen). Die Mindestbreite gilt weiter, der Deckel unterschreitet sie nie.
  - **Beweise:** `GuidedRuleBuilder.test.tsx` (die gesperrte Bedingung MIT Grund, die frei getippte Uhrzeit) · `BefehleSection.test.tsx` (derselbe Zeitraum-Wert wie das abgeloeste `<select>`; ein halber eigener Zeitraum wird nicht geschickt) · `HistorieWelten.test.tsx` (das Sprungfeld gibt ISO ab) · `VpDatePicker.test.tsx` (der Kalender-Deckel, beide Richtungen). Im echten Chrome bei **1440** und **375** durchgespielt: 0 px horizontaler Ueberlauf, 0 ueberstehende Elemente, keine Konsolenmeldungen, **null natives `<select>`/`type=date`/`type=time`**; am Telefon Sheet am Boden mit 52-62-px-Zeilen und 44-px-Kalendertagen, und das Sprungfeld wohnt weiterhin im ⋯-Blatt der Mobil-Bedienzeile.

- **Welle 2 · der Durchtausch ist FERTIG: `frontend/portal/src` traegt KEIN natives Auswahl-, Datums- oder Zeitfeld mehr** (Konzept `vp-picker-system`, Welle 2). Der Beweis ist buchstaeblich `grep -rn '<select' frontend/portal/src --include='*.tsx' | wc -l` = **0** (dasselbe fuer `type="date"` / `type="time"` / `datalist`, auch in `.ts`) - deshalb sagen die Doku-Kommentare seither `select` bzw. „natives Auswahlfeld" statt der spitzen Klammern, und der eine Test-Selektor heisst `input[type=date]` ohne Anfuehrungszeichen. **Wer ein Feld ergaenzt, nimmt den Haus-Picker** - das Browser-Feld ist nicht „auch erlaubt", es ist weg.
  - **⚠ Der LEERE String ist eine ZEILE, wenn die Liste ihn fuehrt.** Das native `<option value="">` („Alle Mandanten", „Automatisch (einziges Geraet)", „Jetzt noch nicht verbinden", „– waehlen –") ist eine echte Wahl, kein „nichts gewaehlt": `ausloeserText` gibt seinen LABEL aus, `gewaehlt` setzt seinen Haken, und `leer` (die gedaempfte Platzhalter-Optik) heisst seither „die Liste kennt diesen Wert NICHT" statt `!value`. Nur ein Wert ohne Zeile faellt auf den Platzhalter zurueck. Wer stattdessen einen Sentinel (`'__auto'`) einfuehrt, baut an jeder Fundstelle eine Uebersetzung, die abdriften kann.
  - **⚠ Eine Zeilen-CSS-Regel darf nie auf JEDES `label`/`select` darin zielen** - der Picker bringt sein eigenes `<label>` mit. In `.vp-geraet-lesen` machte `label { flex: 1 1 150px }` daraus eine **150 px hohe Beschriftung** (im Browser gemessen, im Test unsichtbar); Regeln fuer die Feld-Huellen einer Zeile gehoeren auf `> label`. Dieselbe Klasse: eine `select`-Regel neben dem Picker ist tot und wurde ueberall entfernt (`.vp-vb-duration`, `.vp-assist-field`, `.vp-cert-grid`, `.vp-geraet-lesen`, `.vp-reconnect-select`).
  - **⚠ Ein Picker in einer FLEX-Zeile braucht seinen Anteil** (`flex: 1 1 <basis>`, das `.vp-guided-pick`-Muster): sein Ausloeser ist `width: 100%`, seine Huelle aber ein `auto`-Flex-Kind. Fuer die eingebettete Fassung IN einer Pille (Mandanten-Umschalter, Anlagen-Wechsler) gilt das W1-Rezept: `.vp-picker-ausloeser { border: 0; background: transparent; padding: 0; min-height: 0 }` - die Pille zeichnet den Rahmen, der Picker liefert Caret und Panel.
  - **⚠ Die Beschriftung zeigt in der FELD-Fassung (`triggerAsField`) auf das ECHTE Feld** (`VpPanel labelFor`, vom `VpTimePicker` gesetzt): der Rahmen ist dort ein `span` ohne `id`, `htmlFor={basisId}` zeigte ins Leere - Chrome meldete „Incorrect use of `<label for=…>`" und ein Klick auf die Beschriftung fokussierte NICHTS.
  - **Welle 3 · die BOX hat ihre eigene Fassung, und sie teilt keinen Code.** `edge-app/core/internal/web/static/{pickerregeln,vppicker}.js` + `vppicker.css` sind die Vanilla-Zwillinge dieser Komponente (kein React auf dem Geraet, kein Bau-Schritt); seither traegt auch `:8484` kein natives Auswahlfeld mehr. **Dieselben Regeln, zwei Umsetzungen — wer hier eine Regel aendert (Tastatur, Rang der Treffer, Suchschwelle, Sheet-Verhalten), aendert sie dort mit.** Details in `edge-app/AGENTS.md` „DER PICKER DER BOX".
  - **So treibt ein Test den Picker:** `fireEvent.click(getByRole('combobox', { name }))` → `fireEvent.click(getByRole('option', { name }))`; der gewaehlte Wert steht als TEXT am Ausloeser (`toHaveTextContent`), nicht in `.value`, Kalendertage sind `gridcell` (mit echtem `disabled`), und ein Panel schliesst per `fireEvent.keyDown(getByRole('listbox'|'grid'), { key: 'Escape' })`. Ein `fireEvent.change(getByLabelText(...))` schlaegt fehl - das ist Absicht.

- **VoltPilot ist als APP installierbar - die Hülle liegt in `public/`, die Regeln in `src/installApp.ts` (PWA, Konzept `data/vp-app-pwa-k3`, Captain-Freigabe 24.08.2026).** Das Portal war mobil längst fertig (Bottom-Bar, Telefon-Layouts, Aufwach-Verhalten); es fehlte nur die Hülle außen herum: `public/manifest.webmanifest` (`display: standalone`, `start_url: /`, `id: /`), `public/icons/*`, `public/sw.js`, `public/offline.html` und ein paar Zeilen im `<head>`. Der Dauer-Login ist ein SEPARATES Vorhaben (Keycloak-Sitzungen) - hier wurde an `auth.ts` keine Zeile angefasst.
  - **⚠ DIE REGEL, an der alles hängt: der Service Worker ist DURCHREICHE mit Offline-Rückfall und cacht NIEMALS `index.html`, `/assets/*` oder eine API-Antwort.** Sein `fetch`-Handler beantwortet ausschließlich NAVIGATIONEN (`request.mode !== 'navigate'` → früher Rücksprung, kein `respondWith`); jede Navigation geht ans Netz und nur ein Netz-FEHLER holt `offline.html` aus dem Vorrat. Die Auslieferungs-Politik der nginx (`no-cache` fürs Dokument, `immutable` für die gehashten Bündel) und `deployWatch.ts` (holt seinen Anker mit `cache: 'no-store'` am Browser-Cache VORBEI) bleiben damit die EINE Wahrheit darüber, welche Fassung ein Tab fährt - ein Worker, der Navigationen aus einem Cache beantwortet, wäre eine zweite, hartnäckigere Schicht genau der Sorte, die schon zweimal eine „alte Ansicht"-Eskalation gekostet hat, und `deployWatch` könnte sie nicht einmal bemerken. **Im echten Chrome gemessen:** die Seite ist vom Worker KONTROLLIERT, sein Vorrat enthält nur Offline-Seite/Manifest/Icons, und ein simulierter Deploy (Entry-Bündel umbenannt + neuer Titel im Container) landet nach einem gewöhnlichen Reload sofort neu.
  - **⚠ `SW_VERSION` ist der Schlüssel des Vorrats, und der Browser installiert nur neu, wenn sich die BYTES von `sw.js` ändern** - wer `offline.html` oder ein Icon anfasst, MUSS sie hochzählen, sonst behält ein Gerät die alte Fassung.
  - **Die Icons sind die GELIEFERTEN Marken-Originale, byte-genau eingecheckt - NICHT generiert (Favicon-Umbau 24.08.2026).** `public/favicon.svg` (SVG mit eingebettetem PNG), `public/favicon.ico` (48/32/16 im Web-Root für jedes Tool, das `/favicon.ico` blind abfragt), `public/favicon-96x96.png` und `public/icons/{icon-192,icon-512,apple-touch-icon-180}.png`. Der frühere Generator `tools/gen-icons.mjs` ist ENTFERNT: er rasterte den weißen Blitz auf dem Verlauf, die neue Marke (schwarzer Punkt + hellblauer Blitz `#95B9FF` auf Weiß) kann er nicht reproduzieren, und „nicht neu rendern" ist die Vorgabe - ein zurückgelassener Generator würde die Originale beim nächsten Lauf mit der ALTEN Marke überschreiben (Footgun). **Die gelieferte 512er-PNG ist deckend + safe-zone-gepolstert, dient also `any` UND `maskable`** (beide Manifest-Einträge zeigen auf `/icons/icon-512.png`; ein separates `icon-maskable-512.png` gibt es nicht mehr). **Wer die Marke ändert, ersetzt diese Dateien und hebt `SW_VERSION`.**
  - **⚠ `theme-color` ist `#FFFFFF`, weil die Kopfzeile der App `--vp-surface` ist** - eine andere Farbe erzeugte eine sichtbare Kante über ihr. Und `apple-mobile-web-app-status-bar-style` ist `default`, solange NIRGENDS im CSS ein `env(safe-area-inset-top)` steht: `black-translucent` schöbe den Inhalt unter die Statusleiste, und die 68-px-Kopfzeile hat dafür kein Polster (wer eines einbaut, darf die Zeile neu bewerten).
  - **`src/installApp.ts` ist die reine Regel-/Copy-Schicht** (vier Zustände `installiert` · `installierbar` · `ios-anleitung` · `nicht-verfuegbar`, in DIESER Rangfolge - wer die App schon benutzt, bekommt NIE eine Anleitung dazu) plus ein winziger Speicher ohne React; `components/InstallAppPanel.tsx` rendert ihn über `useSyncExternalStore`. **`beforeinstallprompt` ist der EINZIGE Beleg dafür, dass ein Knopf etwas bewirkt** - deshalb hängt `main.tsx` die Zuhörer VOR dem Auth-Bootstrap ein (das Ereignis feuert kurz nach dem Laden und wird nicht wiederholt), und ohne Angebot steht dort der GRUND statt eines toten Knopfes (die `registerZugang`-Regel). Ein Abbruch VERBRAUCHT das Angebot (`prompt()` wirft beim zweiten Mal), der Zustand fällt danach ehrlich auf `nicht-verfuegbar` zurück - mit dem anderen Grund, nicht mit einem fünften Zustand.
  - **⚠ Ein iPad ab iPadOS 13 meldet sich als „Macintosh"** und ist nur über `maxTouchPoints > 1` von einem echten Mac zu unterscheiden - ohne diesen Zweig bekäme genau das Gerät, das die Teilen-Anleitung am dringendsten braucht, den Satz „dieser Browser bietet es nicht an".
  - **Die Fläche ist die siebte Gruppe der Einstellungs-Seite** („Als App auf dem Handy", Icon `smartphone`, neu im Design-System) - sie gilt dem GERÄT, nicht der Anlage, und die Einstellungs-Seite ist ihr natürlicher Ort. Der neue `SettingsGroupId` `app` zieht durch `settingsNav`/`glossar` (Suchbegriffe „installieren"/„Startbildschirm"/„iPhone"…).
  - **⚠ Der Haus-`Button` setzt seine Breite INLINE (`style={{width: fullWidth ? '100%' : 'auto'}}`), ein Inline-Stil schlägt jede Medienabfrage.** Die volle Breite am Telefon läuft deshalb über `fullWidth={useIsPhone()}`, nie über CSS - dieselbe Klippe wie `Card` mit seiner inline gesetzten Polsterung; die erste Fassung maß im Browser 175 px statt 343 px, obwohl die `@media`-Regel dastand. **Gilt für jede künftige Breiten-/Polster-Regel an einem Design-System-Baustein.**
  - **⚠ nginx kennt `.webmanifest` NICHT** (die mitgelieferte `mime.types` von 1.27-alpine hat keinen Eintrag, verifiziert) - `nginx.conf` ergänzt ihn mit einem `types`-Block auf HTTP-Ebene. **Die Falle: `types` ERSETZT die geerbte Zuordnung, sobald es auf einer INNEREN Ebene steht** (ein Block in `server`/`location` nähme jeder anderen Antwort `text/css`/`application/javascript`); im GLEICHEN Kontext sammeln sich `types`-Blöcke dagegen an, und diese Datei wird direkt nach `include mime.types;` in den http-Block eingebunden. `test:cache` prüft beide Hälften (Manifest bekommt `application/manifest+json` UND eine gehashte `.css` bleibt `text/css`).
  - **Wächter:** `src/pwaShell.test.ts` (Docker-frei, liest die Dateien: Manifest-Icons EXISTIEREN, `index.html` nennt Manifest + Apple-Icon + dieselbe `theme-color`, der Worker cacht kein `index.html`/`/assets` und hat GENAU EIN `respondWith`, `offline.html` ohne inline `<script>` und ohne externes Asset - Kommentare werden vorher abgestreift, das `copy.test.ts`-Muster) · `installApp.test.ts` (25) · `serviceWorker.test.ts` (10) · `pages/AnlageTechnik.test.tsx` (+4: der Abschnitt, der Knopf NACH dem Rendern, die installierte App ohne Hinweis, die zwei iPhone-Schritte) · die beiden nginx-Smokes gegen das echte Image.
  - **Bewusst NICHT gebaut:** Push-Benachrichtigungen (eigenes Vorhaben, ~3-5 Tage: Geräte-Abos im Backend + Versandweg), `navigationPreload` (jede Verzweigung im `fetch`-Handler ist eine Stelle, an der eine Navigation brechen kann), und `shortcuts`/`screenshots` im Manifest. Der iPhone-Hardware-Beweis ist Sache des Betreibers nach dem Deploy.

