# Kennzahlen, Berichte und Exporte: Geltungsbereich (AP-03 IP-11)

Der Prüfpunkt ist `zugriff/Geltungsbereich`: `requireSite` für Anlagen, `scope` für Listen und
`requireScope` vor einer einzelnen Ausgabe. Er ruft die unveränderte Rechte-Matrix auf. Fremder Standort:
404 ohne Existenzbestätigung; Unternehmensbericht/-export ohne U-Rolle: 403 `recht_fehlt`.
Unterstützung erhält kein Unternehmensrecht. Die RLS-Verbindung bleibt gezäunt.

## Kennzahlen: R-A1 und R-A6, niemals Teilrechnung

Die Vertragsregel steht unverändert in [Kennzahl §10 R3](../../contracts/v2/kennzahl.md), ihre Zwillinge sind
`KennzahlRegeln.sichtbarkeit` und `uemsKennzahl.sichtbarkeit`, geprüft gegen `kennzahl-vectors.json` (K18).
Seit IP-11 wird sie auch am API durchgesetzt. `KennzahlUmfang` liest ausschließlich die Geltungen der Eingänge,
rekursiv über Kennzahlen, Messstellen-Formeln, Bezugsgrößen und deren Orte. Er berücksichtigt alle Fassungen und
gespeicherten Eingänge, weil die Einzelroute auch Fassungen und alte Versionen erschließt. Unbekannte oder durch
RLS verdeckte Bezüge gewähren keinen Zugriff. Der Rechenlauf bleibt unverändert; nie wird ein Wert für eine
Person neu gerechnet oder ein Eingang still aus der Rechnung entfernt.

`KennzahlService` prüft vor Detail, Fassungen und Berechnung; `KennzahlWerteService` läuft dadurch für Werte und
Versionshistorie über denselben Prüfpunkt. Die Paar-Auswahl verwendet die gefilterte Liste. Die Vorschau prüft
zusätzlich ihre Eingänge vor dem Lesen von Werten und vor Befunden, die fremde Namen nennen könnten.
Änderungen, Archivieren, Löschen und neue Fassungen prüfen die Sicht vor jeder Mutation, damit eine
abschließende 404-Antwort niemals eine bereits ausgeführte Änderung verdeckt.

Unsichtbare Einzelkennzahlen: 404. Die Liste liefert nur `ausserhalb_zugriff {anzahl, text}`, wenn mindestens ein
Eingang sichtbar ist; niemals ID, Name, Formel oder Wert der verborgenen Kennzahl. Ohne Hinweis fehlt das neue Feld,
damit die volle Sicht ihre Antwortform behält. Das Portal nutzt dieses additive Feld erst in IP-12.

**Korrigierte A15-Abnahme (Firstmate 16.09.2026):** W3 wurde am 14.09.2026 entschieden und ist jünger als A15.
KZ-0003 gehört zum Unternehmen: Jonas/Ines sehen 0,20 kWh/Stück; Claudia und Peter erhalten nur den Anzahl-Hinweis.
Das Fehlen eines Unternehmensrechts wird nicht durch vollständige Sicht auf die Eingangs-Standorte geheilt.

## Berichte, Export und Eigene Auswertung

- Alle Berichtswege einschließlich Folgen-Abfrage, Entwurf, Vergleich, Stand, CSV/PDF und Freigabe prüfen
  `Geltungsbereich`; bestehende Fehlerformen und die Aktionsrechte bleiben erhalten.
- `BestandGeraeteCsv` prüft denselben Geltungsbereich und das Exportrecht. Der Verlauf prüft weiterhin sowohl
  die Anlage des Geräts als auch `?siteId=`. Die Vergleichsauswahl nutzt ebenfalls `requireSite`.
- `EigeneAuswertungService.forSite` prüft selbst, bevor er Definitionen oder Werte liest; die vorherige
  eigene Existenzprüfung im Controller entfällt.
- `TeilansichtDienst.exportKopf` nennt nur zugängliche Standortnamen und die erlaubte Gesamtanzahl aus IP-10.
  Bei eingeschränkter Sicht lautet die zusätzliche CSV-Kommentarzeile `# Teilansicht: … (n von m Standorten)`.
  Volle Sicht bekommt keine neue Zeile. Archivierte Standorte bleiben abrufbar, zählen aber wie bei IP-10 nicht im Kopf.
- Ein freigegebener Abzug wird niemals gefiltert oder neu gerechnet; der CSV-Kopf ist ein Abrufzusatz. PDF bleibt
  für jeden berechtigten Abrufer identisch. Vorlagenkataloge enthalten keine Kundendaten und benötigen keinen Objektzaun.

Nachweise: `TeilansichtApiTest` (A12, echte Zuweisungen/RLS), `KennzahlWerteApiTest` (A15, alle Lesewege, später fremder
Eingang), `BerichtApiTest` (Unternehmens-403, fremde Berichte-404, CSV-Kopf, unveränderter Abzug und PDF),
`BestandGeraeteCsvTest` (Zeichenvergleich), `SiteScopeArchitekturTest` (bestehende Telemetrie-Allowlist plus Aufrufer).
Keine Migration, keine Edge-/MQTT-Änderung und keine Portal-Oberfläche.
