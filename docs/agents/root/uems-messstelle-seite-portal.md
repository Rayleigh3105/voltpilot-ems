# UEMS-Fläche: die Messstellen-Seite — Ort · Elektrisch · Organisation (AP-04 IP-8)

Neu am 15.09.2026. Kein Backend, keine Migration. Bericht: `data/vp-uems-ap04-messstellen/report.md`
§5.4, §5.12, §5.14, Mockups R2 · Z4; Paket §8 IP-8. Die Seite ist das Ziel des Registers (IP-5).

| Teil | Datei |
|---|---|
| Ableitung (rein): Abschnitte aus den Intervallen, Karten + Historie, Zeitform des gewählten Tags, Bisher/Folgen, Prüfen, Anfragen, Ablehnungen | `frontend/portal/src/messstelleZuordnung.ts` · `messstelleZuordnung.test.ts` |
| Seite: Kopf (Zustand, Quelle aus dem Register), drei Karten, „Ändern ab …“, `<details>` „Historie (n)“, Protokoll | `src/pages/MessstelleSeite.tsx` (+ `.css`) · `pages/MessstelleSeite.test.tsx` |
| Dialog „Ändern ab <Tag>“ (Ort · Stellung · Prozesse · Kostenstellen) mit `VpDatePicker`, Bisher, „Was geschieht“ | `src/components/ZuordnungAendernDialog.tsx` (+ `.css`) |
| Routen `#/portfolio/messstellen/{id}` und `#/standort/{sid}/messstellen/{id}` (`Route.messstelleId`, `messstelleRoute`); `MessstellenPage` schaltet mit `messstelleId` auf die Seite, der Name jeder Registerzeile ist der Einstieg | `src/nav.ts`, `src/App.tsx`, `src/pages/MessstellenPage.tsx` |
| Abschnitt „Werte“ direkt unter dem Kopf (AP-13 IP-3, E9/E12 = A): `WerteSektion` mit Periode/Version aus der Adresse, Einstiege „Letzter Wert“ + Zeilenmenü „Werte“ (Rechner) und ganze Karte (Telefon) | `src/components/WerteSektion.tsx`, `src/pages/MessstelleSeite.tsx`, `MessstellenPage.tsx` (`onWerte`), `src/nav.ts` (`parseMessstelleWerte`), `src/App.tsx` (`springe`); Regeln `uems-tageskarte.md` Falle 11 |
| Verlauf im Abschnitt „Werte“ (AP-13 IP-4 = AP-08 IP-10): Tag · Woche · Monat · Jahr, Lücken als Flächen, Marker, Schritt-Karte | `src/components/MessstellenVerlauf.tsx`, `src/uemsVerlauf.ts`; Regeln `uems-verlauf-messstelle.md` |
| Warum eine Zahl fehlt (AP-13 IP-6): Grund-Satz unter dem Strich mit den Namen der Register-Quelle, Auskunft bei 400/404, Leerzustand „Keine Datenquelle“ mit „Quelle zuordnen“ (Dialog ab Schritt 3), Zeile „Weitere Größen“ | `src/uemsWerteKarte.ts`, `src/uemsOberflaechen.ts` §6, `src/components/WerteSektion.tsx`; Regeln `uems-werte-gruende.md` |
| Antworten nur aus Ahrenberg (MS-06 heute, MS-08 vor/nach dem Umzug am 01.03.2027, MS-10 als Hauptzähler für F21, Protokoll der Einführung) | `src/test/messstelleSeiteFixtures.ts` |
| 375 px (`mobile-chromium`) und 1440 px (`desktop-chromium`) mit Messung und Bildern | `e2e/messstelle-seite.spec.ts` (Bühne `messstelle-seite.html`); `MESSSTELLE_SEITE_BILDER=<Ordner>` |

Geschrieben wird über die bestehenden Routen: `PUT …/messstellen/{id}/ort|stellung` (AP-04 IP-7),
`…/prozesse` (AP-10 IP-7), `…/verteilung` (AP-10 IP-8). Gelesen: `GET …/{id}`, `…/prozesse`,
`…/verteilung`, das Register von heute, Standorte + Ortsbäume (Namen), die Kataloge und
`…/aenderungen?achse=eintrag`.

## Die Fallen

1. **Zwei Listen, zwei Ordnungen.** Die HISTORIE einer Karte ist der Zeitstrahl des Sachverhalts
   (Abschnitte nach „gilt ab“, der jüngste Beginn oben, Lücken bleiben stehen); die Intervalle tragen
   keine Eintragungszeit. Das PROTOKOLL steht nach der EINTRAGUNG (`MESSSTELLE_PROTOKOLL_ACHSE`,
   Captain-Entscheid 15.09.2026 für jede Verlaufsliste: sonst rutscht ein nachgetragener Eintrag
   zwischen alte Zeilen). Wer eine neue Verlaufsliste baut, nimmt `achse=eintrag`.
