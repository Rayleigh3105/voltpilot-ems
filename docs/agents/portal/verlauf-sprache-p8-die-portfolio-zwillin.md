# Verlauf-Sprache P8: die Portfolio-Zwillinge, und die Tabelle als LISTE

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 43).


Konzept `data/vp-verlauf-sprache-konzept-v5` §6 E1 b („sechs Reiter + die zwei
Portfolio-Zwillinge") und §6 E6 a („am Telefon immer Liste (V7), ab 700 px Tabelle"),
§7 Zeile P8. Das letzte Reiter-Paket: Portfolio › Messwerte und › Erlöse sprechen
dieselben Bausteine wie ihre Anlagen-Reiter.

- **⚠ Die KENNZAHLEN der Portfolio-Summe kommen aus DERSELBEN Ableitung wie der
  Anlagen-Reiter** — `messwerteZeilen.ts`. Das geht ohne Adapter, weil
  `PortfolioSumme` strukturell eine `EnergieSumme` ist (Schlüssel, Etikett, kWh, Farbe,
  Hinweis) plus dem Zähler „wie viele Anlagen". Eine zweite Zeilen-Ableitung hätte
  dieselben sechs Größen zweimal formatiert, mit zwei Rundungen und zwei Δ-Regeln.
  `.vp-esum*` (die alten Kacheln) ist damit ersatzlos entfallen.
- **⚠ Die Anlagen-Tabelle ist ZWEI Bäume aus DENSELBEN Daten** (`AnlagenBlock` in
  `components/PortfolioWelt.tsx`): unter 721 px eine V7-Liste, darüber eine echte
  `<table>` — die EINZIGE des ganzen Bereichs. Es ist ausdrücklich KEINE
  `.vp-table.responsive` mit `data-label` mehr: eine Etikett/Wert-Karte MIT
  Tabellen-Semantik lässt einen Screenreader Spaltenköpfe vorlesen, die es optisch gar
  nicht gibt (die verworfene Option (c) des Entscheids). Die Grenze ist die Haus-Grenze
  `useIsPhone` (720), also dieselbe, an der der Bereich sonst umschaltet.
- **⚠ Am Telefon fällt seit P8 KEINE Spalte mehr weg.** Die Regel „Eingespeist wird
  unter 720 px ausgeblendet" (`.vp-pf-col-kwh`) war eine Notlösung der
  Tabellen-Klappform; die Liste trägt alle Werte in ihrer Sekundärzeile. Wer eine Spalte
  ergänzt, ergänzt sie in `kopf` — beide Zwillinge lesen daraus, Etiketten inbegriffen.
- **⚠ `AnlagenBlock` ist NICHT `components/AnlagenTabelle.tsx`.** Letzteres ist die
  Flotten-Tabelle des PORTFOLIO-COCKPITS (Anwendungs-Programm Stufe 4), eine andere
  Fläche mit eigener Dichte-Regel. Die zwei nie verschmelzen.
- **⚠ `.vp-c-card` setzt `font-family: var(--vp-c-font)`, die Haus-`Card` nicht.** Daran
  hing der Befund der P4-Crew: `VerlaufFuss` rendert über `WeltDisclosure` (eine
  `vp-card`), sein Titel stand bei 375 px deshalb in 16 px **Inter** auf einer Fläche
  aus Plus Jakarta Sans. Er bringt seine Hülle jetzt selbst mit (`.vp-c-card .vp-c-fuss`),
  `PortfolioWeltFuss` zieht mit. **Jede neue C-Fläche nimmt `.vp-c-card`** — eine
  `Card` mit C-Inhalt ist eine zweite Schrift, die niemand sieht, bis jemand misst.
- **⚠ Der Vergleichs-Chip bleibt dem Rechner** (`vorher && !isPhone`) — wortgleich zur
  Regel des Anlagen-Reiters. Bei 375 px schob er das lange Label der Summenkarte
  gemessene **119 px** über den Rand; der Vergleich steht ohnehin in jeder Δ-Zeile.
- **Beweise:** `pages/PortfolioWelten.test.tsx` (14, davon drei für die E6-Weiche —
  Telefon ohne `<table>` und ohne ein einziges `data-label`, Schreibtisch mit
  `table.vp-c-pft`; mutationsgeprüft) · die zwei Ratschen (`verlaufSkala` 26→24/2→1 für
  `Historie.css`, `verlaufMobil` unverändert 0 für `PortfolioWelt.css`).
- **⚠ `erloeseSkala.test.ts` nimmt seit P8 BEIDE Token-Namen an.** `--vp-c-*` ist seit
  E2 der KANONISCHE Name und die richtige Schreibweise für Neues; ein Wächter, der nur
  den `--vp-erl-*`-Alias annimmt, verböte genau sie. Die Alias-Prüfung selbst („kein
  Erlöse-Name trägt je wieder einen eigenen Wert") gilt unverändert.

