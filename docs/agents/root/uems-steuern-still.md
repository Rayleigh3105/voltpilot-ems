# UEMS-Regel: wer nur misst, hört nichts vom Steuern — und findet trotzdem hin

Neu am 15.09.2026. Kein Backend, keine Migration, kein Vertrag. Captain über firstmate 003/004, wörtlich:
„Von steuern soll beim messen eigentlich noch nicht die rede sein." — „Nimm überall die Empfehlung" — „Okay ich
will aber schon das Messkunden auch zu Kunden werden wo man verbraucher steuern kann."

Die Regel verbietet das AUFDRÄNGEN, nicht die ERREICHBARKEIT. Kollidieren beide, gewinnt die Erreichbarkeit.
Fundstellen und Entscheide: `data/vp-uems-steuern-im-messen-grenze/stellen.md` (firstmate), Abschnitte A und B
umgesetzt, C bewusst nicht.

| Teil | Datei |
|---|---|
| Die Regel als EIN Fakt je Standort: `steuernSpricht` — mindestens eine seiner Anlagen nimmt teil | `frontend/portal/src/uebersicht.ts` · `uebersicht.test.ts` |
| Standort-Karte der Unternehmens-Übersicht und Kopf der Standort-Übersicht: `funktionsZeilen` — Messen immer, Steuern nur, wenn der Standort spricht | `uebersicht.ts`, `components/StandortGruppeKopf.tsx` · `uebersicht.test.ts`, `components/Uebersicht.test.tsx` |
| Karte „Funktionen": Abschnitt „Steuern & Optimieren" nur mit sprechenden Standorten, sonst ganz weg; kein Schritt „… einrichten" mehr | `uebersicht.funktionenKarte`, `components/FunktionenKarte.tsx` · `funktionenKarte.test.ts` |
| Steuerungsseite einer Anlage, die nur misst: KEIN Hinweis (der Leerzustand „Diese Anlage misst nur." aus PR 776 ist entfernt, die Seite liest `GET /funktionen` nicht mehr) | `pages/SteuerungSection.tsx` · `pages/SteuerungSection.test.tsx` |
| Erreichbarkeit: Bereich „Steuerung" in Seitenleiste und Telefon-Leiste auch ohne steuerbare Komponente | `anlageNav.ts` (unverändert) · `anlageNav.test.ts` |
| 375/1440 px | `e2e/leerzustaende.spec.ts` (`nie`, `wege`), `e2e/uebersicht.spec.ts` (`ohneSteuern`) |

## Die Fallen

1. **Die Ebene ist die ANLAGE, gezählt an den Anlagen, die `GET /funktionen` unter DIESEM Standort nennt** —
   dieselbe Quelle wie die Zeile, die dann erscheint. Werk Ahrenberg spricht, weil Halle 1 teilnimmt, und nennt dort
   „Halle 2 aufnehmen"; Werk Lindach schweigt; die Anlage Halle 2 schweigt auf IHRER Seite. Nie „hat eine steuerbare
   Komponente" als Auslöser: auch ein Messkunde MIT Ladepunkt bleibt still, bis er selbst anstößt.
2. **„Teilnimmt" ist breiter als „steuert".** Entwurf, eingerichtet und angehalten sprechen mit — diese Zustände gibt
   es nur auf Anstoß des Kunden, und sie zu verschweigen nähme ihm den Weg zurück. Nur `kein_objekt` und `archiviert`
   schweigen. Die Zahl „1 steuert" (`steuertTeil`) zählt dagegen weiter nur `aktiv`.
3. **„reine Messung" bleibt** (Kopfzeile, Standort-Zahlen): es benennt, was der Kunde ist. Nicht als „Wort über
   Steuern" herausfiltern — und nicht dort ergänzen, wo es bisher nicht stand (Kopf der Standort-Übersicht).
4. **Die Zusage „immer beide Funktionen, nie eine Leerstelle" (PR 771, E6 = C) ist abgelöst — nur für Steuern.**
   Messen bleibt immer eine benannte Zeile, auch „Noch nicht eingerichtet". Wer eine Funktion ergänzt, entscheidet
   für sie ausdrücklich, ob sie schweigen darf.
5. **Der Bereich „Steuerung" bleibt, still.** Nicht entfernen, keinen Hinweis und kein Abzeichen ergänzen, das zum
   Einschalten drängt. Steuerart (Zeile der Verbraucher-Zone) und „＋ Neue Regel" sind bis zum Assistenten
   „Steuern & Optimieren" (AP-01 IP-10a) der Weg — `SteuerungSection.test.tsx` und `anlageNav.test.ts` prüfen ihn.
6. **Nicht angefasst (Bestand vor UEMS, Abschnitt C, eigene Frage):** Einführung „Drei Zonen, drei Fragen",
   `JetztZone` „Für diese Anlage steuert VoltPilot noch nichts …", Betriebsmodelle, Cockpit-Hinweis „Betriebsmodell
   wählen", Hilfe `help/content/steuerung.ts`. Die Prüfungen der Steuerungsseite nennen darum die entfernten Sätze
   einzeln, nicht „kein Wort über Steuern".
7. **Nach einem Umzug** (AP-02 IP-11) nennt `GET /funktionen` eine Anlage unter zwei Standorten: der alte mit der
   aktiven Teilnahme spricht, der neue schweigt, obwohl seine Zahlen „1 steuert" sagen — Befund in
   `uebersichtNachUmzug.test.ts`, gehört dem Server.
8. **Kein neuer Einstieg „ich will steuern" hier.** Der auffindbare, nicht aufdrängende Ort außerhalb der
   Steuerungsseite (naheliegend „Funktionen" im Avatar-Menü, AP-01 E5 = A) ist noch nicht gebaut.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/uebersicht.test.ts src/funktionenKarte.test.ts src/anlageNav.test.ts \
  src/uebersichtNachUmzug.test.ts src/pages/SteuerungSection.test.tsx src/components/Uebersicht.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/leerzustaende.spec.ts e2e/uebersicht.spec.ts --project=desktop-chromium)
```
