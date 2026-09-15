# UEMS-Kennzahl-Auslöser: Nenner und Definition bilden die Kennzahl neu (AP-11 IP-9)

Neu am 15.09.2026, Meilenstein 3 „Kennzahl korrigiert sich“. Entscheid AP-11 **E8 = A**, W1 bestätigt (14.09.2026).
Baut auf der Kennzahl-Kaskade (`uems-kennzahl-kaskade.md`, Reihen-Pfad), der Korrektur-Kaskade
(`uems-korrektur-kaskade.md`), dem Bezugswert-Schreibweg (`uems-bezugswert-eingeben.md`) und der Bericht-Kaskade
(`uems-bericht-kaskade.md`) auf.

| Teil | Stelle |
|---|---|
| Anlässe | `KorrekturKaskade.kandidaten` — drei weitere Quellen, Wirkung wie bisher in `messreihe_kaskade_wirkung` |
| Verarbeitung | `KorrekturKaskade.ohneStufen` → NUR `kennzahlen.nachKorrektur` und `berichteBenachrichtigen` (keine Stufe, keine berechnete Messstelle, kein `bilanz_neu_berechnet`) |
| Betroffen | `Betroffen.bezugsgroessen` (15. Feld, additiv — der 13- und der 14-stellige Konstruktor bleiben), Status `berechnung_geaendert` · `stammdatum_eingetragen` |
| Naht | `KennzahlKaskade.nachKorrektur` → `KennzahlLauf.nachKorrektur(con, betroffen, Ausloeser, beleg)` (die alte Signatur mit `Set<UUID> messstellen` bleibt) |
| Berichte | `BerichtKaskade.betroffene` (Quellen `bezugsgroesse`, `stammdatum`, `kennzahl`), `BerichtRegeln.betroffene`/`anstossArt` ⟷ `uemsBericht.ts`, zwei Annahme-Prüfungen in B9 |
| Meldung | `kennzahl_neu_gebildet`, `ausloeser` zusätzlich `BK-…`, `KZ-0004/Fassung-2`, `BZ-8/ab-2027-01-01` (beide Java-Zwillinge, drei Fälle in `events-vocabulary-vectors.json`) |
| Migration | `V20260915150000`: Kennungs-CHECK von `messreihe_kaskade_wirkung` erweitert, Teilindex auf `messreihe_ereignis` |
| Test | `UemsKennzahlAusloeserTest` (Testcontainers): K6 echter Weg und Beleg, K19, K17 vorläufig und endgültig, K12 vorläufig und endgültig, Rollback |

## Die drei Auslöser

| Quelle | Wirkungs-Kennung | Fassung | Tage | Anlass an der Kennzahl |
|---|---|---|---|---|
| `messreihe_ereignis` `correction` mit `kennungen.bezugsgroesse` (Erzeuger AP-09 IP-7) | `BK-…` | `fassung_neu` | die Periode der Meldung | `eingang`, Beleg „correction BZ-1 2026-10 Fassung 1 → 2 (I-2026-0003)“ (sonst die `BK-…`), nach Rücknahme „Rücknahme I-2026-0001“ |
| `kennzahl_fassung` `rueckwirkend`, nicht aufgehoben | `kennzahl_fassung:<ID>` | ihre Nummer | `gueltig_ab` bis heute (oder `gueltig_bis`) | `definition` für die Kennzahl selbst („Berechnung geändert (Fassung n)“), `eingang` für jede abhängige; Beleg „KZ-0004 Fassung 2 ab 01.03.2027 (eingetragen …)“ |
| `bezugsgroesse_aenderung` `stammdatum_eingetragen` `rueckwirkend` | `bezugsgroesse_stammdatum:<ID>` | der wievielte Eintrag | `gilt_ab` bis heute | `eingang`, Beleg „Stammdatum BZ-8 ab 01.01.2026 (eingetragen …)“ |

## ⚠ Fallen

- **Eine Fläche ist KEIN Kennzahl-Eingang.** `BezugsgroesseService.stammdatum` liest nur `bezugsgroesse_stammdatum`; Flächen-Werte
  liefert `BezugsflaecheLesemodell.werte` allein an `GET /api/v1/bezugsflaechen`; eine Bezugsgröße in m² lehnt der Schreibweg ab
  (`flaeche_aus_struktur`, dazu `bezugsgroesse_stammdatum_keine_flaeche_chk`); Kennzahl-Eingänge kommen nur aus `bezugsgroesse`.
  Darum gibt es KEINEN Auslöser aus `ort_aenderung` `flaeche_geaendert` — er gehört in das Paket, das die Fläche als Eingang bringt
  (Befund AP-11 IP-14). K12 ist mit einem Stammdatum in Personen und den Zahlen aus K12 geprüft.
- **Die Wirkung trägt IDs, keine Kennzeichen.** Ein Kennzeichen kann wechseln (Verlauf) und die Form einer Korrektur-Kennung haben.
- **Der Auslöser der Meldung ist nie ein bloßes Kennzeichen** (`MS-12` bleibt `regel_verletzt`, Fall
  `kennzahl-neu-gebildet-ohne-korrektur-kennung-verworfen`): Berechnung `KZ-…/Fassung-n`, Stammdatum `BZ-…/ab-JJJJ-MM-TT`.
- **Nur rückwirkende Einträge sind Anlässe.** Was heute oder künftig gilt, zieht der Stundenlauf nach (V3). In der Kaskade zieht ein
  vorläufiger Wert ohne neue Version und ohne Meldung nach.
- **Keinen Tag früher:** die Tage beginnen an `gueltig_ab`; `KennzahlLauf` nimmt jede Periode, die sie berührt (auch das Jahr),
  keine davor. Der Test vergleicht jede Zeile, deren Periode vorher endet.
- **`KorrekturKaskade.lauf` ist global.** Lässt ein abgebrochener Test einen Anlass liegen, scheitert jeder spätere Takt mit früherer
  Uhr an ihm („liegt nicht nach der neuesten Zeile“) — den nachholenden Takt in `finally` ziehen.
- **Die echten Schreibwege urteilen nach der echten Uhr** (Berichtigung Z4, „rückwirkend“): Tests über sie spielen in 2025/2026,
  nicht in den Vektordaten 2026/2027.
- **Berichte werden nicht doppelt angestoßen:** derselbe Anlass trifft einen Stand genau einmal (`bericht_revision_anstoss_einmal`
  über Stand, Art, Anlass, Fassung, Status — B7). Pfad 2 (AP-12 IP-9, `uems-bericht-struktur.md`) ist gebaut und lässt
  Bezugsgrößen und Kennzahl-Fassungen bei Pfad 1.
- **Offen:** `…/werte/versionen` findet zu `BK-…` noch keine Entscheidung (`KennzahlWerteService.VORGANG_KENNUNG` kennt nur
  `K-`/`EW-`). Import-Berichtigung und Rücknahme schreibt erst AP-09 IP-12/IP-13 — der Test legt sie synthetisch an und sagt es.

## Prüfen

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest='KorrekturKaskadeWiringTest,KennzahlLaufQuelltextTest,BerichtVectorsTest,EreignisVokabularVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsKennzahlAusloeserTest')   # Testcontainers
(cd services/api && ./mvnw test -Dtest='UemsKennzahlKaskadeTest,UemsBerichtKaskadeTest,UemsKorrekturKaskadeTest')   # Testcontainers
(cd services/timescale-writer && ./mvnw test -Dtest=EreignisVokabularZwillingTest)
(cd frontend/portal && npx vitest run src/uemsBericht.test.ts src/uemsEreignis.test.ts)
```
