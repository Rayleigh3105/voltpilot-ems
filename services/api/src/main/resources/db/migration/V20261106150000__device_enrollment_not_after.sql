-- Lücke L4 (Adminview-Konzept Abschnitt 3.4): das Zertifikats-Ablaufdatum
-- stand bisher nur im PEM selbst, nirgends als eigene Spalte. Additiv, kein
-- Bruch: NULL bleibt "unbekannt / noch nicht ausgestellt", künftige
-- Ausstellungen füllen die Spalte sofort (EnrollmentRepository.storeCertificate).
-- Der Bestand (bereits ausgestellte Zertifikate ohne not_after) wird per Java
-- aus cert_pem zurückgefüllt (CertificateNotAfterBackfillRunner) statt in SQL -
-- X.509-Parsing gehört nicht in eine Flyway-Migration, und eine zukünftige
-- Änderung an der Rückfüll-Regel darf eine bereits angewandte Migration nicht
-- anfassen müssen.
ALTER TABLE device_enrollment ADD COLUMN IF NOT EXISTS not_after TIMESTAMPTZ;
