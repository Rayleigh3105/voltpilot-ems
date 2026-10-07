# UEMS-Energiemanagement: „Trifft bei uns zurzeit nicht zu“ (Nachweisen n1, Entscheid 5)

Neu am 07.10.2026: je Teil des Überblicks (Vokabular `teil`, Vertrag energiemanagement 1.3, 18 Teile) ein Vermerk mit Satz und „entschieden von“.
Tabelle `energiemanagement_teil_vermerk` aus `V20261007004500` (RLS + FORCE, `site_scope` unternehmensweit, nur anhängen bis auf das einmalige Aufheben, höchstens ein geltender Vermerk je Teil).
Konzept: `data/vp-nachweisen-konzept-n1`, Runde 2, Entscheide 5 und 23.

| Stelle | Was |
|---|---|
| `EnergiemanagementTeilVermerkController` | `GET /api/v1/energiemanagement/teil-vermerke` (Recht `energiemanagement.ansehen`, nur unternehmensweit), `POST …/teil-vermerke` und `POST …/teil-vermerke/{id}/aufheben` (`@Recht(energiemanagement.verwalten, UNTERNEHMEN)`, Einsicht 403); keine Lösch-, keine Einzel-Route, 201 ohne `Location` |
| `EnergiemanagementTeilVermerkService` | Ablehnungen: Teil unbekannt 400 `anfrage_ungueltig` (`feld` `teil`), Satz nicht 10–500 Zeichen 400 `anfrage_ungueltig` (`feld` `satz`, `min`, `max`), `entschieden_von` fehlt 422 `entschieden_von_fehlt`, unbekannt 404 `nicht_gefunden`, nach ihrem „bis“ 422 `person_beendet`, Tag in der Zukunft 422 `tag_in_zukunft`, geltender Vermerk 409 `vermerk_besteht`, zweimal aufheben 409 `vermerk_aufgehoben`; Reihenfolge: geltende in der Folge von `teil`, dann aufgehobene, die zuletzt aufgehobene zuerst |
| `TeilVermerkVerzeichnis` (`@Order(25)`) | je Vermerk bis zum Stichtag eine Zeile Art `teil_vermerk`, Kennzeichen = Name des Teils, Titel „Teil: trifft bei uns zurzeit nicht zu“, bis zum Stichtag aufgehoben mit „· aufgehoben am TT.MM.JJJJ“; Gruppe je Teil in `TeilVermerkVerzeichnis.GRUPPE` |
| Offboarding | `TenantRepository.offboard` löscht die Vermerke vor `energiemanagement_person` (Fremdschlüssel RESTRICT) |
| Nachweis | `EnergiemanagementTeilVermerkApiTest` (anlegen, 409, aufheben, Rechte, Zaun, Verzeichnis), `EnergiemanagementTeilVermerkSchnittstelleVertragTest` (openapi ⟷ DTO ⟷ `teil`, Gruppe je Teil), `UemsTeilVermerkMigrationTest` (CHECKs, Trigger, Rechte, RLS, Offboarding, späte Ankunft) |

⚠ **Die Uhr:** „heute“, „nie in der Zukunft“, Eintragen und Aufheben hängen an der Uhr des Dienstes; `PruefumgebungUhr` stellt sie mit auf die Bühne, sonst wäre ein Tag der Bühne „in der Zukunft“.
⚠ **Kein Urteil:** ob ein Teil zutrifft, entscheidet der Kunde; die Datenbank prüft nur Form, Person und „höchstens einer geltend“.

```bash
(cd services/api && ./mvnw test -Dtest='EnergiemanagementTeilVermerk*Test,UemsTeilVermerkMigrationTest,EnergiemanagementVerzeichnis*Test')
```
