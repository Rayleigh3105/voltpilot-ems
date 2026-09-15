# UEMS-Fläche: Telefon-Leiste je Ebene (AP-01 IP-7, E4 = A)

Neu am 15.09.2026. Kein Backend, keine Migration. Captain-Entscheid E4 = A (10.09.2026): „Leiste = Bereiche der
Ebene mit Inhalt; unter drei Bereichen keine Leiste". Dazu firstmate 001 (15.09.2026): alle Bereiche nach der
Tabelle AP-01 §4.6 ableiten, aber **eine Kachel erscheint erst, wenn ihre Seite eingehängt ist** — dieselbe Antwort
wie an der Karte „Funktionen" (PR 771): ein Knopf ohne Ziel ist die Sackgasse, die das Portal nicht baut.

| Teil | Datei |
|---|---|
| Bereiche (rein): `ebenenBereiche` aus `GET /standorte`, `/funktionen`, `/kennzahlen`; Kacheln `ebenenLeiste` (nur mit Seite, ab `EBENEN_LEISTE_AB` = 3); Seiten `EBENEN_SEITEN`; `ebenenOrt`, `ebenenAktiv`, `ebenenTitel` | `frontend/portal/src/ebenenNav.ts` (früher `anlageNav.ts`, der Anlagen-Teil ist unverändert) · `ebenenNav.test.ts` (Prüfnachweis 1–5) |
| Schale: EINE Leiste, in der Anlage deren Bereiche, sonst die der Ebene (Prop `ebenen`) | `src/shell/AppShell.tsx` · `AppShell.test.tsx` |
| Laden: `/kennzahlen` in derselben Welle wie `/overview` + `/funktionen` (Geld-Regel), nur auf einer Ebene | `src/App.tsx` |
| Fixture `GET /kennzahlen` (KZ-0001…0003 aus dem Referenzunternehmen) | `src/test/kennzahlenFixtures.ts` |
| 375 px + Bilder | `e2e/telefonleiste.spec.ts` auf der Bühne `e2e/startansicht.tsx` (`&seiten=kuenftig` = Bild mit eingehängten Seiten); `TELEFONLEISTE_BILDER=<Ordner>` |

## Die Regel

| Ebene | Bereich | existiert |
|---|---|---|
| Unternehmen | Übersicht | immer |
| | Standorte | ab 2 Standorten (archivierte zählen nicht) |
| | Messstellen · Berichte | sobald ein Standort misst |
| | Kennzahlen | sobald ein Standort misst UND es eine nicht archivierte Kennzahl gibt |
| Standort | Übersicht | immer |
| | Gebäude | ab 1 Gebäude (`gebaeudeZahl`) |
| | Anlagen | ab 2 Anlagen, die ihm heute zugeordnet sind |
| | Messstellen | wenn DIESER Standort misst |

„Misst" = „Messen & Auswerten" ist eingerichtet, angehalten oder aktiv; ein Entwurf misst noch nicht.

## Die Fallen

1. **Seit AP-04 IP-5 hat das Unternehmen Ahrenberg DREI Kacheln — die Leiste ist da** (`uems-messstellen-register-portal.md`).
   Übersicht, Standorte und Messstellen haben eine Seite (`#/portfolio`, `#/portfolio/standorte`, `#/portfolio/messstellen`);
   die Standorte bleiben bei zwei (Übersicht · Messstellen) und ohne Leiste. Es fehlen noch Kennzahlen und Berichte (AP-13,
   AP-12), Gebäude und Anlagen des Standorts (AP-13) — wer eine davon baut, trägt die Route in `EBENEN_SEITEN` ein und
   passt den Test „jede Seite, die es heute gibt" und `telefonleiste.spec.ts` an.
2. **Nie eine Kachel ohne Seite**, auch nicht „zum Reservieren": E4 hat „immer fünf Kacheln, auch leere" verworfen,
   und `copy.test.ts` verbietet „in Vorbereitung".
3. **Unbekannt ist nie vorhanden.** Fehlt `/funktionen` oder `/kennzahlen` (älteres Backend, Fehler, lädt), entstehen
   die Mess-Bereiche nicht; ohne Standorte (`ebenenOrt` = `null`) gibt es gar keine Ebene — alles wie vorher.
4. **Keine Steuerungs-Kachel auf Unternehmen oder Standort** (Steuern-Regel, `uems-steuern-still.md`): gesteuert
   wird je Anlage. Der Weg bleibt über die Übersicht in die Anlage, deren Kachel „Steuerung" unverändert steht.
5. **In einer Anlage gewinnt ihre Leiste** — `App.tsx` reicht `ebenen` nur ohne offene Anlage.
6. **Gelöst mit AP-04 IP-5:** am Telefon ist, was die Leiste als Kachel trägt, kein zweites Mal Reiter (`vp-nur-rechner`,
   Variante B); am Rechner bleiben die Reiter der einzige Weg — der Standort unter einem Unternehmen hat dafür `EbenenTabs`.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/ebenenNav.test.ts src/shell/AppShell.test.tsx src/migration.test.ts src/copy.test.ts)
(cd frontend/portal && TELEFONLEISTE_BILDER=/tmp/leiste npx playwright test e2e/telefonleiste.spec.ts --project=desktop-chromium)
```
