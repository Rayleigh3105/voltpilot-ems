# UEMS-Fläche: Modus „nur messen" beim Anlegen einer Anlage

Neu am 15.09.2026, erste Minute ergänzt am 18.09.2026 (AP-14 IP-4). Kein Backend, keine Migration, kein Vertrag. Captain wörtlich: „Von Steuern soll beim Messen
eigentlich noch nicht die Rede sein. Ebenso eine Frage, darf ich ohne Anlage auch einfach Messstellen anlegen?" —
übernommen ist Empfehlung A: ein Modus im BESTEHENDEN Anlege-Fluss, kein zweiter Weg daneben. Die Regel dahinter:
`uems-steuern-still.md` (verboten ist das Aufdrängen, nicht die Erreichbarkeit).

| Teil | Datei |
|---|---|
| Die Entscheidung als EIN Fakt: `anlegeArt` = ohne Standort + ohne Anlage zuerst Standort; mit Bestandsanlage wie heute; sonst `steuernSpricht` des Standorts (ohne Wahl das Unternehmen, Wiedereinstieg der Standort der Anlage); `null` entscheidet nichts | `frontend/portal/src/anlegeNurMessen.ts` · `anlegeNurMessen.test.ts` |
| „Zuerst den Standort“ öffnet den vorhandenen `StandortDialog`; nach dem Speichern lädt derselbe Anlagenfluss seine Entscheidung neu und fährt dort fort | `components/StandortZuerst.tsx`, `components/AnlageFlow.tsx` |
| Leerzustände „Noch keine Anlage“: bei einem Standort ohne Steuerung Messwerte statt Fahrplan/Erlöse; mit Steuerung oder ohne Standort-Bezug heutiger Text | `useAnlegeArt.ts`, `pages/UebersichtPage.tsx`, `pages/AnlagenPage.tsx` |
| Erreichbarkeit nach eigenem Anstoß: auf der Steuerungsseite einer nur messenden Anlage öffnet ein rechtlich geschützter, sachlicher Einstieg den vorhandenen `SteuernAssistent` für Anlage und Standort; Übersicht und Karte „Funktionen“ bleiben still | `pages/SteuerungSection.tsx`, `components/SteuernAssistent.tsx` |
| Fluss: `GET /funktionen` IN der Entscheidung; ohne Geld weder Veräußerungsform noch Feineinstellungen, kein Schritt „Betrieb", Fertig und erste Daten mit „Zu den Messstellen" + „Zur Anlage"; `kopf` für die Schrittzahl des Einrichtungs-Assistenten (`startklarSatz`) | `components/AnlageFlow.tsx`, `anlageFlow.ts`, `Onboarding.tsx` · `components/AnlageFlow.nurMessen.test.tsx` |
| Bestandsschutz: ein Kunde mit Steuern, Schnappschüsse VOR dem Paket aufgenommen (eigener Commit) | `components/AnlageFlow.bestand.test.tsx`, `components/__snapshots__/anlage-bestand-*.html` |
| Das Ziel: `onDone(ziel)` → Drawer `onChanged(id, ziel)` und danach die Adresse; `App` navigiert selbst, der Einrichtungs-Assistent über `finishOnboarding(ziel)` | `components/AnlageAnlegenDrawer.tsx`, `AnlageAnlegenDrawerLazy.tsx`, `App.tsx` |
| Erreichbarkeit: eine frisch angelegte Anlage ohne Komponente behält den Bereich „Steuerung" | `ebenenNav.test.ts` |
| Knopf „Messanlage anlegen“ im Assistenten „Messen & Auswerten“ (Schritt 2 ohne Anlage, 23.09.2026): `standortId` belegt Schritt 1 vor (nur, wenn er zur Wahl steht), `rueckkehr` ersetzt „Zu den Messstellen“ + „Zur Anlage“ durch EINEN Knopf ohne Ziel | `AnlageFlow.tsx`, `AnlageAnlegenDrawer(Lazy).tsx`, `MessenAssistent.tsx`, `messenAssistent.ts` · `MessenAssistent.messanlage.test.tsx`, `AnlageFlow.nurMessen.test.tsx`; Bestand ohne Vorbelegung: `AnlageFlow.bestandNurMessen.test.tsx` (`__snapshots__/anlage-nur-messen-bestand-*.html`, vor dem Knopf aufgenommen); Bilder `e2e/messen-assistent.spec.ts` |
| 375/1440 px und Bilder beider Modi | `e2e/anlage-anlegen.spec.ts` auf `anlage-anlegen.html` (`?wirt=assistent`); `ANLAGE_ANLEGEN_BILDER=<Ordner>` |

