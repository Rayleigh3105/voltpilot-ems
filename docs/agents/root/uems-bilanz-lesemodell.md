# UEMS-Bilanz je Anlage: Rest aus der Stellung, Vorschlag „Rest anlegen“ (AP-10 IP-9)

Das erste Lese-Modell der Energiebilanz. **Der Rest ist eine Rechnung, keine gespeicherte Zahl** (E3 = A):
seine Terme kommen je Tag aus der elektrischen Stellung, und eine Rest-**Messstelle** entsteht nur, wenn ein
Mensch den Vorschlag bestätigt (E18 = A). Bericht `data/vp-uems-ap10-bilanzen/report.md` §8 IP-9, F18.

| Was | Wo |
|---|---|
| Routen | `GET /api/v1/sites/{siteId}/bilanz?periode=tag\|monat\|jahr&am=` · `POST …/bilanz/rest` (`web/BilanzController`, `web/dto/BilanzDto`) |
| Arbeit | `uems/BilanzService` (Abschnitte, Vorschlag) · `uems/BilanzStellungen` (Stellungen → `BilanzAbleitung.StellungZeile`) · `uems/BilanzRestRepository` (die EINE Stelle, die `rest_hauptzaehler_id` liest) |
| Rechnung | NUR `BilanzAbleitung.restAusStellung` / `.summe` / `.live` und `MessstelleFormelRegeln.periodenwert("rest", …)` — die Route rechnet und formatiert nichts |
| Live + Anlegen | `MessstelleFormelService.restLive` (PR-688-Weg: frischeste Wirkleistung, `FRISCHE` 15 min) · `.restAnlegen` |
| Migration | `V20260913235700`: `formel_typ` kennt `rest`; `messstelle_formel_fassung.rest_hauptzaehler_id` (FK mit Mandant), CHECK Rest ⇔ Hauptzähler, eindeutiger Teil-Index je Hauptzähler, Constraint-Trigger `messstelle_formel_term_nicht_rest` |
| Register | `uems/RegisterBerechnung` → `berechnung` je berechneter Zeile, Aggregat zählt sie mit |
| Tests | `BilanzApiTest` (9, Testcontainers) · `UemsBilanzRestMigrationTest` (5) · `BilanzSchnittstelleVertragTest` · `BilanzVectorsTest`/`uemsBilanz.test.ts` (befristetes Kennzeichen) · `MessstelleRegisterApiTest` |

```bash
(cd services/api && ./mvnw test -Dtest='BilanzApiTest,UemsBilanzRestMigrationTest,BilanzSchnittstelleVertragTest,BilanzVectorsTest')
```

## Die Fallen

1. **Nichts wird nachgepflegt.** Die Rest-Messstelle speichert nur, WESSEN Rest sie ist
   (`rest_hauptzaehler_id`) — nie Terme. Zieht ein Unterzähler um, schreibt nur `PUT …/stellung`, und der Rest
   rechnet ab dem Tag ohne ihn (benannter Test
   `eineGeaenderteStellungAendertDenRestOhneDassEtwasNachgepflegtWird`). `POST …/formel/fassungen` lehnt einen
   Rest ab (400 `formel_typ`), die Datenbank jeden Term an einer Rest-Fassung — auch über den Rückweg „Term ohne
   `fassung_id` landet in der einzigen Fassung“.
2. **Abschnitte statt einer erfundenen Periodenzahl.** Gleiche Terme an allen Tagen der Periode (Tage ohne
   Hauptzähler zählen nicht als Wechsel) → EIN Abschnitt mit den Periodenwerten der Terme aus
   `MessstelleWerteService` (AP-08 IP-9). Wechseln die Terme (`stellung_geaendert`), rechnet jeder Abschnitt Tag
   für Tag; eine Zahl über die ganze Periode ist ein Periodenwert der berechneten Messstelle = **IP-10**.
   Vermerke „Stellung geändert (…)“ und Herkunft trägt die Route nicht (IP-12).
3. **`null` ist nie 0.** Ein nicht vollständiger Eingang macht den Rest „keine Werte“ (`menge` null); eine Rolle
   ohne Eingang hat `menge` null und „0 von 0“. Live: EIN veralteter Term (älter als 15 min) → `wert` null mit
   `fehlende: [{term, grund: veraltet}]` — nie die Teilsumme 12,6 kW, nie der letzte bekannte Wert (F18).
