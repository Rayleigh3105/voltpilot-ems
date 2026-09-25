# Managementbewertung: Sitzung, Beschlüsse, Folgen (AP-19 IP-23, MG4–MG7)

| Teil | Wo | Merke |
|---|---|---|
| Datenhaltung | `V20260925093000`: `managementbewertung_sitzung` (eine je Bericht), `…_beschluss` (Nr. n), `…_folge` (nur anhängen) | RLS + FORCE, Zaun folgt dem Bericht; Offboarding in `TenantRepository` vor `feststellung_wirksamkeit` |
| Routen | `ManagementbewertungController`: `GET …/managementbewertungen/{kennung}`, `PUT …/sitzung`, `POST …/beschluesse`, `PUT …/beschluesse/{nr}`, `POST …/beschluesse/{nr}/folgen` | Recht, Zaun, Sperre und Uhr kommen aus `BerichtService#managementbewertungEingabe/-Lesen` — eine andere Vorlage ist 404 |
| Entwurf | jede Eingabe (Sitzung, Beschluss) bildet den Entwurf in DERSELBEN Transaktion neu (`gebildet_von = abruf`) | ohne das friert die Freigabe einen Abzug ohne die neuen Beschlüsse ein — D4 kennt diese Tabellen nicht |
| Freigabe-Tor | `BerichtService#sitzungUndBeschluss` am Abzug: 422 `sitzung_fehlt` · `leitung_fehlt` · `beschluss_fehlt` | `sitzung.leitung` ist im Abzug `null`, wenn die Person am Sitzungstag nicht die laufende `unternehmensleitung` hat |
| Folgen | `ManagementbewertungLeser#folgen`: Hand-Verknüpfung (`von_hand`) ∪ Objekte mit `BR-…/Bn` — Maßnahme-Herkunft (`herkunft`), Aufgabe/Fassung `beschluss_kennung` (`zuordnung`/`fassung`), Eintrag `geprueft_bleibt` | gelesen, nie kopiert: Zustand von heute; der Stand der Sitzung bleibt byte-gleich, kein Anstoß (R14) |
| Nachbarn | `ManagementbewertungWiedervorlage` (`@Order(40)`, MG7 letzte Sitzung + Rhythmus), `ManagementbewertungVerzeichnis` (`@Order(110)`, entschieden von = Leitung aus dem Abzug; `VerzeichnisBestand` überspringt die Vorlage), `MassnahmeService`/`FeststellungService` prüfen `BR-…/Bn` gegen Beschluss + Stand | |

⚠ Kein Fremdschlüssel auf `bericht`: `UemsBerichtMigrationTest#keinBestehenderWegWirdEnger` verbietet jeden Schlüssel von außen
auf die Berichts-Tabellen — `bericht_id` ist ein Wert, das Offboarding löscht die drei Tabellen vorher.
⚠ Die Migration nennt Personen, Aufgabe, Fassung, Energieziel und Audit per Fremdschlüssel: sie steht in `BAUEN_DARAUF_AUF` von
`UemsBericht`- (mittelbar über 013500/031500), `UemsZugriff`-, `UemsEnergiemanagement`-, `UemsAuditFeststellung`-, `UemsVerbesserung`-, `UemsBezugsbasis`- und
`UemsKennzahlMigrationTest` — wer eine weitere Tabelle mit solchen Schlüsseln anlegt, trägt sich dort ebenso ein.
⚠ Eine genannte `beschluss_kennung` (Aufgabe, Dokument-Fassung, „geprüft, bleibt“) prüft
`ManagementbewertungBeschluss#pruefen` (Folge nach IP-23): 422 `beschluss_unbekannt`, wenn es den Beschluss nicht gibt,
422 `managementbewertung_nicht_freigegeben`, wenn er noch nicht im Stand steht; `null` bleibt erlaubt. Maßnahme-Herkunft und Feststellung lesen dieselbe Stelle über `imStand`.
⚠ Leser außerhalb einer Anfrage (ohne `TenantContext`) sehen wegen RLS nichts — im Test über die Route prüfen, nicht über den Dienst.

Nachweis: `ManagementbewertungVorlageApiTest` (R13 Sitzung/Beschlüsse/Freigabe-Tor/Verzeichnis/MG7, R14 Folgen und Stand byte-gleich).
