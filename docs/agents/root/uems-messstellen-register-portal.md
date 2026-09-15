# UEMS-Fläche: Messstellen-Register „Unternehmen › Messstellen“ und „Standort › Messstellen“ (AP-04 IP-5)

Neu am 15.09.2026. Kein Backend, keine Migration. Die Fläche liest NUR `GET /api/v1/messstellen`
(Lesemodell IP-4/IP-15, [`uems-messstellen-register-lesemodell.md`](uems-messstellen-register-lesemodell.md));
jeder Filter geht als Parameter an DIESELBE Route. Bericht: `data/vp-uems-ap04-messstellen/report.md`
§3, §5.11, §5.16, A17; Paket §8 IP-5.

| Teil | Datei |
|---|---|
| Ableitung (rein): Zeile → Wörter, „Stand am“ (`registerEintraege`, `ersterTag`), Filter-Parameter und -Optionen, Leerzustände, Kopfzeile | `frontend/portal/src/messstellen.ts` · `messstellen.test.ts` |
| Fläche: Tabelle am Rechner, Karten ≤ 720 px (`useIsPhone`), Filter (`VpPicker` + Schalter „Nur ohne Quelle (n)“), `StandAm` | `src/pages/MessstellenPage.tsx` (+ `.css`) · `pages/MessstellenPage.test.tsx` |
| Routen `#/portfolio/messstellen` (PageId `portfolio-messstellen`) und `#/standort/{id}/messstellen` (`Route.standortBereich`, `standortMessstellenRoute`); Lazy-Stück in `pageChunks.ts`/`pageTransition.ts` | `src/nav.ts`, `App.tsx` · `ebenenNav.test.ts` |
| Leiste und Reiter: `EBENEN_SEITEN` trägt beide Seiten, `ebenenReiter` (dieselben Bereiche, ab zwei), `ebenenAktiv(page, standortBereich)`; `PortfolioTabs` mit `showMessstellen` + `leiste`, `EbenenTabs` am Standort unter einem Unternehmen; `vp-nur-rechner` in `BereichTabs.css` | `src/ebenenNav.ts`, `components/PortfolioTabs.tsx`, `components/EbenenTabs.tsx` · `shell/PortfolioNav.test.tsx` |
| Kundenwörter `UEMS_QUELLE` · `UEMS_FUEHREND` · `UEMS_VERGLEICH` (neben `UEMS_MESSSTELLE`); Werkstatt-Wörter Primär-/Referenzquelle, Quellenbindung, „fuehrend“, „Meßstelle“ in `FORBIDDEN_INTERN` | `src/glossar.ts`, `src/copy.test.ts` |
| Antworten des Referenzunternehmens (MS-01 … MS-22, heute 20.10.2026 10:15, Stichtage, Filter) | `src/test/messstellenRegisterFixtures.ts` |
| 1440/375 px + Leisten-Nachweis auf der Bühne `e2e/startansicht.tsx` (`ansicht=messstellen`, `werk-messstellen`, `lindach-messstellen`; `reiter=alle` = Vorschau-Variante A) | `e2e/messstellen.spec.ts`, `e2e/telefonleiste.spec.ts`; `MESSSTELLEN_BILDER=<Ordner>` |

## Die Fallen

1. **Die Leiste des Unternehmens schaltet sich zu.** Mit den Messstellen hat Ahrenberg drei Bereiche mit Seite
   (Übersicht · Standorte · Messstellen) — die Telefon-Leiste erscheint. Die Standorte bleiben bei zwei (Übersicht ·
   Messstellen) und ohne Leiste. Wer die nächste Seite einhängt, ändert die Zahl wieder: `ebenenNav.test.ts`
   („jede Seite, die es heute gibt“) und `telefonleiste.spec.ts` (`unternehmen-heute`) mitziehen.
2. **Am Telefon steht kein Bereich doppelt** (gebaut: Variante B; die Vorschau zeigt A daneben). Ein Reiter, den die
   Leiste als Kachel trägt, bekommt `vp-nur-rechner` — CSS blendet ihn bis 720 px aus, dieselbe Grenze, an der die
   Leiste verschwindet. Auf „Standorte“/„Messstellen“ gibt es am Telefon dann gar keine Reiter, auf der Übersicht nur
   ihre eigenen (Übersicht · Messwerte · Erlöse). Am Rechner bleiben ALLE Reiter der Weg: die Ebene hat dort keine
   Seitenleisten-Bereiche.
