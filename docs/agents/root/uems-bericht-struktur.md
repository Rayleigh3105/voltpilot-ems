# UEMS-Strukturänderungs-Läufer: ein Bericht merkt auch, was keine Korrektur ist (AP-12 IP-9, Pfad 2)

Neu angelegt am 15.09.2026. Entscheid AP-12 E6 = A (14.09.2026, zwei Pfade in eine Naht). Baut auf der Naht aus IP-8
(`uems-bericht-kaskade.md`) auf; die Regeln sind `docs/contracts/v2/bericht.md` §7 B1/B3/B4/B6/B7.

| Teil | Stelle |
|---|---|
| Läufer | `uems/StrukturAenderungLaeufer` (`@Scheduled`, 5 min) — Flags `voltpilot.uems.berichte.struktur.enabled` UND `voltpilot.uems.berichte.enabled` (yml AN, surefire AUS); `StrukturAenderungSchedulingConfig` am selben Schalter |
| Wasserzeichen | `V20260915173000` `bericht_struktur_gelesen` — eine Zeile je gelesenem Eintrag (Urteil, Einträge), in derselben Transaktion wie die Naht; kein Mandant, kein RLS, App-Rolle ohne Recht |
| Urteil | `BerichtRegeln.struktur` (Vektoren B8–B10); gelesen werden nur die Arten aus `StrukturAufloesung.ORT_ARTEN`/`MESSSTELLE_ARTEN` — `bearbeitet` (B10) nie |
| Objekte | `uems/StrukturAufloesung` — IDs, nie Kennzeichen |
| Naht | Überladungen `BerichteNaht.betroffene/entwurfNeuBilden/revisionAusloesen(…, StrukturBetroffen)` (Default-Methoden, `Keine` kennt nichts) → `BerichtKaskade` teilt Neubildung und Anstoß mit Pfad 1 |
| Kennung | `BerichtRegeln.strukturKennung` `<Art>/<Kennzeichen>/<gilt ab>/<eingetragen>/<Protokoll>-<Zeile>`; Satz über `anlass` (Java ⟷ TS, Vektoren B8) |
| Vorschau | `GET /api/v1/berichte/betroffen?objekt&gilt_ab&anlass` → `BerichtService.betroffen`; Portal `berichteFolgen.ts` + `useBerichteFolgen.ts` in `FlaecheDialog`, `AnlageStandortDialog`, `ArchivierenDialog` |
| Tests | `UemsStrukturAenderungTest` (Testcontainers: B8–B11, Umzug, Datenstand, Standortwechsel, Wasserzeichen, Bezugsgröße) · `StrukturAenderungWiringTest` · `BerichtApiTest` (Route) · `berichteFolgen.test.ts` |

## ⚠ Fallen

1. **Wer die Änderung schon kennt, ist nicht betroffen.** Nur Stände und Entwürfe, deren Datenstand VOR `created_at` der
   Protokollzeile liegt. Ohne diese Schranke stieße der erste Takt in Produktion jeden Stand an, der nach einer alten
   rückwirkenden Änderung gebildet wurde — und der Kunde fragte, was sich geändert habe.
2. **Ein unnötiger Anstoß ist so falsch wie ein fehlender.** Anlage-Umzug löst auf NICHTS auf: kein Abzug liest
   `anlage_standort` (Q3 zählt über `messstelle_ort`). Die zwei Standort-Zeilen, die ein Umzug dazuschreibt
   (`richtung` hinzu/hinaus, Art `verschoben`), urteilen `zuordnung_rueckwirkend` — und lösen ebenfalls auf nichts auf.
   Ein Gebäude oder Bereich zählt nur bei STANDORTWECHSEL (`alt/neu.standort_id` aus `OrtVerschiebenService`). Liest ein
   Abzug eines Tages die Anlage, gehört sie in `StrukturAufloesung.objekte`.
3. **Fläche = der Ort.** Eine Bezugsfläche hat keine Bezugsgrößen-ID (`BezugsflaecheLesemodell`), das Objekt ist der Ort
   und seine Eltern. Heute ist die Fläche kein Kennzahl-Eingang (AP-11, firstmate 001) — kein Bericht zitiert sie, der
   Weg steht leer, bis das Paket kommt, das sie zum Eingang macht. Nie auf Bezugsgrößen „in m²“ auflösen: deren Werte
   tippt ein Mensch, eine Flächenänderung ändert sie nicht.
4. **Bezugsgrößen gehören Pfad 1.** `bezugsgroesse_aenderung` liest der Läufer NICHT. Ein Anstoß aus Pfad 2 trüge eine
   andere Art und Kennung als `BK-…`/`bezugsgroesse_fassung` — `bericht_revision_anstoss_einmal` fände ihn nicht, es gäbe
   zwei (`dieBezugsgroesseTraegtPfadEins_derLaeuferStoesstSieNieEinZweitesMalAn`).
5. **Kein Zeiger „bis id n“.** BIGSERIAL-IDs werden beim INSERT vergeben, sichtbar beim COMMIT — ein Zeiger überspränge
   spät committete Zeilen. Das Wasserzeichen ist je Zeile; eine gescheiterte Transaktion lässt die Zeile ungelesen, die
   übrigen laufen weiter. Zwei Läufer (Cluster) teilen sich die Zeilen über `pg_try_advisory_xact_lock`.
6. **Die Kennung trägt Kennzeichen nur, wenn sie Ereignis-Kennung sein können** (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) —
   Kurzzeichen dürfen Leerzeichen haben. Sonst entfällt das Kennzeichen, der Satz sagt es ohne. Ohne Fassung/Status: die
   Protokollzeile macht den Anstoß eindeutig (B7).
7. **Überladung und `null`:** `new BerichteNaht.Keine().betroffene(null, null)` ist mehrdeutig — Tests casten.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='StrukturAenderungWiringTest,KorrekturKaskadeWiringTest,BerichtVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsStrukturAenderungTest')   # Testcontainers
(cd services/api && ./mvnw test -Dtest='UemsBerichtKaskadeTest,BerichtApiTest,AnlageUmzugApiTest')   # Testcontainers
(cd frontend/portal && npx vitest run src/berichteFolgen.test.ts src/uemsBericht.test.ts src/copy.test.ts)
```
