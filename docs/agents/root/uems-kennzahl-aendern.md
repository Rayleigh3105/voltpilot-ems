# UEMS-Fläche: Berechnung ändern, Stammdaten, Archivieren und Löschen einer Kennzahl (AP-11 IP-15)

Neu am 15.09.2026 — damit ist die Kennzahl-Fläche vollständig. An der Kennzahl-Seite: „Berechnung ändern ab …“ in der
Karte „Berechnung“ (DERSELBE Assistent wie beim Anlegen, Modus „ändern“), „Stammdaten ändern“ in der Karte „Stammdaten“,
die Karte „Archivieren und löschen“; die Versionen (§5.5) zeigt weiter `WertVersionen.tsx` (IP-13). Routen aus IP-5:
`POST …/{id}/fassungen`, `PUT …/{id}`, `POST …/{id}/archivieren`, `DELETE …/{id}`, `POST …/vorschau` (zweimal: neu und
bisher). Spezifikation: AP-11 §8 IP-15, §5.4, §5.5, §5.7, §5.8.

| Datei (`frontend/portal/…`) | Was |
|---|---|
| `src/kennzahlAendern.ts` | reine Ableitung: Entwurf aus der heutigen Fassung, „Gilt ab“ vorab (`fassungEintrag`), Begründung ≥ 10, Anfragen, Vergleich neu/bisher, V2-Satz, Stammdaten, Leser, Lösch-Sperre, „Eingang archiviert (KZ-…)“ |
| `src/kennzahlAnlegen.ts` | Schritt-Mechanik mit `Weg` (`anlegen`/`aendern`): „Gilt ab · Menge · Bezugsgröße · Vorschau“, `anzeigeNummer`, `befundSchritt` |
| `src/components/KennzahlAnlegenDialog.tsx` | Prop `aendern` (+ `onGeaendert`, `zone`): `SchrittAb`, `SchrittVergleich`, „Speichern“; sonst dieselben Schritte 2 und 3 |
| `src/components/KennzahlStammdatenDialog.tsx` | Name, Verantwortlich, Zweck — ohne Fassung |
| `src/pages/KennzahlSeite.tsx`, `KennzahlenPage.tsx` | Knöpfe, Umfeld (Liste + Fassungen der Zusammenfassungen), `ConfirmDialog` fürs Archivieren, `DangerZone` fürs Löschen; die Seite lädt nach „Speichern“ neu (Schlüssel) |
| `src/test/kennzahlAendernFixtures.ts` | K17 an KZ-0004 (Ahrenberg + Vektor), Werte, Vorschau neu/bisher, MS-24 im Register |
| `e2e/kennzahl-aendern.spec.ts` | Bühne `startansicht`: `welt=k17` (01.04.2027), `welt=k17-fassung2` (20.03.2027), `frisch=1` (KZ-0009 ohne Wert); zählt `__kennzahlAufrufe.fassung/stammdaten/archivieren/loeschen` |

```bash
(cd frontend/portal && npx vitest run src/kennzahlAendern.test.ts src/components/KennzahlAnlegenDialog.test.tsx src/pages/KennzahlenPage.test.tsx src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/kennzahl-aendern.spec.ts --project=desktop-chromium --project=mobile-chromium)
```

## Die Fallen

- **Vor „Speichern“ wird nichts gespeichert.** Schritt 4 ruft nur `POST …/vorschau` — ZWEIMAL, mit den neuen und mit den
  heutigen Eingängen derselben Kennzahl (ohne Kennzeichen, sonst `kennzeichen_belegt`); verglichen wird die jüngste
  Periode der Antwort. Das Portal rechnet keinen Wert.
- ⚠ **Befund: die Vorschau-Route kennt nur ABGESCHLOSSENE Perioden vor heute.** Am Eintragstag von K17 (20.03.2027)
  vergleicht die Fläche also den Februar — den Fassung 2 ab 01.03. gar nicht betrifft; der März erscheint erst ab dem
  01.04. („März 2027: 0,30 statt 0,29“; 91 200 ÷ 320 000 = 0,285 → 0,29 — die „0,28“ in §5.4 ist der Februar). Wer den
  laufenden Monat will, braucht einen Stichtag an `POST …/vorschau`. Der Satz darunter sagt, welche Perioden die neue
  Fassung liest (V2: die Fassung des LETZTEN Tags) — „Ab März 2027 gilt Fassung 2 — Februar 2027 und früher bleiben bei Fassung 1.“
