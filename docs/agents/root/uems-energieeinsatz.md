# Energieeinsatz: Datenhaltung (AP-16 IP-3)

Verbindlich: [Bewertung §7](../../contracts/v2/bewertung.md#7-datenhaltung-ip-3-b1b4b5),
Migration `V20260922210000__uems_energieeinsatz.sql`, `uems/EnergieeinsatzRepository`.

- Der Mandant kommt aus `TenantContext`, das Unternehmen über den Prozess. Der partielle
  Unique-Index verhindert zwei laufende Einsätze je Prozess und Träger.
- Repository-Mutationen benötigen die Spring-Transaktionsproxies: Daten und Protokoll
  werden gemeinsam gespeichert, Einflussgrößen aufgehoben statt gelöscht.
- Der Verantwortliche gibt keine Sichtbarkeit. IP-4 muss Rechte und Messstellen-Standort-Zaun
  prüfen. Name und Konto sind Schnappschüsse; Konto-Ende kommt aus dem Benutzerspiegel und
  dessen bestehendem Protokoll, kein zusätzlicher Konten-Schreibweg.
- Offboarding löscht die neuen Kinder vor Einsatz und vor Benutzer/Bezugsgröße/Prozess.
  Existenzproben erhalten ältere Migrations-Teststände. Der Bezugsgrößen-Löschweg bleibt
  bestehen; ein verwendeter Verweis scheitert am neuen RESTRICT-Fremdschlüssel. IP-4 muss
  dafür eine verständliche 409-Antwort ergänzen; dessen heutiger Fehlerhandler kennt diesen FK noch nicht.
- Abnahme: `EnergieeinsatzDatenhaltungTest` (einschließlich Referenzwelt 1.6 und Offboarding),
  sechs Mengen-Migrationsnachbarn und `UemsProduktionsreihenfolgeMigrationTest`. Die
  Nachzügler-Probe `UemsZugriffMigrationTest.BAUEN_DARAUF_AUF` nennt diese Migration,
  weil der Verantwortlichen-FK die Benutzergrundlage benötigt.
- Rechte-Nachträge brauchen auch `rechte-vectors.json`; `rechte-matrix.md` wird mit
  `python3 docs/contracts/v2/tools/rechte_matrix.py` erzeugt. Ereignisse sind nur reserviert.
