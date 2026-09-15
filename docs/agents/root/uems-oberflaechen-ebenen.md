# UEMS AP-13 IP-2: die Ebenen-Seiten am Standort — Gebäude, Anlagen, Kennzahlen und Berichte

Angelegt am 15.09.2026. Meilenstein 3 „Die Leiste am Standort“: Gebäude und Anlagen des Standorts bekommen ihre
Seite, Kennzahlen und Berichte ihre gefilterte Fassung am Standort — und die Telefon-Leiste erscheint von selbst, weil
sie sich aus `EBENEN_SEITEN` ableitet. Kein Backend, keine Migration, keine neue API-Route. Spezifikation: AP-13 §8
IP-2, E4 = A, Ü6–Ü8, Z4; Referenzfälle O17/O18.

| Seite | Adresse | Datei (`frontend/portal/src/…`) |
|---|---|---|
| Standort › Gebäude | `#/standort/{id}/gebaeude` | `pages/StandortGebaeudePage.tsx`: Ortsbaum (AP-02 IP-7) + „Stand am“ (AP-02 IP-13), Hülle `Ortsbaum.gebaeudeKarte` |
| Standort › Anlagen | `#/standort/{id}/anlagen` | `pages/StandortAnlagenPage.tsx`: `PortfolioCockpit` mit `nurAnlagen` |
| Kennzahlen dieses Standorts | `#/standort/{id}/kennzahlen[/{id}]` | `pages/KennzahlenPage.tsx` mit `standort` (`kennzahlKarte.amStandort`: `standort_id`) |
| Berichte dieses Standorts | `#/standort/{id}/berichte[/{kennung}]` | `pages/BerichtePage.tsx` mit `standort` (`berichtSeite.amStandort`: `geltung_art = standort`) |
| Ableitung | — | `ebenenNav.ts`: `EBENEN_SEITEN` (+4), `standortEinstiege`, `ebenenAktiv`; `nav.ts`: `StandortBereich`, `standortBereichRoute`, `kennzahlRoute`/`berichtRoute` mit `standortId` |

Tests: `ebenenNav.test.ts` (Block „AP-13 IP-2“: O17 vier/drei Kacheln, O18, Z4, Ü8, Lesezeichen),
`uemsOberflaechen.test.ts` (O17 vor/seit IP-2), `standortWelten.test.ts`, `Ortsbaum.test.tsx` (Hülle),
`e2e/standort-ebenen.spec.ts` (375/1440, `STANDORT_EBENEN_BILDER=<Ordner>`). Bühne:
`ansicht=werk-gebaeude|werk-anlagen|werk-kennzahlen|werk-berichte|lindach-gebaeude|lindach-anlagen`, `&orte=leer`
(Werk Lindach ohne Gebäude).

## Die Fallen

1. **Kennzahlen und Berichte sind am Standort SEITEN, aber keine BEREICHE.** AP-01 §4.6 und O17 zählen am Standort
   Übersicht · Gebäude · Anlagen · Messstellen (Werk Ahrenberg vier, Werk Lindach drei Kacheln). `EBENEN_SEITEN` trägt
   `kennzahlen`/`berichte` auch am Standort, `ebenenBereiche` erzeugt sie dort nie — ihr Einstieg sind die zwei Knöpfe
   unter dem Standort-Kopf (`standortEinstiege`: Berichte, sobald der Standort misst; Kennzahlen zusätzlich mit einer
   lebenden Kennzahl mit `standort_id` = Standort). `ebenenAktiv` hebt dort die Übersicht hervor. Wer sie zu Kacheln
   macht, bricht O17 — das braucht einen Entscheid.
2. **Als oberste Ebene trägt `PortfolioTabs` Gebäude · Anlagen** (`standortBereiche` aus `ebenenReiter`); unter einem
   Unternehmen trägt sie `EbenenTabs`. Am Rechner sind die Reiter der einzige Weg — die Leiste blendet CSS dort aus.
3. **Die Karte je Gebäude ist nur eine Hülle.** `Ortsbaum.gebaeudeKarte` bekommt erst einen Aufklapper, wenn es Inhalt
   zurückgibt; die Seite reicht heute nichts hinein (kein Knopf ohne Ziel). IP-10 legt Energie · Messstellen ·
   Kennzahlen hinein.
4. **EIN Datumsfeld je Seite:** die Gebäude-Seite liest `GET /standorte?stichtag=` selbst („gab es noch nicht“,
   archiviert) und reicht den Stichtag an den Baum; mit Stichtag kein Schreibweg. Nach dem Speichern lädt
   `App.reload()` die Orte neu — das erste Gebäude lässt den Bereich „Gebäude“ erst entstehen.
5. **„Standort › Anlagen“ ist dieselbe Tabelle** (`PortfolioCockpit nurAnlagen`) ohne Kennzahlen-Leiste, „Anpassen“,
   Funktions-Zustände und Karte „Funktionen“; die Standort-Übersicht bleibt zeichengleich. Der Weg „Energiebilanz“ je
   Zeile steht seit IP-8 — nur mit Hauptzähler in der Stellung (`uems-bilanz-flaeche.md`).
6. **Z4:** unter zwei Anlagen kein Bereich „Anlagen“, ohne Gebäude kein Bereich „Gebäude“ — die Adressen gelten
   trotzdem (eine Zeile bzw. L1 aus AP-02). Ein unbekannter Bereich (`#/standort/{id}/xyz`) landet auf der Übersicht.
7. **Lesezeichen:** `#/portfolio/kennzahlen[/{id}]`, `#/portfolio/berichte[/{kennung}]`,
   `#/portfolio/messstellen[/{id}]` bleiben die Adressen des Unternehmens (Test „Adressen“). Eine Kennzahl oder ein
   Bericht aus der Standort-Liste öffnet sich IM Standort, der Rückweg heißt „… dieses Standorts“ (`zurListe`).
   `uemsOberflaechen.sprungziel` springt weiter in die Welt des Unternehmens.
8. **Befund zu O18:** ein Betriebskunde MIT Gebäude-Objekten und zwei Anlagen bekommt die Leiste Übersicht · Gebäude ·
   Anlagen — AP-01 §4.6 fragt beide Bereiche nicht nach „Messen“. Ohne Gebäude (O18) bleibt er ohne Leiste;
   Einstiege gibt es nur mit Messen.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/ebenenNav.test.ts src/uemsOberflaechen.test.ts src/standortWelten.test.ts src/components/Ortsbaum.test.tsx src/copy.test.ts)
(cd frontend/portal && STANDORT_EBENEN_BILDER=/tmp/ebenen npx playwright test e2e/standort-ebenen.spec.ts e2e/telefonleiste.spec.ts e2e/messstellen.spec.ts --project=desktop-chromium)
```