## Die Fallen

1. **Kein Schalter, sondern der Fakt der Übersicht.** Nie „hat eine steuerbare Komponente" oder eine Wahl im Fluss als
   Auslöser — derselbe `steuernSpricht` wie in `uebersicht.ts`. Ein Standort ohne Anlage schweigt also.
2. **Die Ebene ist der Standort, an dem die Anlage entsteht — nicht die neue Anlage.** Die nimmt nie teil; an ihr
   gemessen wäre jeder Fluss still, und ein Kunde mit Steuern sähe weniger als heute. Beim Wiedereinstieg zählt der
   Standort der bestehenden Anlage, nicht ihre Teilnahme (Halle 2 an Werk Ahrenberg → wie heute).
3. **In der Entscheidung laden** (`uems-leerzustaende.md` Falle 4): solange `GET /funktionen` unterwegs oder nicht lesbar ist, fehlen
   Geld-Block, „Betrieb", „Zuerst den Standort" und der Satz „In … Schritten". Zwei Tests in
   `AnlageFlow.test.tsx` suchen „Feineinstellungen" darum mit `findByText`.
4. **Die Standort-Wahl wechselt den Modus in Schritt 1** (Ahrenberg: vor der Wahl wie heute, Werk Lindach still).
   Verborgenes wird NICHT gesendet: der Körper ist der eines unberührten Blocks, eingetippte Werte bleiben nur im Formular.
5. **Nach dem Anlegen steht die Art fest** (`artBeimAnlegen`) — die neue Anlage steht noch nicht in den geladenen Funktionen.
6. **`onDone` trägt ein Ziel.** Jeder Aufruf ist ausdrücklich `() => onDone()`, nie `onClick={onDone}` (sonst würde das
   Klick-Ereignis zum Ziel); `onSkip={() => finishOnboarding()}` aus demselben Grund. Der Typ-Check fängt die Knopf-Fälle.
7. **Geprüft wird gegen die Wortliste, nicht gegen Sätze** — über den ganzen lesbaren Text samt `aria-label` und
   Platzhaltern. Bewusst NICHT darauf: „Marktstammdaten", „Betrieb" allein („In Betrieb seit"), „Einspeisung" und
   „Regel" allein. Die Gegenprobe beim Kunden mit Steuern zeigt, dass der Abtaster beißt.
8. **Der Standort-Vorlauf ist kein zweiter Anlegeweg.** Er benutzt den bestehenden `StandortDialog`, kehrt in
   `AnlageFlow` zurück und fügt weder Route noch API hinzu. Eine vorhandene Anlage ohne Standort überspringt ihn.
9. **Still heißt nicht Sackgasse.** Übersicht, Karte „Funktionen“ und Anlege-Fluss bieten Steuern nicht an. Erst wer
   selbst den bestehenden Anlagenbereich „Steuerung“ öffnet, sieht Zustand plus Einstieg; dieser öffnet den
   vorhandenen Standort-Assistenten und braucht `funktion.steuern_einrichten`.
10. **Die Vorbelegung ist kein Schalter.** Der Knopf im Messen-Assistenten gibt nur den Standort mit; still wird der
    Fluss, weil ein Standort ohne Anlage nicht von Steuern spricht. Derselbe Einstieg an einem steuernden Standort
    liefe wie heute (Test „vom Wirt vorbelegt … kein Schalter“). Wechselt der Kunde in Schritt 1 den Standort, gilt
    Falle 4 — die Rückkehr bleibt trotzdem der eine Knopf zurück.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/anlegeNurMessen.test.ts src/anlageFlow.test.ts src/components/AnlageFlow.nurMessen.test.tsx \
  src/components/AnlageFlow.bestand.test.tsx src/components/AnlageFlow.bestandNurMessen.test.tsx src/components/AnlageFlow.test.tsx src/components/AnlageFlow.standort.test.tsx \
  src/components/MessenAssistent.messanlage.test.tsx src/ebenenNav.test.ts src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/anlage-anlegen.spec.ts --project=desktop-chromium --project=mobile-chromium)
```
