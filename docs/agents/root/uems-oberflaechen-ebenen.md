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
3. **Die Karte je Gebäude trägt seit IP-10 Energie · Messstellen · Kennzahlen.** `Ortsbaum.gebaeudeKarte`
   bleibt ihr Wirt; Quellen und Grenzen: [Gebäude-Karte](uems-gebaeude-karte.md).
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
8. **O18 gilt auch mit Gebäuden und mehreren Anlagen.** AP-13 E2/Q2 ist gegenüber AP-01 §4.6 die jüngere,
   speziellere Bestandsregel (firstmate-Entscheid IP-14): `EBENEN_SEITEN(ort, lm)` gibt die vier AP-13-Seiten
   Gebäude · Anlagen · Kennzahlen · Berichte nur mit Messfunktion dieses Standorts frei. Reiter, Telefon-Leiste,
   `uemsOberflaechen.kacheln` und Einstiege reichen dasselbe Lesemodell durch. Unbekannt ist keine Freigabe.
   Direkte Adressen zeigen über `standortBereichFuer` in `App.tsx` wie vor AP-13 die Standort-Übersicht;
   Messstellen-Adressen bleiben unverändert. O17 bleibt vier/drei Kacheln. Der alte Befund ist damit aufgelöst.

## Abschluss und Bestandsschutz (IP-14)

Bezugsstand für Q2/O18 ist **84f8307ffbd668cf5dcd0cbb1f4ebfedf84062a3** (15.09.2026, AP-13 §8.4),
der Konzeptstand vor AP-13; nicht der jeweils letzte Stand von `uems`. Die HTML-Aufnahmen wurden mit denselben
Tests auf einem frischen `git archive` dieses Stands erzeugt. `src/uemsBestandsschutz.test.tsx` schützt
Start-Ebene, sechs Verlauf-Reiter, Portfolio-Reiter und Standortnavigation; die mit „AP-13 Bestandsschutz“
benannten Fälle in den bestehenden Komponententests vergleichen Cockpit, sechs Verlauf-Flächen, Portfolio
und Geräteseite bytegenau. Aufnahme und Wiederholung: [Nachweis und Befehle](../../../frontend/portal/src/test/bestandsschutz/README.md).
Die erlaubte Cockpit-Ergänzung prüft `CockpitMessstellenWeg.test.tsx`; leere UEMS-Bausteine prüft
`UebersichtBausteine.test.tsx`. Keine Aufnahme am neuen Produktstand erneuern, um eine Abweichung zu übergehen.

Quellen und Zone: [Werte und Verlauf](uems-oberflaechen-werte-verlauf.md),
[Energiebilanz](uems-oberflaechen-energiebilanz.md), [Sprünge](uems-oberflaechen-spruenge.md).

## Release-Note IP-7: Datenlage der Karte „Funktionen“

> **„Messen & Auswerten“ zeigt dieselbe Datenlage wie das Messstellenregister.** Auch berechnete Messstellen
> zählen mit; Messstellen ohne Datenquelle bleiben im Nenner. Manuell abgelesene Messstellen werden zusätzlich
> genannt. Beim Referenzstandort Werk Ahrenberg heißt die Zeile jetzt „15 von 16 Messstellen liefern Daten ·
> 1 manuell abgelesen“ statt „13 von 13 Messstellen liefern Daten“. Die Messwerte selbst ändern sich dadurch nicht.

Ausgeliefert mit IP-7 (`52a54dcbd9174b4ad08980560033b81796e0d48c`); dies dokumentiert die vorhandene Änderung,
keine neue Zählregel. Vorher „13 von 13“ ist die Portal-Fixture vor IP-7; ältere Ableitungsbeispiele enthalten
auch „13 von 14“. Maßgeblich ist immer das Register-Aggregat, einschließlich archivierter Zeilen.
Details: [eine Zählung](uems-uebersicht-bausteine.md#e13--die-datenlage-zeile-der-karte-funktionen).
Es gibt keinen zentralen UEMS-Release-Notes-Ordner; wie beim [Berichte-Abschluss](uems-berichte-abschluss.md)
liegt die Release-Note im fachlichen Wegweiser.

## Prüfen

```bash
(cd frontend/portal && npx vitest run src/ebenenNav.test.ts src/uemsOberflaechen.test.ts src/standortWelten.test.ts src/components/Ortsbaum.test.tsx src/copy.test.ts)
(cd frontend/portal && STANDORT_EBENEN_BILDER=/tmp/ebenen npx playwright test e2e/standort-ebenen.spec.ts e2e/telefonleiste.spec.ts e2e/messstellen.spec.ts --project=desktop-chromium)
```
