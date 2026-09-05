# Verlauf-Sprache P1: EIN Chrome für alle sechs Reiter des Verlaufs

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 41).


Konzept `data/vp-verlauf-sprache-konzept-v5` §3.2 (V1/V3) + §7 Zeile P1. Die sechs Reiter
Messwerte · Erlöse · Marktpreise · Lastspitzen · Prognose · Wetter tragen dasselbe Chrome.

- **⚠ KEIN Verlauf-Reiter trägt einen sichtbaren Seitenkopf** (Befund B1). Vier von ihnen
  standen bis P1 in `SUB_PAGES` (`pages/AnlagenPage.tsx`) — Titel + Lead-Absatz ÜBER den
  Bereichs-Reitern —, die anderen zwei nie: die Reiterleiste stand dadurch je nach Reiter bei
  140 oder 287/316 px und SPRANG bei jedem Wechsel. Ein neuer Eintrag dort bräche das still
  wieder; Wächter ist `migration.test.ts` „kein Verlauf-Reiter trägt einen sichtbaren
  Seitenkopf" (nicht-vakuum: Fahrplan/Steuerung stehen weiterhin drin — die Bereiche AUSSERHALB
  des Verlaufs behalten ihren Kopf). Ersatz je Reiter: `VerlaufKopf` (unsichtbare `h1`) +
  `VerlaufFuss` (der Lead-Satz WÖRTLICH als Fuß-Aufklapper — er ist Kunden-Sprache, ihn beim
  Entfernen des Kopfs zu verlieren wäre kein Aufräumen).
- **⚠ Es gibt GENAU EINE Zeit-Leiste, und sie wird BENUTZT, nie nachgebaut** (Befund B2).
  `ZeitLeisteRahmen` · `ZeitSegment` · `ZeitBlaetterer` in `components/HistorieWelt.tsx` sind
  der EINE Wirt; `ZeitLeiste` (Messwerte/Erlöse) rendert selbst durch ihn. Marktpreise baute
  vorher eine zweite `.vp-seg` in einem eigenen `vp-page-head` nach. Wächter:
  `migration.test.ts` verbietet `className="vp-zeitleiste…"` außerhalb von `HistorieWelt.tsx`.
- **⚠ E4 b2 — sie KLEBT am Telefon und kollabiert auf ihre erste Zeile** (Captain-Entscheid
  03.09.2026, wörtlich: „b2) klebend, beim Scrollen auf die Segment-Zeile (58 px) kollabiert").
  Das löst den Widerspruchs-Kasten W1 auf: die Festlegung „am Telefon NICHT klebend" aus E3
  (`vp-erloese-lesbar-konzept-u3` §3.5) gilt für den Verlauf — **die Erlöse-Seite
  eingeschlossen** — nicht mehr. Gemessen: 108 px oben, 58 px gescrollt (6+44+6+2), sticky bei
  `top: 68`.
  - Der Auslöser ist der Haus-Haken **`useScrolledPast`** (1-px-Wächter `.vp-zl-wache` über der
    Leiste), nicht ein eigener Observer: er bringt die zwei bezahlten Lehren mit (Callback-Ref
    statt `useRef`+Effekt; nur ein Hinausscrollen nach OBEN zählt). Ohne
    `IntersectionObserver` (jsdom) kollabiert NICHTS.
  - **Die HÖHE wird nie animiert** — eine Höhen-Transition auf einem klebenden Element schöbe
    den Inhalt darunter für die Dauer der Bewegung, also genau den Layout-Sprung, den das
    Kleben verhindern soll. Bewegt werden nur Deckkraft + 4-px-Versatz der zweiten Zeile über
    `var(--vp-c-motion)`; einen eigenen `prefers-reduced-motion`-Block gibt es bewusst NICHT
    (P0 E3.4 setzt das Token global auf 0 ms).
  - **`--vp-zeitleiste-top` (Vorgabe 68px) ist der Knopf für die Schale:** nimmt S1 die
    Bereichs-Reiter mit ins Kleben, setzt er dort `112px` und muss `Historie.css` nicht
    anfassen.
- **⚠ Der Blätterer kann die ERSTE Zeile sein.** Auf Lastspitzen IST er es (der Zeitraum dort
  ist die Abrechnungsperiode, es gibt kein Segment). Die Mobil-Regeln in `Historie.css` greifen
  deshalb auf `.vp-zl-row`, nicht auf `.vp-zl-row-2` — mit `-2` fiel er auf die Basis-Regeln
  zurück (`min-width: 170px` am Label), brach um und die Leiste maß 90 statt 58 px.
- **Zeiträume je Reiter, fachlich** (§4.3–4.6): Messwerte/Erlöse/Marktpreise Tag·Woche·Monat·
  Jahr · Lastspitzen der Perioden-Blätterer (`moduleSurface.lastspitzenPerioden`, liest
  ausschließlich `peak.history` — **es gibt keinen Endpunkt für den Beweis einer VERGANGENEN
  Periode**, und für die laufende gewinnen die Kopf-Felder von `peak`, sie sind der jüngere
  Stand) · Prognose 7·14·30 Tage (ein ECHTER Schalter: er setzt `forecastQuality(…, tage)` UND
  die Zahl der gemittelten Bewertungen) · **Wetter keine** (eine Vorhersage beginnt bei JETZT).
- **Die Adresse ist additiv.** `historieHash` nimmt seit P1 `VerlaufZeitReiter` (`WeltId` plus
  marktpreise/lastspitzen/prognose); ein Lesezeichen OHNE Parameter bleibt gültig
  (`parseVerlaufParams` fällt sicher zurück). Geschrieben per `replaceState` und nur, wenn die
  Seite als REITER einer Anlage läuft — als eigenständige Seite mit Anlagen-Wähler gehört die
  Adresse nicht dieser Anlage.
- **⚠ EINE Telefon-Grenze im Verlauf: 720.** `useIsPhone` fragt `(max-width: 720px)`;
  `ErgebnisKarte.css` fragte `(min-width: 700px)`, zwischen 701 und 720 rendert die Fläche dann
  ihre Telefon-Fassung in Schreibtisch-Maßen. Jetzt `721px` (die exakte Ergänzung);
  `migration.test.ts` verbietet jede 700-px-Grenze in einem Verlauf-Stylesheet.
- **Beweise:** `pages/VerlaufChrome.test.tsx` (9: V1 je Reiter, die geteilte Leiste, Adresse
  additiv in beide Richtungen, das Prognose-Fenster als echter Schalter, der Kollaps über einen
  gestellten Observer, „ohne Beobachter kollabiert nichts", am Rechner kein Wächter) ·
  `migration.test.ts` (+3 Wächter) · `moduleSurface.test.ts` (+4 Perioden). Im echten Chrome
  bei 375/768/1440 gemessen: Reiterleiste auf allen sechs bei 140/148/143 px, 0 px horizontaler
  Überlauf, Trefferflächen der Leiste ≥ 44 px, Kollaps 108 → 58 → 108 px.

