# UEMS-Fläche: der Assistent „Kennzahl anlegen“ und „Kopieren“ (AP-11 IP-14)

Neu am 15.09.2026. „Unternehmen › Kennzahlen“ trägt im Kopf „Kennzahl anlegen“, die Kennzahl-Seite „Kopieren“ — beide
öffnen `KennzahlAnlegenDialog` im Rahmen des Gesamtwert-Assistenten (PR 689: `Modal`, `.vp-steps`, `.vp-gw-*`), kein
zweiter Dialograhmen. Fünf Schritte Vorlage · Menge · Bezugsgröße · Geltungsbereich · Vorschau, dann Fertig; eine
Zusammenfassung wählt in Schritt 2 Kennzahlen, Schritt 3 entfällt (§5.6). Dazu heißt der dritte Schritt der Eigenen
Auswertung „3 · Zeitbezug“ (E12). Spezifikation: AP-11 §8 IP-14, §5.1, §5.2, §5.6, §5.8, E2, E9, E12.

| Datei (`frontend/portal/…`) | Was |
|---|---|
| `src/kennzahlAnlegen.ts` | reine Ableitung: Wörter, Entwurf, Auswahl (Messstellen, Bezugsgrößen, Kennzahlen, Geltung), Prüfungen über den Zwilling, Anfrage, Vorschau-Zeilen |
| `src/components/KennzahlAnlegenDialog.tsx`, `KennzahlAnlegen.css` | der Dialog; der Hebel öffnet `GesamtwertDialog` gestapelt darüber |
| `src/pages/KennzahlenPage.tsx`, `src/pages/KennzahlSeite.tsx` | die Einstiege; der Dialog gehört der Welt, die Liste lädt nach dem Anlegen neu |
| `src/test/kennzahlAnlegenFixtures.ts` | Bezugsgrößen, Flächen, Prozesse, Kostenstellen, Vorschau- und Anlege-Antwort (Ahrenberg, Werte K1/K2) |
| `e2e/kennzahl-anlegen.spec.ts` | Bühne `startansicht`: `ansicht=kennzahlen&welt=leer&person=IK`, `ansicht=kennzahl&kz=KZ-0001`; zählt `window.__kennzahlAufrufe` |

```bash
(cd frontend/portal && npx vitest run src/kennzahlAnlegen.test.ts src/components/KennzahlAnlegenDialog.test.tsx src/pages/KennzahlenPage.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/kennzahl-anlegen.spec.ts --project=desktop-chromium --project=mobile-chromium)
```

## Die Fallen

- **Vor „Anlegen“ wird nichts gespeichert** (K1, K20). Schritt 5 ruft nur `POST …/vorschau`; `POST /api/v1/kennzahlen`
  fällt allein auf den Knopf, mit DERSELBEN Anfrage — `KennzahlAnlegenDialog.test.tsx` vergleicht beide, die E2E-Spec
  zählt `__kennzahlAufrufe`. Wer einen Zwischenschritt speichert, bricht die Zusicherung.
- **Kein Satz und keine Regel im Portal.** Einheit, Periode, G1 und G3 ruft `kennzahlAnlegen.ts` im Zwilling
  `uemsKennzahl.ts`; ein Befund der Vorschau mit Kette (K16) spricht ebenfalls der Zwilling (`befundSatz`). Die einzige
  eigene Satzform ist der grüne Hinweis „BZ-6 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet“, gebaut
  aus `PERIODEN_WOERTER` und `PERIODEN_NAME`.
- **Eine Messstelle liefert Tageswerte** (`MESSSTELLE_PERIODE`, Vektor K1 „MS-12 (Tag)“) — daraus folgt die
  Perioden-Prüfung. Ändert der Vertrag das, zieht `periodenEingang` nach; der Test vergleicht die Eingänge mit dem Vektor.
- **Der Perioden-Wunsch ist `periode_art`** (nur Wunsch, kein Feld, IP-5): vier Knöpfe unter der Prüfung, die
  Grundperiode sendet `null`. Ein unpassender Wunsch zeigt den roten K13-Satz am Picker und sperrt „Weiter“; die
  Vorschau rechnet in der gewünschten Periode.
- **Die Vorlage filtert, die Route kennt die Art nicht.** `Bezugsgroesse` trägt keine `art` — gefiltert wird auf Einheit
  und Wertart der Erwartung. Bringt die Route die Art, filtert `bezugsgroessenAuswahl` zusätzlich darauf.
- ⚠ **Befund: Flächen der Standortstruktur sind kein Eingang** (`KennzahlEingangLeser`: kein Kennzeichen einer
  Bezugsgröße) — sie stehen gesperrt mit Grund. Die Vorlage „Stromeinsatz je m²“ verspricht „Flächen aus der
  Standortstruktur sind sofort nutzbar“, §5.1 „Flächen aus der Struktur“: heute findet der Kunde dort keine wählbare
  Bezugsgröße. Braucht einen Eingang „Fläche eines Orts“ im Vertrag oder eine Bezugsgröße der Art Bezugsfläche.
- ⚠ **Befund: die Vorschau-Route liefert nie `vor_bestehen`** — `KennzahlVorschauService` ruft `KennzahlRegeln.wert` mit
  `bestehen_ab = null`. Das Portal zeigt `vor_bestehen` als „vor dem Bestehen“ (§5.1, K20), die Bühne liefert es so; bis
  die Route nachzieht, stehen solche Monate dort mit ihrem Grund ohne Zahl.
- **Hebel „Mehrere Messstellen?“:** der `GesamtwertDialog` baut aus den Kanälen EINER Anlage — geöffnet wird er für die
  Anlage der ersten gewählten Messstelle (elektrische Stellung); ohne Stellung steht der Satz ohne Knopf. Zurück kommt
  der neue Gesamtwert als Menge, das Register lädt dafür neu. Zwei Anlagen (MS-12 + MS-18, K4) fasst er nicht zusammen.
- **Der Geltungsbereich ist ein Vorschlag:** das Geltungsobjekt der Bezugsgröße (BZ-6 → Halle 2), sonst der Ort der
  Messstelle; eine Zusammenfassung schlägt das Unternehmen vor. Der Rechte-Geltungsbereich (G1) steht darunter.
- **„Kopieren“ nimmt das Komplement mit** (Teil der Form — sonst würde ein Autarkiegrad still zum Anteil); Menge,
  Bezugsgröße, Geltungsbereich und Verantwortlich (vorbelegt mit der angemeldeten Person) sind neu, der Name tauscht
  genau die Endung „ — {Geltungsbereich}“ (`uemsKennzahl.kopie`).
- **Kein Knopf ohne Ziel:** „Bezugsgröße anlegen“ (leere Liste, §5.1) und „Bezugsgröße je Tag anlegen“ (K13) fehlen,
  weil das Portal noch keine Bezugsgrößen-Fläche hat — der Satz steht, der Knopf nicht.
- **Eigene Auswertung:** „3 · Zeitbezug“ und „Dieser Zeitbezug passt nicht zu …“ (Kundentext, Enum bleibt); beide
  Dateien sind aus `KENNZAHL_BESTAND` in `copy.test.ts` gestrichen, die Assistenten-Dateien stehen in `FLAECHEN`.
- **Die Bühne rendert in `React.StrictMode`:** eine Vorschau kann doppelt gezählt sein, eine Anlage nie — die Spec prüft
  „Anlage 0, Vorschau > 0“, keine exakte Vorschau-Zahl.
