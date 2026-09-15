# UEMS-Fläche: Modus „nur messen" beim Anlegen einer Anlage

Neu am 15.09.2026. Kein Backend, keine Migration, kein Vertrag. Captain wörtlich: „Von Steuern soll beim Messen
eigentlich noch nicht die Rede sein. Ebenso eine Frage, darf ich ohne Anlage auch einfach Messstellen anlegen?" —
übernommen ist Empfehlung A: ein Modus im BESTEHENDEN Anlege-Fluss, kein zweiter Weg daneben. Die Regel dahinter:
`uems-steuern-still.md` (verboten ist das Aufdrängen, nicht die Erreichbarkeit).

| Teil | Datei |
|---|---|
| Die Entscheidung als EIN Fakt: `anlegeArt` = `steuernSpricht` des Standorts, an dem die Anlage entsteht (ohne Wahl das Unternehmen, Wiedereinstieg der Standort der Anlage, ohne Funktionen oder Standort-Objekt wie heute); Schritte, Ziel, Sätze und die Wortliste `STEUER_GELD_WOERTER` | `frontend/portal/src/anlegeNurMessen.ts` · `anlegeNurMessen.test.ts` |
| Fluss: `GET /funktionen` IN der Entscheidung; ohne Geld weder Veräußerungsform noch Feineinstellungen, kein Schritt „Betrieb", Fertig und erste Daten mit „Zu den Messstellen" + „Zur Anlage"; `kopf` für die Schrittzahl des Einrichtungs-Assistenten (`startklarSatz`) | `components/AnlageFlow.tsx`, `anlageFlow.ts`, `Onboarding.tsx` · `components/AnlageFlow.nurMessen.test.tsx` |
| Bestandsschutz: ein Kunde mit Steuern, Schnappschüsse VOR dem Paket aufgenommen (eigener Commit) | `components/AnlageFlow.bestand.test.tsx`, `components/__snapshots__/anlage-bestand-*.html` |
| Das Ziel: `onDone(ziel)` → Drawer `onChanged(id, ziel)` und danach die Adresse; `App` navigiert selbst, der Einrichtungs-Assistent über `finishOnboarding(ziel)` | `components/AnlageAnlegenDrawer.tsx`, `AnlageAnlegenDrawerLazy.tsx`, `App.tsx` |
| Erreichbarkeit: eine frisch angelegte Anlage ohne Komponente behält den Bereich „Steuerung" | `ebenenNav.test.ts` |
| 375/1440 px und Bilder beider Modi | `e2e/anlage-anlegen.spec.ts` auf `anlage-anlegen.html` (`?wirt=assistent`); `ANLAGE_ANLEGEN_BILDER=<Ordner>` |

## Die Fallen

1. **Kein Schalter, sondern der Fakt der Übersicht.** Nie „hat eine steuerbare Komponente" oder eine Wahl im Fluss als
   Auslöser — derselbe `steuernSpricht` wie in `uebersicht.ts`. Ein Standort ohne Anlage schweigt also.
2. **Die Ebene ist der Standort, an dem die Anlage entsteht — nicht die neue Anlage.** Die nimmt nie teil; an ihr
   gemessen wäre jeder Fluss still, und ein Kunde mit Steuern sähe weniger als heute. Beim Wiedereinstieg zählt der
   Standort der bestehenden Anlage, nicht ihre Teilnahme (Halle 2 an Werk Ahrenberg → wie heute).
3. **In der Entscheidung laden** (`uems-leerzustaende.md` Falle 4): solange `GET /funktionen` unterwegs ist, fehlen
   Geld-Block, „Betrieb" und der Satz „In … Schritten"; ein Fehler heißt „wie heute". Zwei Tests in
   `AnlageFlow.test.tsx` suchen „Feineinstellungen" darum mit `findByText`.
4. **Die Standort-Wahl wechselt den Modus in Schritt 1** (Ahrenberg: vor der Wahl wie heute, Werk Lindach still).
   Verborgenes wird NICHT gesendet: der Körper ist der eines unberührten Blocks, eingetippte Werte bleiben nur im Formular.
5. **Nach dem Anlegen steht die Art fest** (`artBeimAnlegen`) — die neue Anlage steht noch nicht in den geladenen Funktionen.
6. **`onDone` trägt ein Ziel.** Jeder Aufruf ist ausdrücklich `() => onDone()`, nie `onClick={onDone}` (sonst würde das
   Klick-Ereignis zum Ziel); `onSkip={() => finishOnboarding()}` aus demselben Grund. Der Typ-Check fängt die Knopf-Fälle.
7. **Geprüft wird gegen die Wortliste, nicht gegen Sätze** — über den ganzen lesbaren Text samt `aria-label` und
   Platzhaltern. Bewusst NICHT darauf: „Marktstammdaten", „Betrieb" allein („In Betrieb seit"), „Einspeisung" und
   „Regel" allein. Die Gegenprobe beim Kunden mit Steuern zeigt, dass der Abtaster beißt.
8. **Nicht umgebaut:** der Hinweis im Assistenten „Messen & Auswerten" bleibt ein Satz ohne Knopf (`keineAnlageWeg`,
   firstmate 002); die Leerzustände „Noch keine Anlage" von `UebersichtPage` und `AnlagenPage` (sie liegen VOR dem Fluss
   und sprechen weiter von Fahrplan und Erlösen) — Befund im PR, eigene Frage.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/anlegeNurMessen.test.ts src/anlageFlow.test.ts src/components/AnlageFlow.nurMessen.test.tsx \
  src/components/AnlageFlow.bestand.test.tsx src/components/AnlageFlow.test.tsx src/components/AnlageFlow.standort.test.tsx \
  src/ebenenNav.test.ts src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/anlage-anlegen.spec.ts --project=desktop-chromium --project=mobile-chromium)
```
