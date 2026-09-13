# UEMS-Term-Art `verteilung` und `anteil` (AP-10 IP-5) — PR #688 nachziehen, Teil 3 von 4

Ein Formel-Term nimmt den ganzen Wert seines Eingangs, nur den positiven/negativen **Teil** eines
Messwerts (`anteil`, E4: Laden/Entladen als ZWEI Terme, nie Saldo) oder den **Anteil DES TAGES** einer
Kostenstelle an einer Messstelle (`eingang_art = verteilung`, E11: „4100 von MS-07“ statt Faktor 0,7).
Gebaut sind Speicher, Schnittstelle und Rechenweg. Der Leseweg der **Verteilung** ist seit AP-10 IP-8
eingelöst (`uems-verteilung.md`); der Teil eines Messwerts wartet weiter als **benannte Ablehnung**. Vertrag: `messstelle-formel.md`
§1.1/§6.3, `verteilung.md` §2.1, Block `leseweg` in `verteilung-vectors.json`.

| Was | Wo |
|---|---|
| Migration | `V20260913143000__uems_formel_term_verteilung.sql` |
| Die EINE Stelle | `uems/AnteilLeseweg#lies` (+ `Ablehnung`, `Lesung`, `vertragsregel`, `tagesanteil`) |
| Schreiben/Rechnen | `MessstelleFormelService.bindung`/`liveWert`/`termVerlaeufe`, `MessstelleFormelTermRepository` (`TermZeile.verteilungZiel`/`anteil`) |
| Schnittstelle | `MessstelleFormelDto.TermEingabe`/`Term`, `openapi.yaml` (`MessstelleFormelTerm`, `…FassungEintragen`, `…Fehler`), `api.ts` |
| Tests | `AnteilLesewegVectorsTest`, `MessstelleFormelSchnittstelleVertragTest` (rein) · `MessstelleFormelTermVerteilungMigrationTest`, `MessstelleFormelVerteilungsTermApiTest` (Docker) · `uemsVerteilung.test.ts` |

```bash
(cd services/api && ./mvnw test -Dtest='AnteilLesewegVectorsTest,VerteilungVectorsTest,BilanzVectorsTest,MessstelleFormelSchnittstelleVertragTest')
(cd services/api && ./mvnw test -Dtest='MessstelleFormelTermVerteilungMigrationTest,MessstelleFormelVerteilungsTermApiTest,MessstelleFormelApiTest,MessstelleFormelFassungApiTest')
(cd frontend/portal && npx vitest run src/uemsVerteilung.test.ts src/gesamtwert.test.ts src/gesamtwertQuelle.test.ts)
```

## Die offene Abhängigkeit — und wo sie aufgelöst wird

| Fehlt | Ablehnung (422, Kundensatz im Vertrag) | Liefert | Was das Paket ändert |
|---|---|---|---|
| Teil eines Messwerts | `anteil_wartet_auf_ap08` (`feld` `terme[i].anteil`, `wartet_auf` „AP-08 IP-7“) | ✅ AP-08 IP-7 lieferte Quellenbindung mit `anteil` + `VerbrauchRegeln.anteilJeRohwert` — ⚠ der Zweig bleibt benannt: der Formel-Verlauf liest `device_measurement_rollup_15m.avg_numeric`, ein Anteil DARAUS wäre je Mittelwert (E15 Option C, verworfen) | den Zweig `anteil` in `AnteilLeseweg#lies` — erst wenn der Verlauf je Term aus Rohwerten rechnet (`uems-quelle-anteil.md`) |
| Anteil des Tages | ✅ eingelöst — `verteilung_wartet_auf_ip8` gibt es nicht mehr | ✅ AP-10 IP-8 (`V20260913230000`, `messstelle_verteilung`) | der Zweig `verteilung` liest die Zeilen am Tag (`VerteilungRepository.stand` → `VerteilungRegeln.amTag`) → `tagesanteil(term, tag, abschnitte)`; ohne Zeile `nicht_verteilt`; der Schreibweg prüft an der alten Stelle „Kostenstelle da“ (404) |
| Kostenstelle als Objekt | — | ✅ AP-10 IP-7 (`V20260913160000`) | Fremdschlüssel `messstelle_formel_term_verteilung_ziel_fk`: `(verteilung_ziel, tenant_id) → kostenstelle (id, tenant_id)`, RESTRICT — Tests brauchen eine echte Kostenstelle |

