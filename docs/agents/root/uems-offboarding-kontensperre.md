# Mandanten-Offboarding: Konten vor dem Datenbankabbau sperren

`AdminController.deleteTenant` bestätigt weiterhin den Mandantennamen. Danach sperrt
`AdminBenutzerService.offboardingSperren` alle vollständig gelisteten Keycloak-Konten
und den lokalen Spiegel. Erst nach diesem Commit läuft `TenantRepository.offboard`
mit seiner eigenen Datenbanktransaktion; erst danach werden die Konten endgültig gelöscht.

Der gemeinsame IP-9-Weg bleibt `ZugriffAenderung.kontoBeenden`. Die aggregierte,
plattformgeschützte Methode `kundenbereichSperren` verwendet dieselben Schreib- und
Protokollschritte. Nur beim Ende des **ganzen** Kundenbereichs entfällt die
Einzelkontenregel für den letzten Administrator. Kein Request kann diese Ausnahme
für eine einzelne Kontosperre wählen. Der gemeinsame Kontenverwaltungs-Lock gilt
für den Sperrvorgang und den Datenbankabbau. Unter dem Abbau-Lock wird die
Kontenliste nochmals vollständig gelesen und gesperrt; so kann ein zwischenzeitliches
Entsperren kein aktives Restkonto hinterlassen. Kontoanlage nimmt denselben Lock
vor dem externen Schreiben und prüft danach, dass der Mandant noch existiert.
Die Systeme haben keine verteilte Transaktion.

- Sperrfehler oder möglicherweise abgeschnittene Kontenliste: kein Datenbankabbau.
  Lokale Änderungen rollen zurück; schon extern gesperrte Konten bleiben gesperrt.
- Datenbankfehler: Daten rollen zurück, die zuvor committeten Kontensperren bleiben.
  Nach Beheben der Ursache denselben bestätigten Offboarding-Aufruf wiederholen.
- Fehler der endgültigen Kontenlöschung: `failedUsers` und das Betriebslog nennen
  die offenen Konten (Log mit Mandanten- und Keycloak-ID). Sie bleiben deaktiviert.
- `POST /api/v1/admin/tenants/{tenantId}/offboarding/cleanup` wiederholt das Aufräumen
  anhand des verbleibenden Keycloak-Attributs. Nur Plattformrolle, bestehender
  Mandant = 409; leere Liste = erfolgreicher Abschluss. Auch nach Prozessabbruch
  zwischen DB-Commit und Kontenlöschung wiederholbar. Keine neue Tabelle oder Job.
- `ZugriffKontextLader` erkennt den fehlenden Mandanten vor der E12-Rückfallregel;
  `ZugriffFilter` weist alte JWTs dann mit 401 ab, ausdrücklich auch bei `/me`.
  Ohne diese Prüfung erschiene der gelöschte Benutzer mangels Spiegel wieder aktiv.
- Der Registrierungs-Rollback (`TenantRepository.deleteById`) und die kompensierende
  Kontoanlage (`StartpasswortKonten`) sind eigenständige Wege und bleiben unverändert.

Nachweise: `AdminApiTest#offboarding*` (echtes Keycloak, neue Anmeldung/Refresh,
altes JWT, Reihenfolge, Fehler und Wiederholung), der vorhandene vollständige
Offboarding-Normalfall und `AdminBenutzerEntzugApiTest` für die Einzelkontengrenzen.
HTTP-Vertrag: `docs/contracts/openapi.yaml`.