4. **Live in kW, Menge in kWh.** Die Live-Zeile summiert die führende **Wirkleistung** jeder Term-Messstelle in
   der Richtung ihrer Hauptgröße (Haupt- oder Nebengröße); ohne sie `kein_geraet`. Ein Anteil (Speicher,
   Vorzeichen-Bindung) wird je ROHWERT geteilt — im Verlauf (Rollup-Mittel) hat ein Anteils-Term darum keinen
   Wert, der Bucket bleibt `null`.
5. **Nie zweimal.** `restAnlegen` nimmt eine Transaktions-Sperre je Hauptzähler und sieht nach; der Teil-Index
   `messstelle_formel_fassung_ein_rest_je_hauptzaehler` ist die Wand dahinter. Zweiter Klick = 200
   `neu: false` mit derselben Messstelle; vier gleichzeitige Klicks = eine (Test). Nur ein HEUTE-Hauptzähler Bezug
   DIESER Anlage bekommt einen Rest (sonst 422 `rest_ohne_hauptzaehler` aus `fehler_neu`). Eine aufgehobene
   Rest-Fassung gibt den Hauptzähler frei, eine archivierte Rest-Messstelle nicht.
6. **Urheber protokolliert.** GENAU EIN `messstelle_aenderung` `angelegt` mit `actor_*`, `neu.formel_typ = rest`,
   `neu.rest_von`, `neu.herkunft = vorschlag_rest_anlegen`. Name vorbelegt „<Anlage> nicht zugeordnet“.
7. **Register: berechnete zählen mit.** Bis IP-9 stand im Wegweiser-Eintrag „Beobachtung je Messstelle“
   „(berechnete zählen erst mit AP-10)“ und in `MessstelleRegisterService`/OpenAPI/`api.ts` „eine berechnete
   steht in keinem Nenner“. Jetzt: `berechnung` = `ZustandAbleitung.berechnet` über die Eingänge der Formel des
   Tages (Rest: aus der Stellung; Messkanal-Term aus letztem Wert + Kadenz im selben Werte-Zug); vollständig =
   liefert, unvollständig = liefert nicht, **ohne Formel am Tag `null` und im Nenner wie „keine Datenquelle“**.
   Die zwei Zusatz-Abfragen laufen NUR, wenn es berechnete gibt (die Eine-Abfrage-Zählung bleibt).

## Das befristete Kennzeichen — wer es wieder entfernt

`GET …/messstellen/{id}/wert` und `…/verlauf` (PR #688) und die Live-Zeile der Bilanz tragen
`kennzeichen: ["vorläufig (Geräte-Verdichtung)"]` (`BilanzAbleitung.VORLAEUFIG_GERAETE_VERDICHTUNG` ⟷
`uemsBilanz.ts`, Vertrag `bilanz-vectors.json` `vokabulare.kennzeichen_befristet` mit `entfaellt_mit: AP-10 IP-10`).
⚠ **AP-10 IP-10 entfernt es**, wenn es die Periodenwerte berechneter Messstellen baut: Konstante, beide
`BEFRISTET`-Stellen (`MessstelleFormelService`, `BilanzService`), den Vektor-Eintrag samt der zwei Tests
(`dasBefristeteKennzeichenStehtImVertragMitSeinemAblauf` in Java und TS) und die OpenAPI-Beispiele.

## Rechte (eingetragen, nicht durchgesetzt)

Lesen `messstelle.ansehen`, „Rest anlegen“ `messstelle.formel` (AP-10 §4.10) — die Anmerkungen der
Nachtrags-Handlungen in `rechte-matrix.json` nennen die Routen; `RechteKennungenDerRoutenTest` kennt den
`BilanzController`.

## Nicht gebaut

Periodenwerte berechneter Messstellen und die Zahl über eine Periode mit Stellungswechsel (IP-10),
Korrektur-Kaskade (IP-11), Herkunft (IP-12), Portal-Fläche (IP-14), Rechte-Durchsetzung (AP-03), Rest eines
Unterzählers mit Unterzählern (`rest_ohne_hauptzaehler`), `saldo`-Schreibweg (IP-16).
