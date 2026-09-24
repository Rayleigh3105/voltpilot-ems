# Ziele, Maßnahmen, Abweichungen (AP-18): Naht, Schalter, Bestandsschutz — Wegweiser und Abschluss

Einstieg in alle 22 Pakete von AP-18, alle in `uems` (Konzept `vp-uems-ap18-fundament`, entschieden 24.09.2026, E1–E7 = A). Grundgedanke:
drei Objekte mit gemeinsamem Muster — Energieziel, Maßnahme, Abweichung (E1) — und zwei Vermerke, die eine Person
beantwortet: Auffälligkeit und Anstoß am Vorgang (E4). Das System zeigt Zahlen mit Bedingung, eine Person sagt „belegt“
als Stand mit Prüfsumme (E6). Kein Läufer, keine Nachricht: Termine und Fristen leitet der Abruf ab (E5). Kundenwörter
nach SP1–SP4 aus `frontend/portal/src/glossar.ts` (`UEMS_ZIELE_UND_MASSNAHMEN` …), Wächter `copy.test.ts` (Block AP-18
IP-4). Begriffe: Glossar `docs/fachmodell/glossar.md` (Energieziel, Maßnahme, Abweichung, Auffälligkeit,
Ursache-Aussage, Wirkung, Anstoß am Vorgang).

## Einstieg je Paket

| Pakete | Schicht | Wegweiser |
|---|---|---|
| IP-1 | Referenzunternehmen 1.9 (Energieziele, Maßnahmen, Abweichungen, Auffälligkeiten; W8, W9) | `uems-referenzunternehmen-die-eine-beispi.md` (Abschnitt 1.9) |
| IP-2 | Vertrag `verbesserung-vectors.json`, Zwillinge Java/TS/Python (Wirkung, Ziel-Stand, Frist, Sätze) | `uems-verbesserung-vertrag.md` |
| IP-3 | Nachträge Phase 1 (W11, W12, W13, W15) | `uems-bezugsbasis-vertrag.md`, `docs/contracts/v2/events-vocabulary.md` |
| IP-4 | Sprach-Wächter und Kundenwörter (SP1–SP4) | `frontend/portal/src/copy.test.ts`, `glossar.ts` |
| IP-5, IP-9, IP-14 | Datenhaltung: zehn Tabellen, Zähler EZ/M/AW, Kopien mit Prüfsumme | `uems-verbesserung-datenhaltung.md` |
| IP-6, IP-7 | Energieziel: Routen, Ziel-Stand, Bewertung als Stand, Anstoß Pfad 2 | `uems-energieziel-routen.md` |
| IP-10, IP-11, IP-12 | Maßnahme: Routen, Wirkung-Leser, Bewertung Stand Nr. n | `uems-massnahme-routen.md` |
| IP-15 | Auffälligkeits-Naht im Endgültigkeits-Takt und in der Kaskade | `uems-verbesserung-datenhaltung.md` (Abschnitt „Auffälligkeits-Naht“) |
| IP-16 | Auffälligkeit und Abweichung: Routen | `uems-abweichung-routen.md` |
| IP-17 | Anstoß am Vorgang: Pfad 1 (Kaskade), Pfad 2 (Struktur-Läufer), Antworten | `uems-vorgang-anstoss.md` |
| IP-8, IP-13, IP-18 | Portal: Energieziele, Maßnahmen, Auffälligkeiten und Abweichungen | `frontend/portal/src/verbesserung.ts`, Zeilen in `uems-uebersicht.md` |
| IP-21 | Bestandsschutz, Flag-Nachweis, Drehbuch §15, dieser Wegweiser, Glossar, Release-Notiz-Zeile | unten |
| IP-19 | Übersicht: Leser `GET /api/v1/verbesserung/uebersicht`, Baustein „Ziele und Maßnahmen“, Register-Zeilen (F1–F3, W7) | `uems-verbesserung-uebersicht.md` |
| IP-20 | Portal: Abschnitt Wirkung, Spalte Bewertung, Dialog bewerten mit Vier-Augen, Anstöße mit Antwort-Knöpfen | `frontend/portal/src/massnahmeWirkung.ts`, `pages/MassnahmeSeite.tsx`, `pages/EnergiezielSeite.tsx` |
| IP-22 | Abnahme der Plan-Konstruktion (NW-6): `UemsMassnahmeAbnahmeTest` über die geteilte `MassnahmeWelt` | `uems-massnahme-routen.md` (Abschnitt „Abnahme der Plan-Konstruktion“) |

## Die Naht — drei Eingänge, ein Schalter

`uems/VerbesserungNaht` ist der einzige Ort, der für AP-18 von selbst schreibt, und immer IN der Transaktion dessen,
was sie auslöst: **Auffälligkeit** (`vermerken`: Regellauf von `KennzahlLauf` nach dem Schreiben der Zeile, Kaskade nach
`KennzahlNeuGebildet.melden`), **Anstoß Pfad 1** (`anstossen`: Kaskade nach dem Bezugsbasis-Anstoß, dieselbe
Anlass-Kennung), **Anstoß Pfad 2** (`messgrundlage`: Struktur-Läufer im Zweig der Bezugsbasis, vor dem Wasserzeichen).
Sie urteilt nicht und legt keinen Vorgang an. Einzelheiten und Fallen: `uems-verbesserung-datenhaltung.md` (Naht) und
`uems-vorgang-anstoss.md` (Pfade, Antworten).