3. **Der Standort unter einem Unternehmen braucht eigene Reiter** (`EbenenTabs`: Übersicht · Messstellen), sonst ist
   „Standort › Messstellen“ am Rechner eine Seite ohne Zugang. Ist der Standort die OBERSTE Ebene (reiner
   Messkunde), trägt `PortfolioTabs` den Reiter, und `navigateSchale` lenkt `portfolio-messstellen` auf
   `standortMessstellenRoute` — wie „Übersicht“ auf die Standort-Übersicht.
4. **„Gab es noch nicht“ ist abgeleitet, nicht geraten.** Das Register nennt JEDE Messstelle an jedem Stichtag und
   trägt kein Anlagedatum. Erster Tag = frühester Beginn von Ort, Stellung oder einer Quelle (auch einer Nebengröße)
   aus der Vertrags-Form `messstellen[]` DERSELBEN Antwort — die Bestandsübernahme bindet Quellen rückwirkend, also
   zählt die Quelle seit 2024, auch wenn der Ort erst 2026 kam. Liegt der Stichtag davor, steht an ihrem Platz der
   Satz `bestandSatz` wie auf „Standorte“ („Am 10.10.2026 gab es MS-16 „Netzbezug Lindach“ im Portal noch nicht.“).
   Ohne jede zeitgültige Tatsache (MS-20) nie. ⚠ Das Aggregat des Servers zählt solche Messstellen im Nenner mit —
   die Kopfzeile „x von y Messstellen liefern Daten“ steht darum nur heute.
5. **Der Lebenszyklus ist der von HEUTE** (der Server verschiebt ihn nicht) — mit Stichtag heißt die Spalte
   „Zustand (heute)“.
6. **Letzter Wert = Hauptgröße UND jede Nebengröße mit Wert** („Wirkleistung 312,4 kW 10:15 Uhr“): die Hauptgröße einer
   Strom-Messstelle ist meist ein Zählerstand. Stellen je Einheit wie E11 (kW/kWh/m³ 1, % 0), U+2212, U+00A0; kein
   Wert „—“, nie eine 0. Die Referenzdatei trägt keinen Zählerstand — in der Fixture bleibt `letzter_wert` `null`,
   die Momentanleistung reist als Nebengröße.
7. **Filter-Optionen kommen aus der UNGEFILTERTEN Antwort desselben Tags** (je Tag gemerkt, nicht neu gefragt): Ort nur
   Gebäude/Bereiche, an denen Messstellen stehen (den Teilbaum filtert der Server), Zustände nur vorkommende, eine
   Liste mit nur einer Wahl erscheint nicht. Jede Antwort gilt nur für ihren Tag und ihre Filter (Anfrage-Nummer).
8. **Kein Knopf ohne Ziel.** „Vorschläge aus Komponenten (n)“ aus §5.11 fehlt hier weiter: die Vorschlagsliste
   gibt es seit AP-01 IP-9b im Assistenten „Messen & Auswerten“ (Schritt 3, `uems-messen-assistent.md`); ein
   Knopf im Register, der ihn auf Schritt 3 öffnet, ist ein eigener Schritt. „Messstelle anlegen“ öffnet seit AP-04 IP-6 den `MessstelleDialog` — im Kopf, im Leerzustand
   „noch keine Messstelle“ am Satz; nie mit Stichtag, nie ohne „Messen & Auswerten“; hat ein Schritt gespeichert, liest
   die Fläche nach dem Schließen neu (Merker des Tags verworfen). Ohne „Messen & Auswerten“ nennt die Fläche den Satz und „Zur Übersicht“ (dort
   steht die Karte „Funktionen“). Kein Wort über Steuern, kein Geld-Baustein.
9. **„Datenpunkt“ ist NICHT bewacht** — `components/DeviceDrawers.tsx` spricht es im Bestand; die Regel hätte ein
   Bestands-Portalwort geändert.
10. **Tabelle: `overflow-wrap: break-word`, nie `anywhere`** — `anywhere` senkt die Mindestbreite einer Spalte auf ein
    Zeichen („Werk Ahrenber g“ in der ersten Vorschau).

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/messstellen.test.ts src/pages/MessstellenPage.test.tsx src/ebenenNav.test.ts \
  src/shell/PortfolioNav.test.tsx src/copy.test.ts src/pageTransition.test.ts src/migration.test.ts)
(cd frontend/portal && MESSSTELLEN_BILDER=/tmp/ms npx playwright test e2e/messstellen.spec.ts e2e/telefonleiste.spec.ts --project=desktop-chromium)
```
