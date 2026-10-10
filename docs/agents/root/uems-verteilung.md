# UEMS-Verteilung auf Kostenstellen: 100 % je Tag, oder ausdrücklich „nicht verteilt“ (AP-10 IP-8)

Neu am 13.09.2026. Captain-Entscheid **E11 = A**: die Verteilung ist eine eigene zeitgültige Beziehung
Messstelle → Kostenstelle mit Anteil, geschrieben als **Satz je Tag**; an jedem Tag mit Zeilen sind es
**genau 100 %**, ohne Zeile heißt es **„nicht verteilt“** (nie „zu 0 % verteilt“, nie „der Rest geht
irgendwohin“). **E12 = A**: sie wirkt je TAG auf die Tagesmenge; der Monat je Ziel ist die Summe der
verteilten Tage. Vertrag `docs/contracts/v2/verteilung.md` (Fassung 1.1), Konzept
`vp-uems-ap10-bilanzen` §4.6, §8 IP-8.

| Was | Wo |
|---|---|
| Migration | `V20260913230000__uems_messstelle_verteilung.sql` |
| Regel | `uems/VerteilungRegeln.satzAbTag` ⟷ TS `satzAbTag` in `uemsVerteilung.ts`, Regel `satz_ab_tag` in `verteilung-vectors.json` (F10, F12, F13) |
| Schreibweg | `uems/VerteilungService` (+ `VerteilungRepository`, `VerteilungAbgelehnt` = geschlossener Satz) |
| Routen | `web/VerteilungController`: `GET /api/v1/messstellen/{id}/verteilung?am=`, `PUT …/verteilung` |
| Leseweg | `uems/AnteilLeseweg#lies`, Zweig `verteilung` (liest über `VerteilungRepository.stand`) |
| Ereignis | `verteilung_geaendert` (27. Art, nur `kunde`, Bezug NUR die Messstelle) |
| Rechte | `messstelle.verteilung` (Zellen wie `messstelle.bearbeiten`), lesen `messstelle.ansehen` — eingetragen, nicht durchgesetzt |
| Tests | `VerteilungVectorsTest`, `AnteilLesewegVectorsTest`, `VerteilungSchnittstelleVertragTest` (rein) · `UemsMessstelleVerteilungMigrationTest`, `VerteilungApiTest`, `MessstelleFormelVerteilungsTermApiTest` (Docker) · `uemsVerteilung.test.ts` |

## Was die Datenbank hält

- ⚠ **100 % zur COMMIT-Zeit**: Constraint-Trigger `messstelle_verteilung_hundert_prozent`
  (`DEFERRABLE INITIALLY DEFERRED`). Ein Satz mit zwei Zielen (70/30 → 60/40) ist zwischen zwei
  Anweisungen nie 100 % — sofort geprüft scheiterte er am ersten UPDATE
  (`UemsMessstelleVerteilungMigrationTest` beweist beides mit `SET CONSTRAINTS … IMMEDIATE`). Geprüft
  wird der GANZE Stand der Messstelle an jedem `gueltig_ab` und jedem Tag nach einem `gueltig_bis`.
  Ein Commit-Fehler kommt im Schreibweg als 422 `verteilung_summe` an (Constraint-Name aus der Ursache).
- **Ende mit dem Ziel ohne zweite Prüfung**: nur die Zeile am Trigger-Paar aus AP-10 IP-7,
  `uems_zuordnung_im_ziel('kostenstelle', 'kostenstelle_id', 'messstelle_verteilung_kostenstelle_besteht')`.
  Die Seite der Kostenstelle findet die Tabelle über `pg_trigger`; `PUT …/kostenstellen/{id}/beenden`
  antwortet 409 `zuordnung_besteht` mit `art` = `verteilung`.
- Anteil `NUMERIC`, CHECK (0, 100] UND `= round(…, 1)` — nie still gerundet. Exklusion je Ziel
  (aufgehobene Zeilen zählen nicht). App-Rolle: SELECT, INSERT, UPDATE nur `gueltig_bis`/`aufgehoben_am`,
  kein DELETE; Offboarding räumt die Anteile vor Messstelle und Kostenstelle ab.

## Fallen im Schreibweg

- **Satz ab Tag** (`satz_ab_tag`): Anteil (höchstens eine Nachkommastelle) → `satz` (Ziel, 100 %) →
  Rest nach dem Ende eines Ziels → `unveraendert` → Korrektur → `fassung`. Die laufende endet am VORTAG;
  eine Fassung am Tag oder danach ist 422 `formel_fassung_ueberlappt` — außer `korrektur: true`, dann wird
  die GENAU am Tag beginnende aufgehoben (lesbar). Ein leerer Satz = ab dem Tag nicht verteilt.
- Derselbe Satz noch einmal: nichts (kein Protokoll, kein Ereignis). Sonst in EINER Transaktion unter der
  Sperre des Unternehmens GENAU EIN `messstelle_aenderung` (`verteilung_geaendert`, `neu.korrektur`) und
  GENAU EIN Ereignis über `MessreiheEreignisRepository.anhaengen` (wird es verworfen, geht alles zurück).
- ⚠ `rueckwirkend` hängt an `messstelle_aenderung_rueckwirkend_chk` (`gilt_ab < created_at`): ein Test mit
  fester Zukunftsuhr bricht dort — Rückwirkung relativ zu heute prüfen.
- `kostenstelle_unbekannt` (422) ist die Kostenstelle, die es im Kundenbereich nicht gibt; eine fremde
  Messstelle ist 404. Die Fakten tragen zur `kostenstelle_id` das `kennzeichen`.

## Die eingelöste Stelle (PR 715 → IP-8)

`verteilung_wartet_auf_ip8` ist verschwunden: aus `AnteilLeseweg.Ablehnung`, dem Block `leseweg`
(Ablehnungen, Prüfreihenfolge, F11 → `lesung: tagesanteil`), `MessstelleFormelFehler` (OpenAPI) und
`api.ts`. An seiner Stelle prüft `MessstelleFormelService.bindung`, dass die Kostenstelle des Terms da ist
(404). Ohne Zeile am Tag nennen Wert und Verlauf den Term als fehlend mit `nicht_verteilt`.

✅ **Seit AP-10 IP-11** liest die Kostenstellen-Sicht die Verteilung je Tag (gemessen · verteilt · berechnet · nicht
verteilt, `uems-kostenstelle-energie.md`).

**Nicht gebaut:** Bilanz-Lesemodell (IP-9), Periodenwerte berechneter/verteilter Messstellen (IP-10),
Herkunft in den Bilanz-Antworten (IP-12), Portal (IP-15), Durchsetzung (AP-03).
