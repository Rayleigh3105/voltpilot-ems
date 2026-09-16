# Portal-Rechte-Weiche (AP-03 IP-12)

`frontend/portal/src/rollen.ts` ist die einzige Quelle für Kundenrechte: `darf(aktion, standort)`,
`sichtbareStandorte()` und `useRollen()`. Die Schale lädt `/me` vor den Kundendaten. Unbekannte oder gesperrte
Rechte öffnen keinen Hebel. Der Standort-Kontext ist eine Standort-ID, niemals eine Anlagen-ID.

## Vertrag und Anzeige

`/me` liefert wirksame Aktionslisten pro Standort und auf Unternehmensebene, Rollen, Umfänge und Zeitangaben
für künftige Zuweisungen. Rohe Zuweisungen mit ihren Gültigkeitsintervallen gehören nicht zu dieser Antwort.
Das Portal erfindet diese nicht aus Realm-Rollen: Der API-Dienst hat die Rechte-Matrix bereits angewandt.
Der TS-Zwilling `rechte.ts` liefert die Vertragswörter/Teilansicht; `rollenRechte.test.tsx` prüft jede Matrixzeile
mit API-förmigen Ahrenberg-Schnappschüssen aus demselben Zwilling.

`components/Recht` lässt erlaubte Kinder ohne zusätzliche DOM-Hülle stehen. Andernfalls nennt es Grund und
den Kundenadministrator aus `/me`. Ein fremder Standort erzeugt keinen Hinweis mit seinem Namen.
`RechteStandort.Provider` trägt das Ziel auch in React-Portale (Dialoge) weiter; ein abweichendes Ziel gehört
explizit an den Hebel. Berichte lesen denselben Zustand über `useBerichtRechte`, ohne eigene Abfrage oder Freigabe
bei fehlender Antwort.

`auth.isPlatformAdmin()` und `rollen.showTechnicalLayer()` bleiben Plattform-Grenzen. Dazu zählen der technische
Gerätekatalog, Diagnose, Hersteller-/Registerausstattung und interne Verwaltung. Der gemeinsam genutzte
`admin/FlowEditorPage` erhält vom Kunden-Wirt zusätzlich `recht="betriebsweise.aendern"`. OCPP schneidet
Kundenaktionen mit den bestehenden serverseitigen OCPP-Freigaben; Plattformbefehle behalten deren Prüfung.
Schalttest und physische Freigabe sind getrennte Aktionen. Rückwirkende Eingaben brauchen zusätzlich
`aenderung.rueckwirkend`; der Bearbeiter richtet gemäß W14 ab heute ein.

## Start und Verlust des Zugriffs

`App` baut die Navigation ausschließlich aus sichtbaren Standort-IDs der Selbstauskunft. Die Gesamtzahl
stammt vom Server. Bei einem sichtbaren Standort beginnt eingeschränkter Zugriff dort; ohne Zuweisung erscheint
L3. Ein Konto mit unternehmensweitem Zugriff ohne angelegte Standorte behält die bisherige Startweiche.

`api.request` meldet nur den Fehlercode `zugriff_beendet` als Entzug. Die Schale verwirft die alte Seite,
liest `/me` neu und öffnet die neue Startansicht. Eine verspätete Antwort des vorherigen Mandanten löst dies
nicht aus. Eine gewöhnliche 404 bleibt ein gewöhnlicher Fehler. Keine Summe wird im Portal um fremde Anteile
bereinigt; `ausserhalb_zugriff.text` der Kennzahlen wird als Hinweis übernommen.

## Listen-Umschlag und Nachweise

`GET /api/v1/sites`, `/devices`, `/edge-versions` liefern `SichtbareListe<T>`:
`{eintraege: [...], teilansicht: {sichtbar, gesamt}}`. Die Einträge bleiben RLS-gefiltert; die Metadaten sind
Transparenz, keine Zugriffsprüfung. Vertrag: `docs/contracts/openapi.yaml`, Leser: `api.ts` und die betreffenden
Komponenten. Standalone-Tests brauchen eine explizite `/me`-Momentaufnahme; Beispiele: `test/rollenFixtures.ts`
und `e2e/rollen-fixture.ts`. Niemals einen Produktions-Fallback für alte nackte Testlisten einbauen.

Gezielte Nachweise: `rollenRechte.test.tsx`, `apiRechte.test.ts`, `migration.test.ts`, `copy.test.ts`,
`e2e/portal-rechte.spec.ts` (R1/T1/T3, 375/1440, N7 → L3), `TeilansichtApiTest`, `ZugriffZaunApiTest`,
`TeilansichtSchnittstelleVertragTest` und die geänderten API-Listen-Leser. Keine Migration oder Edge-Vertragsänderung.

Der Bestandsschutz in `migration.test.ts` prüft die durchgereichten React-Kinder bytegleich und ergänzt einen
Fingerabdruck aller vorhandenen Kunden-Bedienelemente (`test/kundenBestand-vor-ip12.json`, UEMS-Bezugsstand
im Dokument). Der Fingerabdruck normalisiert nur TSX-Leerraum und den nicht gerenderten React-Schlüssel;
Beschriftung, Handler und Attribute bleiben Prüfgegenstand. Er ersetzt keine Dialog- oder Browserprüfung.
Beabsichtigte spätere Änderungen werden als einzelne `fortschreibungen` mit Datei, altem/neuem Fingerabdruck,
Commit und Grund ergänzt; die ursprünglichen 913 Fingerabdrücke bleiben erhalten. Der Wächter verlangt den
exakten Nachfolger und weist unbenutzte Fortschreibungen zurück. Die Netzanschlüsse-Klasse aus AP-10 IP-13
ist so belegt; `shell/AppShell.test.tsx` prüft daneben die unveränderten übrigen Buttons der Telefonleiste.
