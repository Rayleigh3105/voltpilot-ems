# Verlauf-Sprache P2b: EIN Aufklapper, und Zustände, die ihren Platz reservieren

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 42).


Konzept `data/vp-verlauf-sprache-konzept-v5` §3.2 (V8/V10) + §7 Zeile P2. Die zwei
restlichen GETEILTEN Bausteine des Bereichs — die Reiter-Pakete P3–P8 setzen darauf auf.

- **⚠ DER Aufklapper ist `components/Aufklapper.tsx` + `Aufklapper.css`** — ein natives
  `<details>`/`<summary>` in der Ledger-Form: Titel 16/600, Chevron rechts, **48 px
  Trefferfläche über die volle Breite**, Inhalt darunter in Textgröße. Bewegt wird
  ausschliesslich der Chevron (`--vp-c-motion`); **eine Höhen-Animation gibt es nicht** —
  sie zöge den Scrollweg unter dem Daumen weg und springt gegen den klebenden Kopf (S1).
  `WeltDisclosure`/`WeltFuss`/`VerlaufFuss` benutzen ihn; die alte
  `.vp-welt-disclosure`-Zeile samt ihrer drei Telefon-Ausnahmen ist aus `Historie.css`
  entfallen. Die Ledger-Zeile der Erlöse (`.vp-c-led-det`) ist das VORBILD und bleibt, was
  sie ist: sie trägt zusätzlich Betrag, Balken und Sekundärzeile in EINEM Raster und ist
  damit die Kontoauszugs-Variante derselben Form.
  - **⚠ Kontrolliert heisst `preventDefault` auf dem Klick — das ist Pflicht.** Sonst
    schreiben zwei Stellen dasselbe `open`: React aus dem Zustand, danach die native
    Aktivierung des `summary` ein zweites Mal — der Aufklapper bliebe stehen. Der TASTATUR
    nimmt es nichts (Enter/Leertaste erzeugen erst einen Klick); abbestellt wird nur das
    Aufklappen DES BROWSERS. Ohne `open` führt der Browser den Zustand selbst.
  - **⚠ `getByRole('button')` findet ein `summary` NICHT** — `dom-accessibility-api` bildet
    es auf keinen Rang ab. Tests adressieren die Zeile über `summary.vp-c-aufk-sum` + ihren
    Titel; `aria-expanded` steht weiterhin daran und bleibt prüfbar (Helfer `aufklapper()` in
    `HistorieMobil.test.tsx`/`HistorieWelten.test.tsx`).
  - **⚠ Der Körper existiert seit P2b an JEDEM Aufklapper**, auch zugeklappt. Ein
    `document.querySelector('.vp-c-aufk-body')` greift deshalb den ERSTEN der Seite —
    gemeint ist fast immer `details.vp-c-aufk[open] .vp-c-aufk-body`. Und wer SCHWERE
    Inhalte hängt, reicht sie bewusst erst beim Öffnen herein (`{open ? children : null}`,
    so macht es `WeltDisclosure`): ein ECharts-Knoten in einer zugeklappten `details` misst
    0 px Breite und rendert falsch, sobald er sichtbar wird.
- **⚠ Die drei Zustände einer Verlauf-Karte sind `VerlaufKarteSkeleton` / `VerlaufLeer` /
  `VerlaufFehler` in `components/States.tsx`** (+ `VerlaufZustaende.css`). Die drei
  portalweiten `ChartCardSkeleton`/`EmptyState`/`ErrorState` bleiben unangetastet — sie
  tragen den ganzen Rest des Portals. **Alle drei leben IN der Karte**, die der AUFRUFER
  stellt; keiner bringt einen eigenen Rahmen mit (die alte `.vp-alert`-Kachel stand AN
  STELLE der Karte, samt Verlust der Überschrift, unter der die Zahl stand).
  - **Laden** reserviert die Anatomie: Label 18 + Kernsatz 24 + Diagramm + Legende 44, mit
    drei 12-px-Abständen = 382 px im Kartenkörper. **⚠ Die Diagramm-Höhe ist ein ZWILLING
    von `.vp-chart` in `index.css`** (`clamp(260px, 40vw, 340px)`) — `verlaufZustaende.test.ts`
    liest beide Blätter und vergleicht die Formeln Zeichen für Zeichen; wer die eine ändert,
    ändert die andere mit.
  - **Leer** ist Label 12/700 + EIN Satz 16 + der Weg als TEXTLINK (dessen Trefferfläche ein
    `::before`-Overlay weitet, das Muster der Erlöse-Sekundärzeile). **Kein 48-px-Symbol und
    keine 1,25-rem-Überschrift** — die grösste Schrift der Karte für die Nachricht, dass
    nichts da ist, war die alte `EmptyState`.
  - **Fehler** ist `role="alert"`, Satz 16 und die EINE Handlung als 44-px-Outline-Knopf.
- **⚠ Die P0-Ratsche gilt für beide neuen Blätter streng auf 0** (`verlaufSkala.test.ts`,
  `verlaufMobil.test.ts`), und `Historie.css` ist mit dem Umzug auf fs 35 / ff 3 gefallen —
  eine Zahl dort wird NIE wieder grösser.
- **NICHT in P2b:** die „Mehr anzeigen"-Pillen (`ChartDetailToggle`) — ihre CSS wohnt in
  `index.css` und sie sitzt portalweit in Diagramm-Köpfen (Fahrplan, Cockpit); sie wird mit
  dem Messwerte-Paket P3 zu dieser Form, das ihre Karte ohnehin neu baut. Ebenso die
  Reiter-eigenen Aufklapper von Marktpreise/Wetter/Lastspitzen/Prognose (P4–P7).

