# Zwei rote Oberflächen-Prüfungen: eine veraltete Zusicherung, ein kalter Entwicklungsserver

Untersucht und repariert am 16.09.2026 (Sammelzweig `uems`, Basis `cab543be`).
Der Oberflächen-Durchlauf vom 15.09.2026 meldete zwei Rote:
`e2e/erloes-formel.spec.ts:33` (Rechner und Telefon) und `e2e/help.spec.ts:7`
(nur Rechner). Es waren **zwei verschiedene Fälle** — und keiner davon ein
kaputtes Produkt.

## 1. `erloes-formel.spec.ts:33` — die Prüfung war veraltet

`toContainText('Ohne Steuerung')` gegen eine Formel-Box, die seit **#626**
`'Ohne smarte Steuerung'` schreibt. Die Umbenennung war Absicht und fachlich
nötig: die Vergleichs-Anlage hat **denselben Speicher** und fährt ihn nur stur;
„Ohne Steuerung“ las sich wie „ohne Speicher“ und beschrieb damit eine andere
Zahl (`src/erloesKomposition.ts`, Kommentar an der Zeile).

⚠ **#626 zog die jsdom-Zwillinge mit** (`src/steuerungFormel.test.ts`,
`src/components/SteuerungFormel.test.tsx`) — **die Playwright-Spec nicht.**
Sie stand seither rot, zwanzig Merges lang, weil jedes Paket nur seine eigenen
Klassen fährt. Trefferquote vorher 5/5 rot auf beiden Projekten, nachher 0/30.

**Regel daraus:** wer ein Kundenwort ändert, sucht es in **beiden** Welten —
`rg -n "<das alte Wort>" frontend/portal/src frontend/portal/e2e`. Ein jsdom-
Zwilling ist kein Ersatz für die Spec, die dasselbe Wort im Browser liest.

## 2. `help.spec.ts:7` — die Bühne, nicht das Produkt

Gemessen auf dieser Bühne (vier Worker, `help.spec.ts:7` an seinem echten
Platz, Zusicherungs-Budget auf 120 s hochgesetzt **nur zum Messen**):

| Ladevorgang | `page.goto` | bis zur Überschrift |
|---|---|---|
| **erste Seite des Laufs** (`empty/goto`) | 2,9–4,9 s | **5,9–8,9 s** |
| jede weitere Seite desselben Tests | 0,3–1,2 s | 0,4–1,3 s |
| dieselbe Seite 0,5 s später neu geladen | 0,4–0,7 s | 0,5–0,7 s |

Zwischen der ersten und der zweiten Messung ändert sich am Produkt **nichts** —
nur der Übersetzungs-Cache des Vite-Entwicklungsservers ist dann warm. Der
ausgelieferte Build kennt diese Wartezeit gar nicht: er ist fertig übersetzt,
bevor ein Kunde ihn abruft. **Kein echter Verwender wartet hier auf irgendetwas
— das ist Fall 3, die Bühne.**

Wer die Rechnung bezahlte, entschied allein die Worker-Verteilung: der Test,
der als Erster einen Wirt mit ganzem `src/App.tsx` lud. Im Durchlauf vom
15.09.2026 traf es `help.spec.ts:7`; in Wiederholungsläufen ebenso
`help.spec.ts:17`, `:35` und `:67`. Nur `e2e/help.tsx` und `e2e/mobile-ui.tsx`
mounten die ganze `App` — `e2e/edit-flow.html`, die Bereitschafts-Adresse von
`webServer.url`, tut es **nicht**: sie antwortet sofort mit rohem HTML und sagt
über die Übersetzung nichts.

**Reparatur:** `frontend/portal/playwright.global-setup.ts` lädt den Wirt
`e2e/help.html#/hilfe/fahrplan` einmal pro Lauf, bevor die erste Zusicherung
tickt; `playwright.config.ts` hängt ihn als `globalSetup` ein. Das Wärmen ist
Bestenfalls-Arbeit — schlägt es fehl, warnt es und der Lauf läuft wie zuvor.

⚠ **NICHT repariert wurde es durch ein größeres Budget, `retries` oder
`force`** — jede Zusicherung behält ihre strengen 5 s, damit eine wirklich
langsam gewordene Hilfe weiterhin auffällt (siehe
[gesamtwert-Lehre](summenwert-assistent-und-karte.md): `retries` verbergen
genau die Wettläufe, die den Kunden zuerst treffen).

⚠ **Vite `server.warmup` hilft hier NICHT** — gemessen: die erste Seite brauchte
damit 6,7–8,9 s statt 5,9–8,2 s, also eher länger, weil das Vorübersetzen beim
Serverstart mit dem ersten Abruf um dieselbe CPU streitet.

### Nachweis (gleiche Maschine, abwechselnd gefahren)

| Arm | `help.spec.ts:7` |
|---|---|
| ohne Vorwärmen | **6 von 8 rot** (dazu 11 von 16 in den Vorläufen) |
| mit Vorwärmen | **0 von 8 rot** |

Nebenwirkung: der Lauf wird schneller und ruhiger (22–72 s → 16–24 s), weil
niemand mehr fünf Sekunden lang auf ein Element pollt, das erst nach acht
kommt.

## Was diese beiden Fälle gemeinsam lehren

- **„vorher grün, nachher rot“ ist bei einem zeitempfindlichen Test kein
  Beweis** — und die Umkehrung auch nicht. Beide Arme mehrfach und
  **abwechselnd** fahren, sonst misst man die Tagesform des Rechners.
- **Eine Trefferquote schlägt einen Eindruck.** `erloes-formel:33` war 5/5 rot
  (deterministisch, ein Wort), `help:7` war ~70 % rot (Bühne, eine Uhr) — die
  beiden Befunde sahen im Sammelbericht gleich aus.
- **Erst einordnen, dann reparieren:** Produkt kaputt · Prüfung veraltet ·
  Bühne unecht. Hier zweimal nicht das Produkt.
