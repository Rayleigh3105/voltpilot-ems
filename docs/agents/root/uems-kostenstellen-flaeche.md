# UEMS — Kostenstellen und Prozesse nebeneinander im Portal (AP-13 IP-9 = AP-10 IP-15, Listen-Teil)

Konzept: AP-13 §4.8 (B6/B7), §5.5, Kasten E8 = A, Referenzfall O9 (`frontend/portal/src/test/oberflaechenFaelle.json`);
Regeln und Route: `uems-kostenstelle-energie.md`, Objekte: `uems-kostenstelle-prozess.md`, Verteilung: `uems-verteilung.md`.

## Was wo steht

| Was | Wo |
|---|---|
| Ort | Unternehmen › Messstellen, Reiter **Liste · Kostenstellen · Prozesse** — `#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01` (`kostenstellenUebersicht.reiterHash`/`reiterAus`) |
| Rein | `frontend/portal/src/kostenstellenUebersicht.ts` — `kostenstellenBild` (Karten, Blöcke, Posten, Warnung, „nicht verteilt“), `prozesseBild`/`prozessSummen`, `reiterDa`, `kostenstellenImZeitraum`, `imZeitraum`/`vorherBeendet` |
| Render + Laden | `pages/KostenstellenSection.tsx` (+ `.css`): `KostenstellenReiter`, `ProzesseReiter`; die Reiter-Leiste und der Wirt stehen in `pages/MessstellenPage.tsx` (`MessstellenWelt`, Prop `organisation`) |
| Client | `api.kostenstelleEnergie(id, periode, am)` — **je Kostenstelle EIN Aufruf mit Zwischenspeicher** (`gemerkteAnfrage`, `GEMERKT_MS` = 120 s, Schlüssel mit Mandanten-Umschalter, eine Ablehnung wird nie gemerkt) |
| Wirt | `App.tsx`: `organisation = page === 'portfolio-messstellen' && !(Standort-Ebene mit Teilansicht)` — nie am Standort unter dem Unternehmen, nie in einer Teilansicht (die Sicht ist unternehmensweit) |
| Sprung hierher | `uemsOberflaechen.sprungziel({art:'kostenstelle', kennzeichen, periode?, am?})` → `…?reiter=kostenstellen&kostenstelle=4200`; die Karte wird hervorgehoben und in den Blick geholt (Aufrufer: IP-11) |
| Tests | `kostenstellenUebersicht.test.ts` (O9, F12, Prozess-Summe, Reiter), `uemsOberflaechen.test.ts` (Sprung), `copy.test.ts` (Welt Oberflächen), `e2e/kostenstellen.spec.ts` (`KOSTENSTELLEN_BILDER=<Ordner>`) |
| Bühne | `e2e/startansicht.html?bild=unternehmen&ansicht=kostenstellen` · `&ansicht=prozesse` · `&periode=tag&am=2027-01-15` (F12) · `&organisation=leer` (Bestand ohne Reiter) |

## Die Regel dieser Fläche: keine Summe über Kostenstellen

Der Satz steht dort, wo sonst ein Fuß „Summe aller Kostenstellen“ stünde — **vor** den Karten, damit er am Telefon vor der
ersten Zahl gelesen wird: „Die Kostenstellen sind nicht summierbar — nicht verteilte Mengen gehören keiner.“ (O9 Schritt 4).
Zwei Gründe, beide sichtbar: „nicht verteilt“ steht EINMAL über allen Karten und gehört keiner, und ein Posten kann in einem
anderen enthalten sein (MS-20 enthält MS-06, MS-11 und 70 % von MS-07) — die Warnung der Route steht als Zeile an der Karte
und **ändert keine Zahl**. `kostenstellenUebersicht.ts` hat darum kein Feld und keine Funktion über Karten hinweg; der Test
prüft die Schlüssel des Bildes, die Namen der Exporte und dass keine Zahl der Fläche eine Kartensumme summiert.

## Die Fallen

- ⚠ **`grund: keine_zuordnung` steht auch an einem einzelnen Block** („berechnet“ bei 4200), nicht nur an einer Kostenstelle
  ohne jede Zuordnung. Der Satz „Dieser Kostenstelle ist im Zeitraum keine Messstelle zugeordnet.“ gilt der KARTE erst,
  wenn auch `summe` diesen Grund trägt (9010 im Januar 2027); sonst ist der Strich des Blocks die ganze Aussage.
- ⚠ **Die Reiter heißen NICHT „Messstellen“** — die Liste heißt „Liste“. Der Reiter der Welt heißt schon so, und Playwright
  vergleicht `getByRole('tab', { name })` als Teilwort: zwei Treffer brechen `messstellen.spec.ts`.
- ⚠ **Eigenes CSS-Präfix `vp-ks-`**: `telefonleiste.spec.ts` zählt `.vp-ms-karte` (22 Registerkarten am Telefon).
- ⚠ **Ohne Kostenstelle und ohne Prozess gibt es keine Leiste** (`reiterDa` = leer) — das Register bleibt zeichengleich; ohne
  die Prop `organisation` fragt die Fläche die Kataloge gar nicht (Bühnen und Tests, die die Seite direkt rendern).
- ⚠ **„nicht verteilt“ kommt aus EINER Antwort** (in jeder Antwort des Kundenbereichs derselbe Block) und wird nie je Karte
  gezeigt; Hauptzähler stehen darin, weil die Verteilung keine Stellung kennt — die Fläche zeigt, was die Route sagt (O9
  Schritt 1), sie filtert nicht.
- ⚠ **Die Prozess-Summe ist eine berechnete Messstelle** (MS-20), kein Aggregat der Fläche. Es gibt keine Route „Messstellen
  eines Prozesses“: die Fläche fragt die Prozesse der BERECHNETEN Registerzeilen (Ahrenberg: fünf) und liest deren Wert über
  die Werte-Route. Ohne eine solche Messstelle steht der Satz, dass es keine Prozess-Summe gibt — nie eine addierte Zahl.
- ⚠ **Zeitraum und Reiter ersetzen die Adresse** (`replaceCurrentNavigation`), sie stapeln keine Schritte — wie die Zeit-Leiste
  der Energiebilanz. Der Zeitraum ist der der Bilanz-Leiste (Tag · Monat · Jahr, Vorgabe der letzte GEBILDETE Monat).
- ⚠ **Verteilung ändern bleibt die Karte „Organisation“ der Messstellen-Seite** (B7): diese Fläche liest nur; jeder Posten
  springt zur Messstelle mit Periode (`…/messstellen/{id}?periode=2026-10`).

## Nicht gebaut

Eine Route „alle Kostenstellen einer Periode“ (Befund an AP-10; bis dahin je Kostenstelle ein Aufruf mit Zwischenspeicher).
Die Messstellen EINES Prozesses (nur die berechneten sind sichtbar — Befund an AP-10). Rechte-Durchsetzung (AP-03: Lesen
deckt `messstelle.ansehen`, G1). Anlegen, Umbenennen und Beenden von Kostenstellen und Prozessen im Portal (AP-10 IP-15
Schreib-Teil, offen).