2. **Das Kennzeichen des Tags ist der Vertrag, nicht ein Vergleich.** `zeitformAm` ruft
   `uemsOrtsbaum.rueckwirkung` mit `eingetragenUm = mitternacht(heute)` (wie `flaecheAendern.ts`):
   „rückwirkend (n Tage)“ mit den nachträglich betroffenen Tagen, „geplant“, ab heute ohne Marke.
   „Heute“ ist der `stichtag` des Registers (der Server), nicht die Uhr des Browsers.
3. **Derselbe Tag wie der Beginn des laufenden Intervalls ist `korrektur: true`** (Ort, Stellung,
   Verteilung) — sonst 409 `gleicher_tag`. `prozesse` kennt kein `korrektur`.
4. **Ein Satz aus mehreren Zeilen ist EIN Abschnitt.** Prozesse und Anteile sind Mengen je Tag;
   `abschnitte` verschmilzt gleiche Nachbarn über den Schlüssel (Anteil normalisiert über `dez` +
   `dezKuerze` — „100.0“ ist „100“).
5. **Nicht geladen ist keine leere Zuordnung.** Scheitert `…/prozesse` oder `…/verteilung`, sagt die
   Zeile „Gerade nicht abrufbar.“ und bietet kein „Ändern ab …“.
6. **Keine zweite Regel:** 100 % über `uemsVerteilung.satz`, Ort/Stellung-Ablehnungen über
   `messstelleDialog.ablehnung` (FEHLER-Tabelle §5.12), Picker-Optionen über `ortWahlen`,
   `anlageWahlen`, `stellungOptionen`, `unterzaehlerOptionen` des Dialogs. Hauptzähler, Zyklus und
   Überlappung urteilt der Server.
7. **Testing Library normalisiert U+00A0 zu einem Leerzeichen** — `getByText('… 100 %')` mit
   normalem Leerzeichen; die reinen Tests pinnen das geschützte Leerzeichen.
8. **Die Quelle-Karte steht seit AP-04 IP-14 über den Zuordnungs-Karten** (`components/QuelleKarte.tsx`,
   abgeleitet in `quelleBinden.ts` aus `GET …/quellen` — die Seite liest sie selbst): je Messgröße die
   führende Quelle und jede Vergleichsquelle mit ihren Werten NEBENEINANDER (E3), die Historie mit jeder
   Lücke und die Einstiege „Quelle binden“ · „Vergleichsquelle hinzufügen“. Der Kopf nennt weiterhin nur
   die führende Quelle (aus `zeileWoerter`); ein „Zähler wechseln“ gibt es erst mit IP-18.
   Siehe `uems-quelle-binden-portal.md`.

9. **Die Werte stehen oben, die Adresse trägt Periode und Version (AP-13 IP-3).** Mit `periode=` holt die Seite den
   Abschnitt nach dem Laden in den Blick (`scrollIntoView({ block: 'nearest' })` — steht er schon im Bild, bleibt die
   Seite stehen; keine geschätzte Kopfhöhe). Der Register-Einstieg ist ein Seitenwechsel (`App.springe`, wie
   `navigate` mit der Adresse des Sprungs), eine neue Wahl in der Sektion ersetzt nur die Adresse. Am Rechner steht die
   Liste NEBEN Zone/Zeit-Leiste/Karte (ab 960 px, `.vp-mss-werte .vp-wk`), darunter wie im Dialog. Das Zeilenmenü und
   der Knopf am letzten Wert erscheinen nur mit Wirt (`onWerte`) — die Bühne `startansicht` hat keinen, ihre Spalten
   bleiben sieben. Am Telefon deckt der Knopf am Namen die Karte ab (`::after`): Playwright tippt auf die KARTE (`li`),
   nicht auf ein `dd` darunter, sonst meldet es „intercepts pointer events“.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/messstelleZuordnung.test.ts src/pages/MessstelleSeite.test.tsx \
  src/pages/MessstellenPage.test.tsx src/nav.test.ts src/ebenenNav.test.ts src/copy.test.ts src/uemsWerteKarte.test.ts)
(cd frontend/portal && MESSSTELLE_SEITE_BILDER=/tmp/mss npx playwright test e2e/messstelle-seite.spec.ts \
  --project=mobile-chromium --project=desktop-chromium)
```
