# UEMS-Energiemanagement: Feststellung und Wirksamkeit – Routen (AP-19 IP-19)

Neu am 25.09.2026: die Routen über `feststellung`, `feststellung_eintrag` und `feststellung_wirksamkeit` aus IP-16
([Datenhaltung](uems-audit-feststellung-datenhaltung.md)). Konzept: AP-19 §4.7 FS1–FS7, W15, §5.4, §5.6, R10, R11
(`vp-uems-ap19-fundament/report.md`). Noch keine Fläche (Portal IP-20); das Audit: [Routen](uems-audit-routen.md).

| Stelle | Was |
|---|---|
| `FeststellungController` | `GET/POST /api/v1/energiemanagement/feststellungen` (`?tag=`, offene zuerst nach Frist), `GET …/{id}`, `POST …/{id}/eintraege`, `PUT …/{id}/frist · verantwortlicher` — `energiemanagement.verwalten` Ziel `DIENST` (am Standort des Bezugs, ohne Standort am Unternehmen); `POST …/{id}/wirksamkeit` (`wirksam · nicht_wirksam`), `…/abschliessen` (`ohne_massnahme · zurueckgenommen`), `…/wirksamkeit/beantragen · freigeben · ablehnen` — `energiemanagement.freigeben` am Unternehmen; keine Löschroute |
| `FeststellungService` | Prüfungen und Ablehnungs-Codes (`openapi.yaml`); Uhr `uhrStellen`; `kopie(...)` baut die Kopie des Stands mit genau den Schlüsseln der Referenz (`feststellung`, `wortlaut`, `eintraege` = Anzahl, `massnahmen` mit Zustand, `aufgabe` = am Tag laufende Zuordnung der Aufgabe im Bezug, `am`); `vierAugen(...)` das Antwortfeld |
| `FeststellungRepository` | SQL unter RLS + Zaun; jeder Übergang eine Zeile `energiemanagement_aenderung` (`feststellung_erfasst · eintrag · feststellung_geaendert · wirksamkeit_beantragt · wirksamkeit_geprueft · wirksamkeit_abgelehnt · feststellung_abgeschlossen`); die Berechtigten = aktive Konten mit wirksamer KA/EM-Zuweisung am Unternehmen |
| `FeststellungVerzeichnis` · `FeststellungVerantwortung` | Verzeichnis-Quelle (Gruppe `audits_feststellungen`: je Feststellung eine Zeile ab festgestellt am, ohne Prüfsumme; je freigegebenen Stand eine Zeile `wirksamkeit` mit Nr. und Prüfsumme) und Verantwortungs-Quelle (Art `feststellung`) — beide nur über den Dienst |
| Nachweis | `FeststellungApiTest` (R10, R11 `dbda6aff…`, `nicht_wirksam` hält offen, Vier-Augen, 403 inkl. Einsicht, Zaun am Standort), `FeststellungSchnittstelleVertragTest` (openapi ↔ DTO ↔ Vokabular, Kopie = Vektor, Satz §5.8), Zeilen in `RechtMatrixApiTest` und `RechtRoutenArchitekturTest` (DIENST) |

⚠ **Vier-Augen nicht erfüllbar ist ein Antwortfeld, keine stille Sperre (FS6, W15):** `vieraugen` an `GET …/{id}`
nennt `berechtigte`, `zweite_person` (ohne Urheberin — die eines offenen Antrags, sonst die anfragende Person — und
ohne Verantwortlichen) und bei niemandem `satz` = „Vier-Augen nicht erfüllbar: außer … darf niemand freigeben, und
beide sind hier beteiligt.“ `…/beantragen` lehnt dann mit 409 `vieraugen_nicht_erfuellbar` (Satz + Personen) ab:
ein Antrag, über den niemand entscheiden kann, würde jeden weiteren Stand sperren (ein offener Antrag je Feststellung).
⚠ **Den Zustand `abgeschlossen` schreibt nie der Dienst** — der schließende Stand setzt ihn im Trigger; der
Vertragstest hält `SET zustand` aus dem Repository heraus.
⚠ **Managementbewertung als Quelle ist bis IP-23 unbekannt** (422 `quelle_unbekannt`, Muster `MassnahmeService`
W14) — wer IP-23 baut, prüft dort die BR-Kennung gegen die neue Tabelle.
⚠ **Ein Bearbeiter kommt bis zum Dienst** (`DIENST`): eine Feststellung am Unternehmen gibt es für ihn nicht (404,
Zaun vor Recht), an seinem Standort erfasst er; beim Erfassen außerhalb 422 `standort_unbekannt`.
⚠ **Die Wirksamkeit prüft die Maßnahmen im Zaun der Anfrage** (Herkunft `nichtkonformitaet` + Kennung, IP-17):
jede umgesetzt, bewertet oder verworfen, mindestens eine umgesetzt oder bewertet — ohne Maßnahme 409
`wirksamkeit_noch_nicht`; ohne Maßnahme schließt `…/abschliessen`.
