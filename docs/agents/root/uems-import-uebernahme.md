# Bezugsdaten übernehmen und zurücknehmen (AP-09 IP-13)

`ImportUebernahmeService` führt C6/C7 aus. Multipart `POST /api/v1/bezugsdaten/importe`
übermittelt `datei`, `zuordnung` wie die Vorschau sowie `bestaetigung` als JSON:
`vorschau` (kurzlebige Kennung), `entscheidungen` (Zeilennummer → behalten/ersetzen),
`begruendung` und bei Teilübernahme den exakten `teiluebernahme`-Satz der Regel.
Die Vorschau wird unter der IP-7-Mandantensperre erneut gerechnet. Ein veränderter
Bestand oder eine abgelaufene Kennung verlangt eine neue Vorschau.

- `POST …/{kennung}/ruecknahme` mit `begruendung`: neue Wert-Fassungen, nie DELETE.
  Eine spätere fremde Berichtigung wird nicht überschrieben (409 gleichzeitig).
- `GET …/{kennung}`: Import-Status, wirksame Änderungen und offene Vorschläge.
- Vier Augen betreffen Berichtigungen und Rücknahmen. Erstwerte wirken sofort.
  `POST …/{kennung}/freigeben` mit `begruendung` verwendet `KorrekturFreigabeService`
  und `KorrekturRechte`. Ein Import-Vorschlag wird gemeinsam freigegeben; alle
  erwarteten Wert-Fassungen müssen noch gelten. IP-7 sperrt ebenfalls offene Import-Vorschläge.
- Jede Zeile und jeder Vorschlag prüft das Recht am Bezugsgrößen-Ziel; Mandant nur aus Kontext.
- `correction` nennt `import=I-…` und als Korrektur-Anlass
  `I-…/Zeile-n/Fassung-m`. Das ist absichtlich je Wert eindeutig: die Kaskade führt
  ihren Fortschritt pro Anlass, nicht pro Import-Datei.
- `V20260916223000`: leeres, RLS-geschütztes Freigabe-Journal; append-only,
  Folgefassungen und zweite Person zusätzlich in der DB. Offboarding räumt es mit auf.
  Keine neue Spalte wird in Abfragen gegen alte Migrationsstände vorausgesetzt.

Prüfungen: `BezugsdatenImportUebernahmeApiTest`, bestehende Vorschau/IP-7/Freigabe,
`BezugsdatenVectorsTest` und Portal `bezugsdaten.test.ts`; Migrationen einschließlich
sechs Bestandsschutz-Nachbarn. Die API-Tests verwenden abgeschlossene relative Monate
mit den Beträgen von B1/B2/B3/B13/B14, weil der Datenbank-Zeitstempel die Zukunft sperrt.