- **Schalter `voltpilot.uems.verbesserung.enabled`** (`VOLTPILOT_UEMS_VERBESSERUNG_ENABLED`, Vorgabe AN, surefire setzt
  nichts): gelesen nur als Feld in `VerbesserungNaht`. Aus: alle drei Eingänge schweigen, nichts wird nachgeholt; das
  Wasserzeichen des Struktur-Läufers setzt die Bezugsbasis trotzdem. Routen, DTOs, Leser und Portal kennen ihn nicht —
  Wächter `UemsVerbesserungFlagArchitekturTest` (Schalter, Transaktion, Anstoß-Weg). Not-Aus-Tabelle §12 von
  `docs/rollout/uems-erste-freigabe.md`: 27 Schalter, `VERBESSERUNG` nach `BEZUGSBASIS`, gleich `application.yml`
  (`UemsBezugsbasisFlagArchitekturTest#dieNotAusTabelleNenntJedenSchalterDerAnwendung`).
- **Kein neuer Läufer** (E5 = A): die Naht läuft in den bestehenden Takten; Fehler zählen unter
  `laeufer="verbesserung_naht"` (`UemsLaeuferMelder`), ohne eigenen Katalog-Eintrag.

## Bestandsschutz (IP-21, NW-5, R13)

- **`UemsVerbesserungBestandsschutzTest`** (Docker, ohne Spring): Ahrenberg aus `infra/local/seed/ahrenberg.sql` auf der
  Fassung VOR `V20260924223000`, dazu KZ-0003 ohne Bezugsbasis und KZ-0004 mit freigegebener BB-0001, je ein endgültiger
  Dezember, und ein Monatsbericht. Danach bis `LETZTE_AP18` (`V20260925002000`) und dann alle späteren Migrationen. Jede
  Bestandstabelle byte-gleich — **ohne benannte Ausnahme**: AP-18 hängt an keine Bestandstabelle eine Spalte. Die zehn
  neuen Tabellen (`NEUE_TABELLEN`) sind leer; die Wörter stehen in der eigenen Funktion `verbesserung_vokabular()` —
  jede andere `*_vokabular()`-Funktion und `bericht_vorlage()` hat nachher dieselben Zeilen. Die drei Eingänge der Naht
  schreiben über den Bestand nichts, mit Schalter an und aus. Mutationsprobe auf `kennzahl` und `standort` (Wert,
  Fassung und Bericht schützen ihre Zeilen per Trigger — dort geht keine Probe).
- **Robust gegen spätere Programme:** „genau diese Tabellen“ und „kein Vokabular ändert sich“ werden auf `LETZTE_AP18`
  gemessen; danach nur noch „Bestand byte-gleich, AP-18-Tabellen leer, kein Wort verschwindet“.
- **Wer ein AP-18-Paket nach IP-21 baut:** eine neue AP-18-Tabelle kommt in `NEUE_TABELLEN`, eine neue AP-18-Migration
  hebt `LETZTE_AP18`; ein neuer Leser des Schalters gehört in `UemsVerbesserungFlagArchitekturTest`. Was mit Schalter AN
  an einer echten Energieleistungskennzahl geschieht, beweist `VerbesserungNahtTest` (R1, R11, R13).

## Vermerke

- **W13:** Glossar um die sieben Begriffe ergänzt (Nachtrag AP-18, `docs/fachmodell/tools/fachmodell.py`); die
  veralteten Stellen `README.md:13` und „Anstoß-Tabelle … kommen mit AP-12“ hat IP-3 berichtigt.
- **W14:** der Seed bleibt auf 1.4 (`infra/local/seed/ahrenberg.sql`) — jede Bühne legt Energieziel, Maßnahme und
  Abweichung nach der Referenzdatei 1.9 selbst an; die Hebung des Seeds ist ein eigenes Paket außerhalb von AP-18.
- **Rollout-Tag:** Prüfung in §15.1 des Drehbuchs (Zeile `verbesserung`); ein vom Vorgabewert abweichender gitops-Wert
  und die Release-Notiz-Zeile „Unter „Ziele und Maßnahmen“ …“ (`docs/rollout/release-notiz-vorlage.md`) sind die Hand
  des Betreibers (§15.2). `VERBESSERUNG` fehlt noch in gitops PR 37 — ohne Eintrag gilt die Vorgabe.
- **Grenze zu AP-19:** Nichtkonformitäten des Managementsystems, Wiedervorlage-Liste und Managementbewertung baut AP-19
  (E7 = A); die Maßnahme wird dort wiederverwendet — die neuen Herkünfte kommen per CHECK-Tausch an
  `massnahme_herkunft_chk`, nicht per Vokabular allein (AP-19 W1, siehe `uems-verbesserung-datenhaltung.md`).
