# UEMS-Fläche: Berichts-Dialoge — anlegen, freigeben, vergleichen, Anstoß verwerfen (AP-12 IP-14)

Neu am 15.09.2026, Meilenstein 5 „Abnahme im Portal“. Die Welt „Berichte“ (`uems-berichte-portal.md`) schreibt jetzt:
`POST /api/v1/berichte` (mit Kennzahl-Abwahl), `POST …/freigeben`, `GET …/entwurf/vergleich`, `POST …/anstoesse/{id}/verwerfen`
(`uems-bericht-routen.md`); die Rechte liest sie aus `GET /api/v1/me`. Spezifikation: AP-12 §8 IP-14, §5.1–§5.3, §5.8, W2.

| Datei (`frontend/portal/…`) | Was |
|---|---|
| `src/berichtDialoge.ts` | reine Ableitung: Rechte (G1 über `uemsBericht.kennung`), Vorlage-Karten, Geltungen, Zeiträume, Voraussetzungs-Vorschau, Kennzahlen der Geltung (Q4), Freigabe-Voraussetzungen (F1), Vergleichszeilen (R1), Banner, Seiten-Hebel |
| `src/components/BerichtAnlegenDialog.tsx`, `BerichtFreigebenDialog.tsx`, `BerichtVergleichDialog.tsx`, `AnstossVerwerfenDialog.tsx`, `BerichtDialoge.css` | die vier Dialoge im zentrierten `Modal` |
| `src/useBerichtRechte.ts` | Selbstauskunft → `BerichtRechte` |
| `src/pages/BerichtePage.tsx`, `src/pages/BerichtSeite.tsx` | Knopf „Bericht anlegen“; Hebel am Entwurf; Banner „Revision nötig“ |
| `src/berichtDialoge.test.ts` | jede `freigabe`-Prüfung der Vektoren (B4) als Satz unter den Voraussetzungen; B2-Abweichungen als Zeilen |
| `src/ortArchivBerichte.test.ts` | W2: die zwei Berichts-Sätze in `ortArchiv.ts` an E1/B6/B11 und A5/B10/B14 gepinnt |
| `e2e/bericht-freigeben.spec.ts` | seriell: anlegen → freigeben (09:02) → Revision → Vergleich → Nr. 2 (16.11. 14:20), verwerfen, Leser, 1440 px |

```bash
(cd frontend/portal && npx vitest run src/berichtDialoge.test.ts src/ortArchivBerichte.test.ts src/berichtSeite.test.ts src/copy.test.ts)
(cd frontend/portal && npx playwright test e2e/bericht-freigeben.spec.ts e2e/berichte.spec.ts --project=desktop-chromium --project=mobile-chromium)
```

## Die Fallen

- **Die Kennzahl-Abwahl schreibt die Anlege-Route.** `kennzahlen_abgewaehlt` (IDs, additiv, ohne Abwahl fehlt das Feld)
  landet in `bericht_kennzahl_abwahl`, BEVOR der erste Entwurf entsteht. Ändern oder wieder wählen nach dem Anlegen gibt es
  nicht. Die Liste im Dialog (`kennzahlenDerGeltung`) spiegelt `BerichtKennzahlen.gewaehlt` — wer Q4 am Server ändert,
  ändert sie mit.
- **Rechte:** `useBerichtRechte` = `undefined` (Antwort fehlt) → keine schreibenden Hebel; `null` (Selbstauskunft nicht
  zu haben) → Hebel da, die Route entscheidet mit ihrem Satz. Anlegen und Verwerfen folgen dem Freigabe-Recht (G1).
  Nicht Erlaubtes fehlt ganz (§5.5), nie ausgegraut.
- **F1 zählt Werte UND Kennzahlen** wie `BerichtService.freigabeWerte`: „Alle 18 Werte endgültig“ (die Report-Prosa sagt
  16 — ohne Kennzahlen). Der Satz unter der Liste ist `uemsBericht.freigabe`; ist er schon vor dem Dialog nein, ist
  „Als Berichtsstand freigeben“ aus und der Satz steht darunter. 409 `entwurf_veraltet` → „Entwurf neu laden“ im Dialog.
- **Vergleich:** Karten mit Wortpaaren statt einer Tabelle mit fünf Spalten (375 px); Kennzahlen mit VIER Stellen
  (`VERGLEICH_NACHKOMMASTELLEN` — mit zwei stünde „0,15 → 0,15“); „wer, wann: warum“ aus `qualitaet.korrekturen` des
  Entwurfs; „15 Werte unverändert“ (Report-Prosa 14). Der Dialog liest erst den Entwurf, dann den Vergleich.
- **Banner nur für offene Anstöße am gültigen Stand.** Die Route liefert am Anstoß weder Person noch betroffene Quelle —
  der lange Report-Satz „(Ines Kaltenbach, 12.11.2026 10:05) ändert MS-12 …“ ist darum nicht gebaut; verworfen heißt es
  mit dem Vertrags-Kennzeichen „Anstoß verworfen (…)“.
- **`.vp-br-hebel` ist der Knopf „heutigen Wert zeigen“** (IP-13) — die Hebel-Leisten heißen `.vp-br-aktionen`.
- **Folgen-Zeile „Freigegebene Berichte: …“** steht über die §8-Zelle hinaus auch in `VerschiebenDialog`
  (`zuordnung_rueckwirkend` am Ort) und `ZuordnungAendernDialog` (Ort → `zuordnung_rueckwirkend`, Verteilung →
  `verteilung_rueckwirkend`; Stellung und Prozesse fragen nicht).
- **Bühne:** `&berichte=leer` (kein Bericht), `&person=IK|PH|CB` (B13), die Uhr steht auf dem Klick der Referenzdatei
  (10.11. 09:02, 16.11. 14:20); `window.__berichtAufrufe` zählt. `VpPicker` in Playwright: Name `exact` (ab einigen Zeilen
  gibt es „… durchsuchen“), `aria-controls` trägt der Auslöser erst offen.
