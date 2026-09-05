# Verbrauchsmanagement v1 · P7: die FAHRZEUGE (je Ladekarte eine Steuerart)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 34).


Modell, Kontrakt und die Box-Hälfte stehen im Root-`CLAUDE.md` („Paket 7"). Hier nur, was
die FLÄCHE trägt. **Ohne ein einziges Profil rendert alles Zeichen für Zeichen wie vorher**
(in `LadevorgaengeSection.test.tsx` + `steuerungJetzt.test.ts` beidseitig festgenagelt).

- **`src/fahrzeugProfile.ts` ist die EINE reine Schicht** — Typen, Wörter, jede Ableitung;
  `components/FahrzeugeKarte.tsx` (in der Verbraucher-Zone) und `components/FahrzeugDialog.tsx`
  rendern nur.
- **⚠ Das Portal sieht den Klartext der Karte NIE.** Der Schlüssel ist der Pseudonym der Box,
  also heißt eine unbenannte Karte „Karte 1f2e…" (`kartenKurz`: die ersten vier Zeichen NACH
  `tagref_`) und nie „RFID 04A2B7". Die vier Zeichen sind das, woran ein Kunde die Zeile
  wiedererkennt — 24 Hexzeichen helfen niemandem.
- **⚠ BENANNT wird an ZWEI Orten mit EINEM Dialog:** in der Fahrzeuge-Karte und aus dem
  **Ladevorgangs-Verlauf** heraus (`verlaufFahrzeug` → `FahrzeugDialog` in
  `pages/LadevorgaengeSection.tsx`, Konzept §4.5 „dieser Ladevorgang war … → Name vergeben").
  Zwei Dialoge über dieselbe Sache wären zwei Wahrheiten.
- **⚠ `verlaufFahrzeug` SYNTHETISIERT die Zeile, solange die Liste die Karte nicht führt** —
  und das ist ehrlich, nicht geraten: derselbe Herzschlag, der die Ladung meldet, hat die
  Sichtung serverseitig geschrieben (`ChargerStatusListener` berührt JEDE gemeldete Karte).
  Ohne den Rückfall hinge der Weg daran, ob zwei Abrufe im selben Moment gelandet sind.
  **Ohne gemeldetes Pseudonym gibt es GAR KEINEN Knopf** — ein Knopf, der strukturell nichts
  benennen kann, ist Lärm.
- **⚠ Die Jetzt-Zeile nennt NUR ein BENANNTES Fahrzeug** (`SteuerungSection.fahrzeugVon` gibt
  für eine unbenannte Karte `null`): „Karte 1f2e…" beantwortete dort keine Frage, und die
  Zeile trüge ein Wort mehr ohne eine Aussage mehr. Es steht VOR der Quelle — „Lädt 11 kW ·
  Dienstwagen · Sofort laden": erst WER, dann WIE — und **nur an einer LAUFENDEN Ladung**
  (über einem freien Stecker wäre es eine Aussage über ein Auto, das nicht da ist).
- **⚠ Der Dialog bietet KEIN Ziel an, und er SAGT warum** (`KEIN_ZIEL_HINWEIS`): ein Ziel
  („bis 06:00 fertig") gehört zum Ladepunkt. Eine Wahl anzubieten, die der Server danach
  ablehnen müsste, ist die Sorte Zusage, die dieses Haus nicht macht — die `registerZugang`-
  Regel. Der Server prüft dieselbe Menge ein zweites Mal; dem Client zu glauben wäre keine
  Prüfung.
- **⚠ Der Dialog bringt sein Stylesheet SELBST mit** (`FahrzeugDialog.tsx` importiert
  `FahrzeugeKarte.css`; die RegelKarten-Lehre, **im Browser-Beweis gefunden, nicht im Test**):
  solange er nur EINEN Wirt hatte, war er zufällig gestylt, weil dieser die Datei importierte
  — der zweite (der Ladevorgangs-Verlauf) hätte eine ungestylte Fläche bekommen. Wächter ist
  `fahrzeugStyle.test.ts` (jsdom rendert kein Stylesheet, er liest deshalb den Quelltext).
- **Fail-soft überall:** ein älteres Backend ohne die Route lässt die Fahrzeuge-Karte weg und
  die Ladevorgänge-Seite rendert unverändert (`api.siteFahrzeuge` wird mit `catch` geholt).
- **Beweise:** `fahrzeugProfile.test.ts` (26) · `LadevorgaengeSection.test.tsx` (+5, inkl.
  „das Pseudonym steht nie vollständig im DOM") · `steuerungJetzt.test.ts` (+3) ·
  `fahrzeugStyle.test.ts` (3) + `components/FahrzeugeKarte.test.tsx` (7). Im echten Chrome (Wegwerf-Harness, `emulate`) bei **1440 und
  375** gemessen: 0 px horizontaler Überlauf, 0 überstehende Elemente, keine
  Konsolenmeldungen.

