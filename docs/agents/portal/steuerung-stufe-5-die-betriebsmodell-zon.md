# Steuerung Stufe 5: die Betriebsmodell-Zone ist eine RADIOGRUPPE

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 18).


Zone ③ der Steuerung (Konzept `data/vp-steuerung-konzept-b3` §3.4 + §5 Stufe 5; Server-Seite und die
Wechsel-Sequenz in der Root-`AGENTS.md` „Steuerung Stufe 5"). Sie beantwortet vier Fragen je Modell
— *Was bringt es? Was brauche ich? Läuft es, und seit wann? Was passiert beim Umschalten?* — und
stellt genau EINE Entscheidung: **welches Betriebsmodell fährt meinen Speicher.** Alles ist additiv:
eine Anlage ohne aktives Modell rendert den Grundmodus, alles ausserhalb der Zone ist zeichengleich
zu vorher (`migration.test.ts` „Steuerung Stufe 5").

- **ALLE Regeln liegen rein in `src/betriebsmodelle.ts`** (`betriebsmodelle.test.ts`, 22):
  `ampel` · `laeuftSeit` · `betriebsmodellKarten` · `betriebsmodellZone` plus die Copy.
  `components/Betriebsmodelle.tsx` + `Betriebsmodelle.css` rendern NUR.
- **⚠ EIN RADIO IST KEIN SCHALTER, und das muss man SEHEN.** Der Punkt links ist rund und gefüllt,
  wenn er gewählt ist; wer hier den `.vp-switch` des Regals wieder einsetzt, macht optisch aus „genau
  eines" wieder „beliebig viele" — und der Server schaltet danach still eines ab.
- **⚠ Die Zone hat ZWEI Bedienformen, und der Unterschied ist eine Aussage:** eine **Radiogruppe**
  aus dem Grundmodus plus den Modellen DERSELBEN Exklusivitäts-Gruppe, und je einen **eigenen
  Schalter** für ein Modell ohne Gruppe (heute das Ladepark-Lastmanagement — es ist Schutz,
  konkurriert mit niemandem und läuft neben jedem Betriebsmodell weiter). `zone.eigene` ist genau
  diese Menge.
- **⚠ Der GRUNDMODUS ist der Weg ZURÜCK und eine vollwertige Wahl**, kein Leer-Zustand: ein Radio
  kann sich nicht selbst abwählen, ohne diese Zeile wäre das erste Einschalten eine Einbahnstrasse.
  Er trägt `GRUNDMODUS_TITEL`/`GRUNDMODUS_SATZ` („Ohne Betriebsmodell fährt Ihr Speicher den
  Eigenverbrauchs-Fahrplan …").
- **⚠ Die GRUPPE kommt vom SERVER, der Katalog ist nur der Rückfall**
  (`p.exklusivGruppe ?? anwendung(p.id)?.exklusiv_gruppe`): ein älterer Server ohne das Feld liefert
  damit trotzdem die richtige Gruppierung, und ein neuerer bleibt die Wahrheit.
- **Vor JEDEM Umschalten steht die WECHSEL-KARTE** (`regeln/folgen.ts` `wechselFolgen` /
  `ausschaltFolgen` im Haus-`ConfirmDialog`): was ENDET, was BEGINNT, was GLEICH bleibt, der Rückweg.
  **⚠ Block 2 nennt eine GEMESSENE Zahl, nie eine Vorhersage** — was der Wechsel bringt, rechnet erst
  die Kunden-Vorschau (Stufe 7); bis dahin steht dort, was das endende Modell BISHER gebracht hat,
  plus das ehrliche „Nicht abschätzbar". Eine geschätzte Differenz wäre die erfundene Zahl, die das
  Leitprinzip verbietet. **Ein Klick allein schreibt NICHTS** — erst das Ja der Karte.
- **⚠ Es geht IMMER nur EIN Aufruf hinaus** (`waehleModell` in `pages/SteuerungSection.tsx`): das
  Abschalten des alten Modells macht der SERVER in derselben Transaktion. Zwei Aufrufe nacheinander
  hätten ein Fenster, in dem beide oder keines an ist.
- **⚠ ALTBESTAND: `zone.aktiv` ist bei zwei aktiven Modellen bewusst `null`** — es gibt kein EINES,
  also behauptet die Fläche keines. Der Banner (`altbestandSatz`) FORDERT eine Wahl, nimmt sie aber
  nicht vorweg: es wird nichts automatisch abgeschaltet. `waehleModell` nennt in der Wechsel-Karte
  dann die ANDEREN laufenden als das, was endet — sonst verschwiege sie genau die Folge, wegen der
  gefragt wird. Der Altbestand zählt über ALLE Karten, auch die eingeklappten (ein abgeleitetes
  Signal fragt nicht nach der Hardware).
- **⚠ „läuft seit …" wird nie gerechnet und nie geraten** (`laeuftSeit`): `null` heisst „nicht
  belegt", nie „läuft nicht" — ein abgeleitet aktives Modell hat gar keine gespeicherte Zeile. Eine
  ZUKUNFTS-Zeit (Uhren-Versatz) wird ebenfalls verschwiegen; „läuft seit morgen" ist keine Aussage.
- **Die Voraussetzungs-AMPEL führt zum Beheben** (`ampel` → `AmpelZeile.weg`): ein Weg wird NUR
  gezeigt, wenn die Voraussetzung fehlt UND es wirklich ein Klickziel gibt. Ein Wert, den VoltPilot
  einträgt, bekommt den Satz `DURCH_VOLTPILOT` statt eines Knopfs ins Leere. **⚠ Eine Voraussetzung
  OHNE `art` gilt als HARDWARE** — die vorsichtigere Lesart: sie verspricht nie, ein Klick würde
  reichen. Die drei Ziele (`einstellungen` · `modell` · `ladepark`) sind die einzigen, die es gibt;
  der Ladepark wohnt auf DIESER Seite und wird gescrollt, nie navigiert (ein Nav-Sprung liefe im Kreis).
- **Was diese Anlage NICHT kann, steht EINGEKLAPPT mit seinem Grund** (`nichtMoeglichTitel` /
  `nichtMoeglichGrund`) — ein toter Radio-Knopf zwischen den wählbaren wäre eine Zusage, die die
  Anlage nicht halten kann. **Nicht möglich ist nur, wo HARDWARE fehlt**; eine fehlende Einstellung
  lässt die Karte wählbar (sie ist behebbar).
- **⚠ Der Co-Optimierungs-Streifen ist ERSATZLOS entfallen** (`coOptimization`/`socReservationStack`/
  `CoOptimizationStrip`/`batteryModes` gibt es nicht mehr; Abbau-Wächter in `migration.test.ts`):
  seit Stufe 5 läuft immer nur EIN Betriebsmodell, ein Streifen über die gemeinsame Optimierung
  zweier erklärte also einen Zustand, den die Fläche gerade abschafft — und auf einem Altbestand
  argumentierte er GEGEN die Wahl, um die die Zone bittet. Er war zugleich der einzige Verbraucher
  der admin-only `optimizerApi.configViaSwitcher` auf einer Kundenfläche.
- **Der Wizard-Schritt „Betrieb" fährt DENSELBEN Mechanismus** (`components/AnlageFlow.tsx`): die
  exklusiven Modelle sind Radios, ein gruppenloses bleibt ein Schalter, und die Gruppe trägt die
  Zeile „Kein Betriebsmodell". **⚠ Ein Radio WÄHLT AUS, es hakt sich nicht bloss an** (`waehleModell`
  dort) — im Altbestands-Fall sind beide angehakt, und ein „nur einschalten, wenn aus"-Klick wäre auf
  beiden ein No-op: der Kunde könnte die Anlage im Assistenten gar nicht mehr entwirren.
  **⚠ `angeboten` wächst, es schrumpft nie** — ohne dieses Set verschwände die Radiogruppe in dem
  Moment, in dem der Kunde „Kein Betriebsmodell" wählt (die Zeile stand nur, weil sie vorgeschlagen
  war), und mit ihr der Weg zurück.
- **Beweise:** rein `betriebsmodelle.test.ts` (22) · `regeln/folgen.test.ts` (+10) ·
  `migration.test.ts` (+7) ; DOM `pages/SteuerungSection.test.tsx` (36, davon 8 neu) ·
  `components/AnlageFlow.test.tsx` (+4).