Mehr ändert sich dort nicht: die Anwendung des Anteils im Live-Wert und je Bucket ist schon verdrahtet
(`Lesung.urteil` → `VerteilungRegeln.term`). Beweis: `MessstelleFormelVerteilungsTermApiTest` schreibt
seit IP-8 die Verteilung über `PUT …/verteilung` — dieselbe Kette speichert den Term und rechnet vorgestern
70 %, gestern und heute 60 %, vor der Verteilung keinen Wert.

## Fallen

1. ⚠ **Nie ein vorhandenes Wort borgen.** `nicht_verteilt`/`ziel_besteht_nicht` sagen etwas über eine
   VORHANDENE Verteilung; „wir können es noch nicht wissen“ ist ein eigener Code (firstmate 13.09.2026).
   `AnteilLesewegVectorsTest` prüft, dass die wartenden Codes nicht in `vokabulare.fehler` stehen.
2. ⚠ **Der Anteil gilt je TAG, nie heute.** Live-Wert = heute, Verlauf = Tag des Bucket-Beginns in der
   Zeitzone (je Term ein Tages-Cache), Schreiben = erster Tag der Fassung (`anlegen`: heute). F13: der
   10.01.2027 bleibt 70 %, obwohl ab 15.01. 60 % gilt.
3. **`gesamt` hat genau eine Schreibweise: NULL.** CHECK `anteil IS NULL OR anteil IN ('positiv','negativ')`;
   die Anfrage nimmt `"gesamt"` an und speichert NULL. Darum ändert die Migration keine Bestandszeile
   (`Bestandsschutz`-Vergleich leer) und die Antwort trägt `anteil` nie als `gesamt`.
4. **Zeichengleich für PR #689:** `verteilung_ziel`/`anteil` sind `@JsonInclude(NON_NULL)` am
   Record-Bestandteil, optional in `api.ts`, nicht `required` in der OpenAPI; das Protokoll-JSON trägt
   sie nur, wenn gesetzt. `gesamtwert.ts`, `gesamtwertQuelle.ts`, `GesamtwertDialog.tsx` sind unverändert.
5. **Prüfreihenfolge im Schreibweg:** Form 400 → Eingang da (404, fremd ist nicht da) →
   `verteilungs_term_ohne_faktor` → `anteil_wartet_auf_ap08` → Kostenstelle da (404, seit IP-8 an der
   Stelle von `verteilung_wartet_auf_ip8`). Nichts wird geschrieben, auch keine Fassung.
6. **Ein Verteilungs-Term ist eine Kante** für `formel_zyklus` (`verkettungen` liest `messstelle` UND
   `verteilung`) und zählt im Lebenszyklus über seine Quell-Messstelle (`stand`).
7. **Postgres prüft CHECKs in Namensreihenfolge** (`anteil_chk` < `bindung_chk` < … <
   `verteilung_faktor_chk`) — ein Migrationstest, der den Constraint-Namen erwartet, braucht eine
   sonst gültige Zeile.

## Nicht dieses Paket

Kein Anteils-Leseweg (AP-08 IP-7), keine Verteilung (seit IP-8 gebaut: `uems-verteilung.md`), keine dynamischen
Umlageschlüssel (ein Anteil ist eine gepflegte Zahl mit Gültigkeit), keine Verlaufsquelle (IP-10),
kein Netzanschluss (IP-6), keine Route, keine Portal-Fläche über die Typen hinaus, keine
Rechte-Durchsetzung (`messstelle.formel` bleibt Kommentar).
