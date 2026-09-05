# Eigene Auswertung: die Fläche der Kunden-Kennzahl (Anwendungs-Programm Stufe 5)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 15).


Der Kunde baut sich aus einem Messwert seiner Anlage eine Kachel oder einen Verlauf. Regeln,
Katalog, Vertrag und Server-Seite stehen in der Root-`AGENTS.md` („Eigene Auswertung"); hier die
Fläche. **Ohne einen einzigen Eintrag rendert das Cockpit zeichengleich wie vorher.**

- **`src/eigeneAuswertung.ts` ist die reine Hälfte** — Vokabular, die EHRLICHKEITSREGEL (der
  Zwilling des Servers, geteilte Vektoren `docs/contracts/v2/eigene-auswertung-vectors.json`),
  Einheit, Zeitbezug, Titel-Vorschlag, Entwurf und seine Fehler. Die Fläche rendert nur.
- **Der EINE Weg führt über den ANPASSEN-MODUS** („+ Eigene Auswertung"). Eine eigene Kachel IST
  eine Anordnungs-Entscheidung, also wohnt sie dort, wo der Kunde ohnehin anordnet — und sie
  erscheint SOFORT an ihrer kanonischen Stelle (hinter den Kennzahlen), nie als Anhängsel unten
  (`mitEigenen`). **Ist die Anwendung nicht eingeschaltet, gibt es den Knopf nicht:** ein Knopf,
  der nichts bewirken kann, wäre eine Zusage, die niemand einlöst.
- **⚠ „Ist sie an?" beantwortet das REGAL, nicht `modes`.** `eigene-auswertung` wird nie
  ABGELEITET, taucht in der M0-Projektion also gar nicht auf; gelesen wird `active` der Regal-Karte
  aus `useAnlageSurface().profiles` (deshalb destrukturiert `AnlagenPage` sie seit dieser Stufe).
- **⚠ Sichtbarkeit ≠ Speicherung.** `useCockpitLayout` trennt `alleEigene` (wandert IMMER ins
  gespeicherte Dokument) von den sichtbaren (`eigeneAktiv === false` ⇒ leer). Ohne die Trennung
  löschte ein Speichern bei abgeschalteter Anwendung genau die Definitionen, die ein
  Wiedereinschalten zurückbringen soll. **Im DOM-Test aufgefallen, nicht im Unit-Test.**
- **Der geführte Dialog** (`components/EigeneAuswertungDialog.tsx`) fragt in fünf Schritten:
  Komponente → Messwert → Kennzahl → Darstellung → Überschrift. Er lädt seinen Messwert-Baum ERST
  BEIM ÖFFNEN und benutzt dafür `verlauf.measurementTree` — **denselben Baum wie der
  Messwerte-Explorer**, also dieselben Namen, dieselben Kanäle, dieselbe v1-Rückfallebene; ein
  zweiter Katalog wäre eine zweite Wahrheit über dieselben Geräte.
- **⚠ Eine unehrliche Kennzahl VERSCHWINDET NICHT — sie bleibt sichtbar, gesperrt, mit ihrem
  GRUND.** Das ist die Picker-Hausregel („eine Sperre ohne Grund ist ein Rätsel"): ein Kunde, der
  „Tagessumme" nicht mehr sieht, sucht sie. Und ein Kanalwechsel rettet ein unehrlich gewordenes
  Aggregat auf `jetzt` (`nachKanalwechsel`), statt eine Kombination stehen zu lassen, die der
  Server ablehnt.
- **Der Titel wird VORGESCHLAGEN, nie erzwungen:** er folgt der Auswahl, solange der Kunde das Feld
  nicht angefasst hat — danach nie wieder.
- **Der Verlauf benutzt die BESTEHENDE Chart-Grammatik** (`VerlaufChart` auf `useEChart`/
  `chartTheme`, Chart-Redesign 10.08.), keine zweite Bibliothek und keine zweite Optik. Die Kachel
  trägt Zahl + Einheit + ZEITBEZUG („jetzt", „heute", „Höchstwert heute") — „3,25 kW" allein sagt
  nicht, wovon es der Wert ist.
- **Eine fehlende Zahl bleibt ein Strich** und die Karte sagt den Grund; der Werte-Abruf ist
  fail-soft wie jeder Zusatz-Abruf des Cockpits. **⚠ Eine im Anpassen-Modus FRISCH angelegte
  Kachel sagt „noch nicht gespeichert", nie „keine Messwerte"** — der Server antwortet nur für die
  GESPEICHERTEN, und die beiden zu verwechseln wäre die gefährlichere Auskunft (der Kunde suchte
  einen Datenfehler). Dafür gibt der Haken zusätzlich `eigeneGespeichert` heraus.
- **`CockpitAnpassen` bekam EINEN additiven `extra`-Slot je Zeile** — dort hängt der Stift einer
  eigenen Auswertung, am Rechner wie am Telefon. Er erscheint nur an ihren Zeilen
  (`AnpassenZeile.eigen`): ein Baustein des Katalogs hat nichts zu bearbeiten. **„Entfernen" wohnt
  bewusst IM Dialog**, nicht als vierter Knopf in der Zeile: es ist die einzige Handlung dieser
  Fläche, die etwas des Kunden endgültig wegnimmt, und Auge/Stern/▲▼ sind alle umkehrbar — ein
  Papierkorb daneben wäre einen Fehlklick vom Datenverlust entfernt.
- **Beweise:** `src/eigeneAuswertung.test.ts` (69, die geteilten Vektoren) ·
  `src/cockpitLayout.test.ts` (+9) · `src/migration.test.ts` (+2) ·
  `components/EigeneAuswertungDialog.test.tsx` (5) · `pages/AnlagenPage.test.tsx` (+6: Kachel mit
  Zahl/Einheit/Zeitbezug, kein erfundener Nullwert, unsichtbar ohne die Anwendung + kein Abruf,
  der Knopf nur im Anpassen-Modus, kein Knopf ohne die Anwendung, die frische Kachel sagt „noch
  nicht gespeichert").