- **„Gilt ab“ vorab, die Route bleibt die Wahrheit.** `fassungEintrag` spricht Wort für Wort `MessstelleFormelRegeln.fassungEintrag`
  (gleicher Tag: „Ab diesem Tag gilt schon Fassung 2.“, früher: „Ab dem 01.03.2027 gilt schon Fassung 2 — …“) und ruft
  für „rückwirkend (n Tage)“ den Zwilling `uemsOrtsbaum.rueckwirkung`; gemessen an den zwei K17-Prüfungen der Regel
  `fassung`. Der Vertrag erklärt `fassung` weiter „ohne TS-Zwilling“ — die Vektor-Datei ist unverändert. Die Nummer der
  neuen Fassung zählt aufgehobene mit (wie der Service).
- **Beim Ändern bleibt die Bezugsgröße stehen, wenn die Menge wechselt** (beim Anlegen fängt sie neu an). Der
  Geltungsbereich ist fest; sein Satz (G3) sperrt deshalb schon Schritt 3. Eine Zusammenfassung bietet sich nie selbst als Paar an.
- **Unverändert = dieselben Eingänge** (und beim Anteil derselbe Rest bis 100 %): der rote Satz steht, „Speichern“ bleibt aus.
- **Begründung ≥ 10 Zeichen prüft nur das Portal** (§5.4); die Route verlangt nur „nicht leer“.
- ⚠ **Rückwirkend: der Stundenlauf zieht nur VORLÄUFIGE Perioden nach** (er liest die Fassung des Stichtags); endgültige
  bildet seit IP-9 die Korrektur-Kaskade im nächsten Takt als Version n + 1 „Berechnung geändert (Fassung n)“ neu
  (`uems-kennzahl-ausloeser.md`). Der Fertig-Satz der Fläche verspricht weiter nur das Vorläufige.
- **Verlaufslisten nach der Eintragung** (Captain 15.09.2026): `kennzahlKarte.berechnung` sortiert den Fassungs-Verlauf
  nach `eingetragen_am`, jüngste zuerst; „gilt ab“ steht an jeder Zeile.
- **Löschen nur ohne einen einzigen Wert** (`hat_werte`): sonst „KZ-0001 hat Werte — archivieren Sie sie.“ als Grund der
  `DangerZone` (kein Knopf). Leser kennt die Seite über die Fassungen der ZUSAMMENFASSUNGEN (nur sie lesen Kennzahlen, E2)
  — irgendeine Fassung, auch archiviert, wie die Route (`wird_gelesen`); beide Sätze gegen `schnittstelle.ablehnungen`
  getestet. Scheitert das Nachladen, entscheidet die Route und ihr Satz steht im Panel.
- ⚠ **Befund: „Eingang archiviert (KZ-xx)“ setzt heute niemand in einen Wert** — das Kennzeichen steht im Vertrag, der
  Rechenlauf erzeugt es nicht. Die Seite leitet es für die GELTENDE Fassung aus der Liste ab und zeigt es an der Karte
  „Berechnung“; die Folgen des Archivierens nennen die heutigen Leser.
- **Kein Wiederherstellen** (die IP-15-Zeile nennt es): es gibt keine Route — also keinen Knopf; die Folgen sagen
  „Zurückholen lässt sich eine archivierte Kennzahl heute nicht.“ Archiviert: kein „Berechnung ändern“, keine Stammdaten.
- **Stammdaten ohne Fassung:** `PUT` schickt die GANZEN Stammdaten mit unverändertem Kennzeichen; das Protokoll schreibt
  die Route (`kennzahl_geaendert`) — eine Leseroute fürs Kennzahl-Protokoll gibt es nicht.
- **`copy.test.ts`:** „Modus“ ist ein verbotenes Kundenwort und trifft auch Quelltext — der Typ heißt `Weg`. Die neuen
  Flächen stehen in `FLAECHEN`, die Fixture-Datei im Erlaubt-Satz für „Kennzahl“.
- **Bühne:** `welt=k17` stellt KZ-0004 und MS-24 NUR dazu (die Welt von IP-13/14 bleibt fünf Kennzahlen); das Datumsfeld
  wählt den 01.03. über „Voriger Monat“ und die ERSTE Zelle „1“ (der März 2027 beginnt am Montag).
