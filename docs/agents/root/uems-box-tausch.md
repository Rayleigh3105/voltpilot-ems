# Box-Tausch als Nachfolger (AP-06 IP-19)

`POST /api/v1/devices/{newId}/succeed/{oldId}` verwendet
`datenquelle.zustaendigkeit` und prüft beide Boxen/Anlagen unter RLS. Eine fremde
Box bleibt 404. `BoxTauschService` schreibt alle Übernahmen in einer Transaktion;
`BoxTauschZustellung` ruft erst nach dem Commit die vorhandenen Transporte auf.

- **Gleiche Heimat erforderlich** (firstmate, 16.09.2026): andere Anlage gibt
  `409 nachfolger_andere_heimat`. `EnrollmentService.certificateFor/issueGuarded`
  unterscheiden vorhandene Zertifikate bisher über die Gerätekennung;
  `edge-app/core/internal/enroll/enroll.go:Reconcile` übernimmt bei gleicher
  Kennung und gleichem Broker keine geänderte Anlagenidentität. Anlagenwechsel
  braucht ein eigenes Paket mit Edge-Release, keine verdeckte Cloud-Umbuchung.
- Übernommen werden führende Rolle, laufende Zuständigkeiten, Komponenten- und
  Asset-Verweise, aktuelle Mess-Selektionen, Freigabe und OTA-Ziel. Die alte Box
  erhält `status=retired` und `ausgebaut_am`; beide Identitäten bleiben erhalten.
  Der bestehende Endgültigkeits-Trigger und alle `ausgebaut_am`-Filter gelten.
- Zuständigkeiten enden/beginnen halboffen auf derselben Minute. Ein Wechsel in
  der Beginnminute, zukünftige Wechsel und das bestehende anlagenübergreifende
  AP-07-Gate werden mit 409 abgelehnt. Eine bereits eingesetzte Nachfolger-Box
  wird nicht überschrieben. Entfernen mit laufenden/geplanten Zuständigkeiten
  gibt `409 box_hat_zustaendigkeiten`.
- Quellen, Geräte, Messstellen, Karten/Bindungen, Helfer-/Summenwert-Anker und
  Messhistorie bleiben. Aktuelle Selektionen wechseln die Box und bekommen
  eigene neue Auswahlereignisse, keine erfundene Quittung. Historische Ereignisse,
  Software-/LAN-/Mess-/Steuerungsrückmeldungen bleiben an ihrer Hardware.
- `device_succession` hält Akteur, Zeitpunkt, Übernahmezahlen und den dauerhaften
  Zustellauftrag; jede Quelle erhält zusätzlich ihren Zuständigkeits-Eintrag.
  Kein DELETE, kein Unclaim/Purge und kein Löschen über Kaskaden im Tausch.
- Zustellung: erst ACL entfernen und vorhandenen Broker-Reload bestätigen,
  dann alte retained Slots einschließlich v1-Schedule und v2-Plan räumen, dann Quellen an den Nachfolger freigeben und
  dessen Konfiguration zustellen. Das ist die vorhandene Broker-Zugriffssperre;
  die kryptografische CRL-Sperre bleibt wie beim Unclaim der Betreiberweg.
  Enrollment-Poll und Entzug teilen die Ref-Sperre: kein verspätetes Signieren
  legt den alten Grant nach dem Entzug wieder an. Eine inzwischen neu angemeldete
  Aufkleber-Referenz behält ihren neuen Provisioning-Slot; Claim und verzögerte
  Bereinigung teilen dafür eine globale Referenzsperre.
- Ohne bestätigte Zustellung antwortet die Route mit 202 und `zugestellt=false`;
  der Auftrag bleibt erhalten. Der Wiederholer verwendet den vorhandenen
  `voltpilot.uems.uebergabe.enabled`-Schalter (Produktion an, Surefire aus).
  200 bestätigt die Cloud-Zustellung; die gemessene Wirkung bleibt getrennt.

Nachweise: `BoxTauschApiTest`, `EnrollmentServiceStartupReloadTest`, Rechte-/Scope-
Architekturwächter, `RechtMatrixApiTest`, Registry-Push- und Controllerwechsel-
Bestand sowie die sechs Migrations-Nachbarn. Migration `V20260917107000` ändert
keine Bestandszeile. Offboarding berücksichtigt die neue Tabelle auch bei Tests
gegen ältere Schemafassungen.
