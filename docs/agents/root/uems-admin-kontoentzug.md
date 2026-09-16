# UEMS: Plattform-Kontenwege am Entzugsprüfpunkt

`AdminController` bindet `disable`, `delete` und den Gegenweg `enable` über
`admin/AdminBenutzerService` an `ZugriffAenderung.kontoBeenden` (AP-03 IP-9/IP-13),
denselben Kontenweg wie die Kunden-Benutzerverwaltung.
Der Plattform-Rollencheck bleibt; der Vertrag `RechteAbleitung.zuweisungAendern`
entscheidet über Selbstschutz und den letzten Kundenadministrator. Keine Kopie dieser Regeln.

- Der Zielmandant kommt aus dem admin-geschützten Pfad; ein `X-Tenant-Id` kann ihn
  nicht ersetzen. Der Dienst setzt den Plattform-Kontext nur innerhalb des Vorgangs
  und stellt beide vorherigen Kontexte im `finally` wieder her.
- Sperren setzt den Spiegel auf `gesperrt`, lässt Zuweisungen unverändert und
  deaktiviert Keycloak. Entfernen setzt `entfernt`, beendet auch künftige
  Zuweisungen und löscht das Keycloak-Konto. Identität und Protokolle bleiben.
- `ZugriffKontextLader` prüft den Kontozustand mit jeder Anfrage: ein altes Token
  bekommt sofort `404 zugriff_beendet`; `/me` zeigt weiter den Zustand. Das gilt
  auch vor der E12-Bestandsübernahme ohne bisherige Zuweisungen.
- Entsperren setzt das Konto wieder aktiv; frühere Entzüge bleiben beendet.
  Der vorhandene Protokollbegriff `zuweisen` trägt dabei den Grund „Konto entsperrt.“.
- Kunden- und Plattformänderungen nehmen denselben Transaktions-Lock je
  Kundenbereich. Gesperrte oder entfernte Administratoren zählen nicht als Ersatz;
  unbekannte weitere E12-Bestandskonten werden konservativ nicht mitgezählt.
- Jeder Entzug schreibt das Zugriffsprotokoll und je Zuweisung das Ortsprotokoll.
  Ohne Zuweisung steht der Vorgang am Unternehmen; fehlt auch dieses vor der
  Bestandsübernahme, bleibt wie bei IP-9 das Zugriffsprotokoll.
- Ein Keycloak-Fehler rollt die lokalen Änderungen zurück. Zwischen PostgreSQL und
  Keycloak gibt es keine verteilte Transaktion; ein Fehler beim abschließenden
  Datenbank-Commit nach erfolgreichem Keycloak-Aufruf bleibt eine Betriebsgrenze.

## Weitere Schreibwege und Abgrenzung

`rg 'keycloak\.(deleteUser|setEnabled)' services/api/src/main/java` belegt zusätzlich:
Mandanten-Offboarding (`AdminController.deleteTenant`) löscht Konten nach dem
Datenbank-Abbau; dies bleibt ein gesonderter Folgeauftrag. `StartpasswortKonten`
löscht ausschließlich kompensierend nach abgebrochener Kontoanlage. Beide Ausnahmen
sind in `ZugriffAenderungArchitekturTest` benannt. Unterstützungen behalten ihren
Prüfpunkt aus AP-03 IP-8, der Notfall-Zugriff braucht dessen eigene Selbstschutzregel.

## Nachweise

`AdminBenutzerEntzugApiTest`: beide Plattform-Entzugswege, alte Tokens, letzter
Administrator (auch parallel und mit gesperrtem Ersatz), Mandantenpfad, Plattformrolle,
Keycloak-Ausfall, E12 sowie Entsperren ohne Wiederbelebung früherer Entzüge.
`AdminApiTest#adminEditsEnablesAndDeletesUsersButNeverTheirOwnAccount` prüft den
Keycloak-Lebenszyklus mit echten Logins. `ZugriffEntzugApiTest` bewahrt die Kundenwege;
`RechtRoutenArchitekturTest`, `RechteKennungenDerRoutenTest` und
`ZugriffAenderungArchitekturTest` sichern die gemeinsame Grenze.
