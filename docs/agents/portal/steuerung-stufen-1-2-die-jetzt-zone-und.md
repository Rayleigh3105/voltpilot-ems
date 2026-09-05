# Steuerung Stufen 1+2: die Jetzt-Zone und die Regel-Karten

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 17).


Konzept `data/vp-steuerung-konzept-b3` §3.2/§3.3/§3.5/§3.6 + §5 Stufen 1–2 (Captain-Entscheide
25.08.2026). Reine Portal-Arbeit auf bestehenden Endpunkten — **es entsteht kein Backend, keine
Migration und kein neuer Vertrag.** Eine Anlage ohne Regeln und ohne laufenden Handeingriff
rendert die Zonen mit ehrlichen Leer-Zuständen; alles Übrige ist zeichengleich zu vorher
(`migration.test.ts` „Steuerung Stufen 1+2").

### Zone ① „Jetzt" (`src/steuerungJetzt.ts` + `components/JetztZone.tsx`)

Eine Zeile je steuerbarer Sache — Speicher · Gerät · Ladepark —, jede mit **Zustand · Grund ·
Quelle · Handlung**. Sie steht ganz oben, weil die tägliche erste Frage „was passiert JETZT?"
lautet; bis dahin beantwortete sie auf dieser Seite keine Fläche.

- **⚠ Es entsteht KEINE zweite Wahrheit.** Jede Zeile ist eine Komposition bestehender,
  anderswo geprüfter Ableitungen: `control.controlStrip`/`batteryDirection`/`controlReasonSlot`
  · `fahrplanWhy.slotWhy` · `curtailment.curtailTruth` · `consumers/status.consumerStatusLine`
  · `consumers/fulfillment.overrideLine`/`sofortAktionen` · `ladepunkte.budgetBand`. Wer hier
  einen eigenen Satz baut, bricht genau die Zusage, für die es die Zone gibt.
- **Fünf Ehrlichkeitsregeln, jede einzeln gepinnt:** ohne Rücklesen wird KEIN Speicher-Zustand
  behauptet (die Zeile entfällt) · ein Gerät, das sich nicht meldet, sagt das statt „aus" ·
  eine Handlung, die strukturell nichts bewirken kann, wird NICHT angeboten (`keinEingriff`
  nennt stattdessen den Grund — die `registerZugang`-Regel) · der Ladepark zählt **Stecker, nicht
  Säulen** (ein Fahrzeug ist ein Stecker) · und die Quelle wird nie geraten (`unbekannt` ist
  ein vollwertiges Urteil).
- **⚠ Der Speicher hat KEINEN Handeingriff, und die Zeile sagt das** (`SPEICHER_KEIN_EINGRIFF`).
  Ein Batterie-Override ist Stufe 4 des Konzepts (er braucht ein Edge-Release); ein Knopf, der
  heute nichts bewirkt, wäre eine Zusage, die die Anlage nicht hält.
- **⚠ Die Batterie-Regel-Quelle wird ÜBERGEBEN, nie geraten.** `JetztZone` bekommt
  `speicherRegelAktiv` von der Seite, die es aus den ECHTEN Ansprüchen ableitet
  (`regeln/zustand.beanspruchtSpeicher` über die aktiven Flow-Dokumente). Eine frühere Fassung
  riet es an einer Id-Präfix-Heuristik (`id.startsWith('batt')`) — das ist genau die erfundene
  Zuordnung, die das Haus verbietet.
- Der **Banner mit Countdown** (`restZeit`, Live-Takt) steht GENAU EINMAL, in Zone ① — dort,
  wo der Eingriff passiert; die Regel-Karte behält ihre eigene Zustands-Zeile. Der frühere
  zweite Banner in der Regeln-Kapsel ist ersatzlos entfallen.
- Der Handeingriff selbst ist der UNVERÄNDERTE `ConsumerOverrideDialog` (Ink 5) — er zieht nur
  ins Zeilen-Menü um.

### Zone ② „Regeln": die Folgen-Karte vor JEDER Aktivierung (`src/regeln/folgen.ts`)

- **Vor dem Einschalten steht eine Folgen-Karte, nach dem Schalten der Beleg** (Leitprinzip
  Regel 2). `regelFolgen` baut die vier Blöcke des Konzepts (§3.5: Das passiert · Auswirkung
  auf den Fahrplan · Das bleibt gleich · Ende/Rücknahme) als Haus-`ConfirmDialog`.
- **⚠ Wo keine Zahl belegbar ist, steht „Nicht abschätzbar" — nie eine erfundene.** Die
  Fahrplan-Auswirkung in Euro kommt erst mit Stufe 7 (Kunden-What-if); bis dahin sagt die Karte
  genau das (`NICHT_ABSCHAETZBAR`/`KEIN_FAHRPLAN`), statt zu schweigen oder zu schätzen. Der
  Wächter `begruendung.test.ts` deckt sie mit ab.
- **AUSschalten fragt NICHT** (`fragen(karte, an)` gibt bei `an === false` sofort `false`
  zurück): eine Rücknahme nimmt eine Zusage zurück, sie gibt keine.

### Der VORRANG-Hinweis ist nach der SACHE getrennt (`src/regeln/satz.ts`)

- `VORRANG_FOLGEN` (Variante 1, in der Folgen-Karte) und `VORRANG_ZEILE` (Variante 3, unter dem
  Schalter) tragen je einen `speicher`- und einen `geraet`-Zweig. **⚠ Das ist keine Kosmetik,
  sondern die Echtheits-Regel des Hauses:** heute geht auf einem GERÄT die Regel wirklich vor
  (der Optimierer wirft dort auf keiner Anlage einen konkurrierenden Wunsch ein), auf dem
  SPEICHER gewinnt der Fahrplan (Klasse `market` Rang 60 schlägt `flow` Rang 40, und eine Regel
  auf einem Speicher, den ein Betriebsmodell fährt, lehnt der Server ab). „Ihre Regel geht vor"
  wäre dort eine Zusage, die die Anlage nicht hält.
- **Der Umschaltpunkt ist benannt:** mit Stufe 3 (A3–A5 des Konzepts) bekommt der
  `speicher`-Zweig den Wortlaut des `geraet`-Zweigs — EINE Konstante, kein Umbau. `migration.test.ts`
  hält bis dahin fest, dass er nichts anderes behauptet.
- `IMMER_ZEILE` nennt seither nur noch, was WIRKLICH jede Regel überlebt (Geräteschutz,
  Netzvorgaben, Vorrang der Sofortaktionen) — der pauschale Fahrplan-Vorrang stand dort falsch.

### „Solar-Überschuss" ist eine Bedingung des Baukastens (`src/regeln/ueberschuss.ts`)

- Sie ist bewusst **kein Katalog-Knoten**: `site.pv_surplus_kw` kann heute NUR die
  Verbraucher-Politik ausführen (der Flow-Katalog hat keinen `site.*`-Knoten, und die Palette
  kennt das Signal nicht). Ein neuer Knoten bräuchte api + Portal + flowc + Palette + ein
  Edge-Release, und bis dahin stürbe jede so gebaute Regel beim Aktivieren an
  `compiler_rejected` — der dokumentierte #518-Fehler.
- Deshalb ist die Auswahl im Baukasten eine **ehrliche Übergabe**: sie erklärt in einem Satz,
  dass diese Bedingung über den Verbraucher-Weg läuft, und der Fuß-Knopf wird „Weiter zum
  Verbraucher-Baukasten". Der Baukasten emittiert für sie NIE ein Dokument
  (`buildCondition` gibt `null`, `submit` verweigert vorher).

### Die Rezept-Galerie ist zu VORBELEGUNGEN geworden (Captain-Entscheid „nur Builder")

- **⚠ `components/RezeptGalerie.tsx` ist GELÖSCHT** und mit ihr `rezeptGalerie`/`GALERIE_FRAGE`/
  `GALERIE_INTRO`/`rezeptGrund` (der `roleLabel`-Präzedenzfall: eine Ableitung ohne Aufrufer ist
  toter Code). „＋ Neue Regel" öffnet jetzt den BAUKASTEN; die Rezepte stehen als Startpunkt-
  Reihe darüber (`regeln/rezepte.vorbelegungen` + `.vp-startpunkte`), der freie Editor als
  zweiter, ruhiger Weg im Aufklapper darunter — er ist eine ANDERE Mechanik, keine zweite
  Fassung derselben.
- **Ein Startpunkt VERBELEGT, er baut nichts fertig.** „Speicher schützen" hat in der Galerie
  hinter dem Rücken des Kunden einen Flow erzeugt UND gespeichert; jetzt füllt es den Baukasten
  (`setKomponentenRegel` + `setCreating`), der Kunde sieht die Regel, und vor dem Aktivieren
  steht die Folgen-Karte. Gepinnt (mutationsgeprüft) in `SteuerungSection.test.tsx`.
- **⚠ Der `key` am `GuidedRuleBuilder` ist tragend:** er liest `initialRule` NUR beim Montieren
  (`useState`-Seed) — ohne ihn bliebe das Formular stehen, wenn ein Startpunkt es vorbelegt,
  während der Dialog schon offen ist.
- **Ein Startpunkt ist eine EINLADUNG, also steht dort nur, was diese Anlage bauen kann.** Der
  Rest wird GEZÄHLT und, wo alle denselben Grund teilen, beim Namen genannt — verschwiegen wird
  nichts, aber es gibt keinen toten Knopf mehr (Befund B7: dieselbe Sackgasse dreimal). **⚠ Der
  Rollen-Vorfilter `plantRoles` ist GRÖBER als die Maschine dahinter** (er liest die Rolle aus
  Typ/Kategorie, `speicherSchutzRegel` braucht einen gemessenen Ladestand), deshalb entscheidet
  über „Speicher schützen" dieselbe Funktion, die danach baut — **im Browser aufgefallen, nicht
  im Test**: der Startpunkt wurde angeboten und tat beim Klick nichts.
- **„Sag mir Bescheid" wird nicht mehr angeboten** (der Zustellweg fehlt), aber gezählt — die
  ehrliche Vertagung wandert damit aus einer Karte in eine Zeile.
- Der **leere Zustand** der Kapsel ist EIN Satz mit dem Weg statt der Galerie; ohne schaltbares
  Gerät nennt er `KOMPONENTE_ANLEGEN` und führt ins Anlagen-Modell.
- **⚠ Das Flex-Kind ist das `li`, NICHT der Knopf darin.** Eine Größenregel am Knopf ist
  wirkungslos, und die Kacheln bekommen ausgefranste rechte Kanten (im Browser gemessen:
  432/453/481/495 px in einer 495-px-Reihe) — `.vp-startpunkte > li` trägt `flex`, der Knopf
  `width: 100%`.

**Beweise:** rein `steuerungJetzt.test.ts` (24) · `regeln/folgen.test.ts` (13) ·
`regeln/ueberschuss.test.ts` (5) · `regeln/rezepte.test.ts` (16) · `migration.test.ts` (+5) ;
DOM `components/JetztZone.test.tsx` (5) · `components/GuidedRuleBuilder.test.tsx` (+3) ·
`pages/SteuerungSection.test.tsx` (30). Im echten Chrome gegen den laufenden Demo-Stack bei
**1440 und 375** durchgespielt (Zone ①, leerer Zustand, Startpunkte, Vorbelegung, Folgen-Karte):
0 px horizontaler Überlauf, 0 überstehende Elemente, Startpunkt-Kacheln 310×77 px am Telefon.

