# Steuerung Stufe 4: die Jetzt-Zone kann eingreifen

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 19).


Die Portal-Hälfte der Handeingriffe (Konzept `data/vp-steuerung-konzept-b3` §3.2 + §3.5; die
Technik steht im Wurzel-`AGENTS.md`). Die Stufe-1-Zeile „Ein Eingriff von Hand am Speicher ist
noch nicht möglich" ist damit abgelöst — sie war ausdrücklich als Platzhalter markiert.

- **Alles Abgeleitete liegt rein in `src/handeingriff.ts`** (19 Unit-Fälle); `JetztZone.tsx` lädt,
  rendert und ruft. Die zwei Flächen sind der **Zeilen-Eintrag** „Eingreifen ▾" am Speicher
  („Speicher jetzt laden" · „Ladestand halten") und der **ruhige Knopf unter der Liste**
  („Automatik pausieren") — die Pause ist bewusst KEINE Zeile: sie gilt allen Komponenten, und als
  Zeile stünde sie fälschlich neben ihnen.
- **⚠ Die ZAHL der Folgen-Karte wird nie erfunden.** `planVerzicht` summiert die Fahrplan-Slots bis
  zum gewählten Ende (`batteryKw` × 0,25 h × `importPriceCtKwh`) — aus DERSELBEN Antwort, die das
  Diagramm zeichnet. Drei Fälle liefern statt einer Zahl den GRUND: kein Plan, ein Plan der das
  Fenster nicht abdeckt, oder ein Slot ohne Preis. **Ein Slot ohne Preis macht die GANZE Zahl
  unbestimmbar**, statt still mit weniger Slots zu rechnen — das ergäbe eine zu kleine Zahl, die wie
  eine echte aussieht.
- **⚠ Der Block „Das bleibt gleich" ist keine Beruhigung, sondern eine Konstruktions-Aussage:**
  § 14a, die Einspeise-Wache, die Abregelung und der Geräteschutz liegen UNTERHALB der Arbitrierung
  in der Guard-Kette — ein Handeingriff kann sie strukturell nicht erreichen. Er steht deshalb an
  JEDER der vier Handlungen, auch an der Rücknahme.
- **⚠ Der Satz zum Netzladen verspricht nichts:** „Aus dem Netz wird dabei nur geladen, wenn Ihre
  Anlage das darf" — die Entscheidung fällt auf dem GERÄT (`charge_from_grid_allowed`), und ein
  Satz, der sie vorwegnähme, wäre auf einer EEG-Anlage falsch.
- **⚠ Die ANLAGEN-Pause geht im Banner VOR einem Geräte-Eingriff.** Zwei Banner gäbe es nie, und
  das obere muss das Umfassendere sein. Ihre `entityId` ist der Sentinel `PAUSE_BANNER_ID`
  (`'__anlage__'`) — eine geliehene Komponenten-Id wäre unehrlich, und die Fläche erkennt daran,
  welchen Rückweg sie aufruft.
- **⚠ Ein Knopf, der strukturell nichts bewirken kann, wird NICHT angeboten** (`speicherAktionen`) —
  an seiner Stelle steht der Grund (`speicherKeinEingriff`): eine nicht gesteuerte Anlage, oder eine
  laufende Pause (dort IST die Pause der Eingriff, und ihr Rückweg ist ihr eigener Knopf).
- **⚠ Ladestand und Ladeleistung stehen auf dieser Fläche nicht belegt zur Verfügung** (das
  Rücklesen trägt den Sollwert, nicht den Stand) — die Folgen-Karte lässt die Klammern dann weg,
  statt eine Zahl zu erfinden.
- **Fail-soft wie die ganze Zone:** ein älteres Backend kennt `GET /interventions` nicht, dann ist
  die Zone Zeichen für Zeichen die der Stufe 1.
- **Beweise:** `handeingriff.test.ts` (19) · `steuerungJetzt.test.ts` (+4: beide Eingriffe, der
  Grund statt des Knopfes, der laufende Eingriff als Quelle, die Anlagen-Pause).

