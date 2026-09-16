# Controllerwechsel (AP-04 IP-19, E10 / A6)

`GeraetWechselController` / `ZaehlerwechselService` erweitern den bestehenden Wechsel:
`GET /api/v1/geraete/{id}/austausch/vorschau?zeitpunkt=…` liest Karten und **alle**
Bindungen zum Zeitpunkt; `POST …/austausch` schreibt in derselben Transaktion wie
der Zählerwechsel. Fremde Geräte bleiben 404. Keine Migration.

- `karten_uebernommen: UUID[]` ist die ausdrückliche Kartenentscheidung; fehlend
  hält den bisherigen Schutz für Controller aufrecht, leer heißt alle ebenfalls neu.
  Eine Karte ist ein Einbau im Controller: alte Zeile beenden, neue Zeile anlegen.
  Nur übernommene Karten behalten ihre Seriennummer. Komponente und Kanal-Schlüssel
  bleiben stabil; die neue Bindung trägt den neuen Controller-Einbau.
- `ablesestaende: [{bindung, endstand?, anfangsstand?}]` ordnet jeden optionalen
  Stand genau einer führenden Zählerstand-Bindung zu, auch mehreren Zählwerken einer
  Karte. Keine Vergleichsquelle, fremde oder doppelte Bindung; nicht zusammen mit
  den alten einzelnen Stand-Feldern. Fehlend bleibt unbekannt, auch bei neuer Karte.
- `bestaetigte_bindungen` enthält alle in der Vorschau gezeigten Bindungen. Ein
  veralteter Umfang wird mit 409 abgewiesen. `MessstelleRegeln.kartenWechselPruefen`
  und `uemsMessstelle.kartenWechselPruefen` prüfen die Identitäten gegen dieselben
  sechs Erweiterungen der Vektorfamilie `wechsel`.
- Gerät, Karten, Speisungen und Quellen enden/beginnen halboffen zum **einen**
  Zeitpunkt. Der vorhandene Fehlerhaken am letzten Schritt beweist den Rollback.
  Protokollart bleibt `zaehler_gewechselt`, zusätzlich `neu.anlass=controllerwechsel`
  und `karten_uebernommen`. `device_replaced` bleibt der isolierte Zusatz.
- Wege: Geräte-Einstieg und Quellenwechsel teilen den Dienst. Quelle-Binden und
  Einstellungen lesen weiter über die stabile Komponente und ihren gültigen Einbau;
  angekündigte Bindungen am alten Einbau sperren weiterhin den Wechsel. AP-06
  `data_source_assignment` und `QuellenUebergabe` wechseln die lesende Box unabhängig
  vom Controller; Quelle/Zuständigkeit bleiben beim Tausch erhalten. Die Helfer- und
  Summenwert-Anker (`messstelle_formel_term.entity_id`, `entity_role_assignment`)
  bleiben an derselben Komponente. Kein DELETE, kein Unclaim und keine Kaskade.
- Portal: `ControllerwechselDialog` aus `GeraetHerkunft`, zwei Schritte, voreingestellte
  Kartenübernahme, Endstand je führender Bindung und vollständige Folgen-Liste vor
  einem POST. Standortzone/DST über `VpZeitpunktPicker`; Eingabestände über `zahl.ts`.
  Ein erneutes Laden nach Ablehnung erhält noch zuordenbare Eingaben.

Nachweise: `ZaehlerwechselApiTest` A6 mit vier Karten, individuellen Endständen,
Rollback und fremd 404; sieben Java-Vektorleser plus `uemsMessstelle.test.ts`,
Rechte-/Schnittstellenwächter; `controllerwechsel.test.ts`, Dialogtests, `copy.test.ts`.
Browser: `controllerwechsel.spec.ts` bei 375/1440 sowie Geräteherkunft, Zählerwechsel,
Quelle-Binden und die drei Summenwert-Specs. Aufnahme über `CONTROLLER_BILDER`.
