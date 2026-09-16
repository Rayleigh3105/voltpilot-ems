# Zählerwechsel im Portal (AP-04 IP-18)

`components/ZaehlerwechselDialog.tsx` öffnet als Modal aus `QuelleKarte` auf der
Messstellen-Seite und aus `GeraetHerkunft` auf der Geräte-/Komponentenseite. Reine Eingabe-
und Satzfunktionen: `zaehlerwechsel.ts`. Zwei Einstiege, genau ein POST an die vorhandene
Wechsel- bzw. Austauschroute; keine zusätzlichen Einstellungs-Schreibaufrufe.

- Gerätekennung, physischer Einbau und Verbindung bleiben getrennt. Die Seriennummer des
  Vorgängers wird nie übernommen. Energiekarten/Controller sind dem Folgepaket vorbehalten.
- Die Zone stammt aus dem Standort der Anlage; ohne Zuordnung steht die Vorgabe ausdrücklich
  im Kopf. `VpDatePicker`/`VpTimePicker` liefern eine Minute; doppelte und fehlende Ortszeiten
  werden abgewiesen. Rückwirkung nutzt den bestehenden Vertragszwilling und verlangt das
  Zusatzrecht aus `rollen.ts`; der Geräteweg prüft auch `geraet.einrichten`.
- Ablesestände sind optional. Nur genau eine führende Zählerstand-Bindung mit bekannter Einheit
  öffnet die beiden Felder. Mehrere Zählwerke brauchen den erweiterten Auftrag des Folgepakets.
  `ablesestandWert` kapselt ausschließlich die deutsche Gruppierung vor `anlageFlow.parseDecimal`;
  sie ist der Übergabepunkt an AP-09 IP-10 (`zahl.ts`), geprüft mit `1.234,5` → `1234.5`.
- Nach 201 werden Quelle/Register/Protokoll und Werte neu gelesen. „Wartet auf erste Daten“
  kommt aus dem Register; der Dialog erfindet weder Datenlücke noch Datenempfang.
- `ZaehlerwechselVerlauf` liest beim Öffnen den vorhandenen Pfad
  `/sites/{siteId}/components/{entityId}/events`. Nur gespeicherte `device_replaced` mit beiden
  Einbauten werden über `uemsEreignis.ereignisSatz` gesprochen. Quellenbindungen allein sind
  kein Beweis für einen Zählerwechsel. Derselbe Leser sitzt an Messstelle und Gerät.

## Benannte Grenzen der bestehenden Route

Die Route hat keine Nur-Lese-Vorschau, keine neuen Einstellungswerte und keine Liste betroffener
Berichte. Schritt 2 prüft daher die eingegebenen Angaben und die unveränderlichen Zusagen des
Wechselvertrags. Die **bestätigte** Folgen-Karte danach liest ausschließlich die 201-Antwort
(einschließlich Endstand, Rückwirkung und tatsächlich geschriebener Marken). Einstellungen
können übernommen oder weggelassen werden; neue Werte gehören anschließend an den bestehenden
Einstellungsdialog. Das OpenAPI-Enum `ComponentChangeEvent.eventType` nennt `device_replaced`
noch nicht, obwohl IP-17 diese Art bereits speichert und der bestehende Lesepfad sie liefert.
Kein vorgezogener Schreibaufruf simuliert eine Vorschau.

Nachweise: `zaehlerwechsel.test.ts`, `components/ZaehlerwechselDialog.test.tsx`,
`e2e/zaehlerwechsel.spec.ts` (beide Einstiege, Z1→Z3, 375/1440, Escape/Fokus, Bilder mit
`ZAEHLER_BILDER`), vorhandene Quelle-/Messstellen-/Geräte- und Weg-Specs. Der Q5-Wächter
`uemsKeineRechnung.test.ts` erfasst auch `zaehlerwechsel.ts`; erlaubte Zahlenoperationen
prüfen nur die Geräte-ID. Keine API-, Datenbank- oder Edge-Änderung.
