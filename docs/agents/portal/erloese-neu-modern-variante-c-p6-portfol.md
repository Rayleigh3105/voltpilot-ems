# Erlöse „Neu modern" (Variante C) · P6 — Portfolio › Erlöse in derselben Grammatik

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 39).


Captain-Entscheide 03.09.2026 auf `data/vp-erloese-lesbar-konzept-u3`: **E2 = (b)** (die
Leseprinzipien gelten auch fürs Portfolio), **E3** (der laufende Tag vergleicht sich nur bis zur
gleichen Stunde), **E9** („Netto überall"), **E12 = (a)** (Pilot). Behoben: **Befund B13**.

- **Keine zweite Fläche mehr:** `pages/PortfolioErloese.tsx` rendert `components/ErgebnisZeilen`
  (also `Statement` + `Kontoauszug` + `SpeicherKarte`) — dieselben Bauteile wie die Anlagen-Seite,
  dasselbe Blatt (`erloese/ErgebnisKarte.css` reist mit dem Bauteil). Die frühere Summen-Karte
  (`KartenKopf` + `.vp-pf-summe` + `.vp-pf-teile` + `.vp-pf-zurechnung`) ist ERSATZLOS entfallen;
  `PortfolioWelt.css` hängt seither am Skala-Wächter (`erloeseSkala.test.ts`).
- **⚠ `erloesZeilen.flottenZeilen` ist der Flotten-Eingang** zu demselben Kern (`zeilenKern`), den
  `ergebnisZeilen` fährt. Er nimmt die vier Summen statt einer `SiteEarnings` — ein
  zusammengebautes Fantasie-Objekt wäre eine zweite Wahrheit über eine Antwort, die es nicht gibt.
  **Die Sekundärzeile bleibt dort LEER**, und das ist eine Aussage: sie nennt Tarif bzw.
  MaStR-Referenz, beides gibt es je ANLAGE, nicht je Flotte (das Portfolio ist tarifneutral).
- **⚠ B13, die drei behobenen Abweichungen:** „davon … durch VoltPilots Steuerung" → **„Steuerung"**
  (`speicherAussage.label`; die Spalte zeigt seit dem 04.09.2026 `savedSteuerungEur` — der Wert des
  GANZEN Speichersystems ist eine ADMIN-Zahl, siehe „Die STEUERUNGS-AUSSAGE"); „↑ 532 % mehr als am
  Vortag" → siehe die Vergleichsregel unten; die drei Teile stehen im Wasserfall statt als Prosa.
- **⚠ DIE VERGLEICHSREGEL: am LAUFENDEN Tag entscheidet ausschließlich der SERVER-Wert.**
  `portfolioHistorie.portfolioVergleich` liest `Earnings.vergleich` (neu, `GET /api/v1/earnings`:
  beide Seiten bis zur gleichen Berliner Wanduhr-Stunde, aus derselben Preiskomposition wie die
  Zeilen). Fehlt er, bleibt die Zeile **WEG** — nie ersatzweise gegen den vollen Vortag. Jeder
  andere Zeitraum fährt unverändert `vergleichLaufend.erloesVergleich`.
  **Formuliert wird an EINER Stelle:** `vergleichLaufend.gleicheStundeZeile` teilt sich Chip,
  Beträge-Zeile und Methoden-Satz mit der Anlagen-Seite.
- **⚠ Die Flotten-Totals führen die Dreiteilung NICHT** (`EarningsTotalsDto`: eine Anlage ohne
  gepflegte Batterie-Stammdaten risse dort eine unbeweisbare Lücke). Die Steuerungs-Karte des
  Portfolios summiert deshalb die ZEILEN (`ErloeseAggregat.steuerungEur` = Σ `savedSteuerungEur`
  der beitragenden Anlagen) und verweist mit `portfolioHistorie.SPEICHER_JE_ANLAGE` („je Anlage in
  der Tabelle") auf den ORT der Aufteilung statt auf eine erfundene Zahl.
- **⚠ Der Portfolio-Kopf ist `vp-sr-only`** (P3/P4: die Zeit-Leiste trägt die Identität), die Leiste
  wird also 68 px UNTER ihrem Fluss-Platz angeheftet und der Rumpf rutscht darunter. Bis P6 fing das
  die Polsterung der Summen-Karte auf; seit das `Statement` OHNE Rahmen auf dem Grund steht, lag
  sein Label bei 1440 px VOLLSTÄNDIG dahinter (98..122 gegen 126 gemessen). Freistellung:
  `.vp-pf-erloes-body` ab 721 px (bei 375 px war nichts verdeckt — dort wäre sie verschenkte Höhe).
  **Wer ein weiteres Bauteil an den Anfang eines Portfolio-Rumpfs setzt, prüft das nach.**
- **„Eingespeist" fällt unter 720 px weg** (`td.vp-pf-col-kwh`, Skill-Regel „Table Handling"). Das
  macht CSS, nicht die Spaltenliste — und die Kopfzelle braucht keine eigene Regel, weil
  `.vp-table.responsive thead` dort schon ausgeblendet ist.
- **Beweis-Harness:** `e2e/erloese-c-p6.html` (Flotte aus DREI Anlagen mit den Mockup-Zahlen;
  `?vergleich=aus` zeigt den B13-Fall ohne Server-Wert). Gemessen mit `emulate --viewport` (die
  P5-Regel: `resize` klemmt auf 500 px) — Ergebnis-Fläche 1440/375: **4 Schriftgrößen** (48 bzw.
  36 / 16 / 14 / 12) · **4 Textfarben** · **1 Fläche** · **3 Chips** · **44 Wörter** · Kontrast
  **4,83** · 0 Verstöße · 0 px Überlauf · Anlagen-Links 44/44/44.
  **⚠ 3 Chips statt der 2 des Auftrags** — der Portfolio-Mockup ließ die Vergleichszeile bewusst
  weg, weil es den Server-Wert noch nicht gab; mit ihm ist ihr Chip der dritte (das C-Budget des
  Ergebnis-Rahmens ist selbst 3). Ohne Server-Wert sind es 2 — nachgemessen mit `?vergleich=aus`.
  **⚠ Die einzige gemeldete Trefferfläche < 44 ist `.vp-infotip-btn` (20×20)** — ein Haus-Bauteil,
  dessen 44 px als `::after`-Overlay liegen (`index.css`, Befund B12); `measure.js` sieht
  Pseudo-Elemente nicht. Nachgerechnet: 20 + 2 × 12 = 44.

