# Verbrauchsmanagement v1 / P3a: „Jetzt voll laden" steht, wo eingegriffen wird

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 28).


Konzept `data/vp-verbrauchsmgmt-konzept-v1` (§4.6 · §6.1/§6.2 · §8 P3a; Captain-Entscheide
angenommen 31.08.2026). Der behobene Befund S6: die Jetzt-Zone rendert den Ladepark als EINE
Zeile ohne Handlung, während der Boost auf *Fahrplan › Ladevorgänge* liegt — **vier Klicks auf
einer anderen Seite**. **Reine Portal-Arbeit: kein Endpunkt, keine Migration, kein Edge-Release**
(`POST /charging-boost` gibt es samt `cancel` seit OCPP-Stufe 4, und `ChargingBoostService.record`
schreibt den Beleg seit je in den Kommando-Strom `ladepunkt`).

- **⚠ EINE Regel, zwei Flächen — es entsteht KEINE Kopie.** Was ein Ladepunkt anbietet, entscheidet
  seit P3a `ladepunkte.ts` `ladepunktAktionen` / `ladepunktKeinEingriff`; die Jetzt-Zone UND die
  Ladevorgänge-Seite lesen sie (dort ersetzt sie den direkten `boostbar`-Aufruf, dessen Regel sie
  unverändert weiterführt). Beschriftungen, Hinweis-Sätze, Dauern, Folgen-Karte und Banner-Satz
  wohnen ebenfalls dort — `ladepunkte.ts` ist die EINE Schicht für Ladepunkt-Sätze, und sie bleibt
  **import-frei** (die Folgen-Karten-Typen sind lokal deklariert und strukturell zu
  `handeingriff.ts` `FolgenBlock` kompatibel, statt ihn zu importieren).
- **`steuerungJetzt.ts` `ladepunktZeilen`** macht aus jedem gemeldeten Stecker eine Zeile mit
  „Eingreifen ▾". Zustand, Ton und Grund kommen unverändert aus `ladevorgangRows` — es gibt keine
  zweite Wortquelle über Ladesäulen. Neu ist allein, dass die Zeile ihre HANDLUNG mitbringt
  (`JetztZeile.ladepunkt` trägt Stecker-Adresse + Name; `entityId` kann sie nicht tragen, ein
  Ladevorgang hängt an einem STECKER, nicht an einer Komponente).
- **⚠ KEIN Countdown, und das ist die Ehrlichkeitsregel dieser Runde.** Der Herzschlag meldet je
  Stecker nur `boost: true|false`, **kein Ende** — „noch 1:12 h" (so im Mockup) wäre erfunden.
  Zeile und Banner sagen stattdessen, was wirklich gilt: „endet spätestens beim Abstecken".
- **⚠ Der Urheber steht EINMAL.** Ein laufender Boost macht aus dem Zustands-Wort „Lädt voll auf
  Ihren Wunsch"; die Zeile nennt ihn schon als QUELLE, also zeigt sie das BASIS-Wort
  (`LadeZustand.basisWort`/`LadevorgangRow.basisWort`, additiv) — „lädt 22,0 kW · Jetzt voll laden",
  der Mockup-Wortlaut. Dieselbe Regel lässt `ladepunktKeinEingriff` schweigen, wo der Zustand schon
  „kein Auto eingesteckt" sagt (im Browser-Beweis aufgefallen, nicht im Unit-Test).
- **⚠ „bis Abstecken" reist als FEHLENDE Dauer** (`LADEPUNKT_DAUERN[4].minutes === null`): dann gilt
  der Vertrags-Deckel der Box (4 h), und die Bindung an die Transaktion beendet den Eingriff ohnehin
  beim Abstecken. Der Ende-Satz nennt dort deshalb die 4 Stunden statt einer zweiten, erfundenen
  Frist.
- **Die Folgen-Karte ist der BESTEHENDE `HandeingriffDialog`** — vier Blöcke wie am Speicher, damit
  die Zone EINE Grammatik hat. Er bekam dafür genau eine additive Prop `dauern` (Vorgabe die
  Speicher-Dauern); es gibt keinen zweiten Dialog, der abdriften könnte. **Die einzige Zahl darin
  ist die gemessene Anschlussgrenze** — fehlt sie, steht der Satz ohne Zahl statt mit einer
  geratenen.
- **Der Banner-Rückweg hängt am Sentinel `LADEPUNKT_BANNER_ID`** (ein Ladevorgang hat keine
  Komponenten-Id) und steht ZULETZT in `jetztBanner`: er ist der engste Eingriff, Anlagen-Pause und
  Speicher-Eingriff gehen vor. Ohne laufenden Boost ist der Zweig ein No-op — die Zone bleibt dann
  Zeichen für Zeichen die von vorher.
- **Der Beleg wird endlich GERENDERT:** `befehle.ts` `EREIGNIS` kannte `voll_laden_erteilt` /
  `voll_laden_zurueckgenommen` nicht, und ein unbekanntes Ereignis-Wort erzeugt gar keine Zeile —
  der cloud-seitig geschriebene Beleg war damit unsichtbar. Beide Wörter stehen jetzt dort.
- **Telefon: das Menü ist ein BOTTOM-SHEET** (`Steuerung.css`, `max-width: 720px`) — dasselbe Menü,
  nur seine Position wechselt, plus Griff und die Kontextzeile „Eingreifen · {Name}", die am Rechner
  ausgeblendet bleibt (dort steht das Menü an seiner Zeile). **⚠ Die Desktop-`max-width` muss im
  Sheet-Zweig ausdrücklich zurückgenommen werden**, sonst klebt es als schmale Karte in einer Ecke.
- **⚠ Die Andockstelle für P1 ist EINGELÖST:** die Sammelzeile `ladeparkZeile` ist ERSATZLOS
  entfallen (§6.1) — ihre Kopfzahl trägt der Ladepark-Rahmen der Verbraucher-Zone —, und
  `ladepunktZeilen` liefert seither `{zeilen, weitere}` mit dem Einklappen vieler Ladepunkte
  („9 weitere ohne Auto", §6.4). Der Rest dieses Abschnitts gilt unverändert.
- **NICHT in diesem Paket:** „Laden pausieren" (P3b, braucht ein Edge-Release / Entscheid E5). Der
  Platz ist frei gelassen — es kostet eine Zeile in `LADEPUNKT_LABEL`, eine in `LADEPUNKT_HINWEIS`
  und einen Zweig in `ladepunktAktionen`, sonst nichts.
- **Beweise:** rein `ladepunkte.test.ts` („Ladepunkt-Handeingriff (P3a)": Menü je Zustand, kein Auto,
  stumme Säule, „EINE Regel mit `boostbar`", Dauern, Karte mit/ohne gemessene Grenze, Banner ohne
  Countdown) · `steuerungJetzt.test.ts` („Ladepunkt-Zeilen (P3a)") · DOM `JetztZone.test.tsx`
  (Zeile → Menü → Folgen-Karte → Boost mit 2 h; „bis Abstecken" ohne Minuten; ohne Auto kein Menü;
  Banner + Rücknahme) · `befehle.test.ts`. Im echten Chrome bei 1440 und 375 durchgespielt: 0 px
  horizontaler Überlauf, 0 überstehende Elemente, keine Konsolenfehler.

