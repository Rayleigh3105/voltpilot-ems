# Energieeinsatz: Datenhaltung und Routen (AP-16 IP-3/IP-4)

Verbindlich: [Bewertung §7](../../contracts/v2/bewertung.md#7-datenhaltung-ip-3-b1b4b5),
Migration `V20260922210000__uems_energieeinsatz.sql`, `uems/EnergieeinsatzRepository`.

- Der Mandant kommt aus `TenantContext`, das Unternehmen über den Prozess. Der partielle
  Unique-Index verhindert zwei laufende Einsätze je Prozess und Träger.
- Repository-Mutationen benötigen die Spring-Transaktionsproxies: Daten und Protokoll
  werden gemeinsam gespeichert, Einflussgrößen aufgehoben statt gelöscht.
- Der Verantwortliche gibt keine Sichtbarkeit. `EnergieeinsatzService` prüft den
  Messstellen-Standort-Zaun; Schreibrechte stehen am Controller. Name und Konto sind
  Schnappschüsse; Konto-Ende kommt aus dem Benutzerspiegel und
  dessen bestehendem Protokoll, kein zusätzlicher Konten-Schreibweg.
- Offboarding löscht die neuen Kinder vor Einsatz und vor Benutzer/Bezugsgröße/Prozess.
  Existenzproben erhalten ältere Migrations-Teststände. Der Bezugsgrößen-Löschweg bleibt
  bestehen; der RESTRICT-Fremdschlüssel schützt verwendete Verweise. `BezugsgroesseService`
  liefert dafür 409 `bezugsgroesse_in_verwendung` mit Einsatz-Kennzeichen,
  auch bei historischen Verweisen.
- Abnahme: `EnergieeinsatzDatenhaltungTest` (einschließlich Referenzwelt 1.6 und Offboarding),
  sechs Mengen-Migrationsnachbarn und `UemsProduktionsreihenfolgeMigrationTest`. Die
  Nachzügler-Probe `UemsZugriffMigrationTest.BAUEN_DARAUF_AUF` nennt diese Migration,
  weil der Verantwortlichen-FK die Benutzergrundlage benötigt.
- Rechte-Nachträge brauchen auch `rechte-vectors.json`; `rechte-matrix.md` wird mit
  `python3 docs/contracts/v2/tools/rechte_matrix.py` erzeugt. Ereignisse sind nur reserviert.

- API-Formen und Ablehnungen: [Bewertung §8](../../contracts/v2/bewertung.md#8-routen-ip-4-b1b4b5-r5r14),
  `EnergieeinsatzController`, `EnergieeinsatzApiTest`. GET ohne `@Recht`, mit Rechte-Kommentar;
  Lesen über Unternehmensrolle oder mindestens eine lesbare Prozess-Messstelle.
  Die Monatsübersicht nutzt `MessstelleWerteService`, keine neue Mengenbildung.
