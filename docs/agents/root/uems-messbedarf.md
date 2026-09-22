# Messbedarf (AP-16 IP-19)

Die Routen unter
`/api/v1/unternehmen/energieeinsaetze/{id}/messbedarf` erfassen und lesen Messbedarfe,
ändern offene Einträge, lösen sie mit einer eingerichteten Messstelle ein oder verwerfen
sie mit Pflichtbegründung. Lesen verwendet den Energieeinsatz-Zaun; Schreiben das
vorhandene Recht `energieeinsatz.verwalten`. Ein unbekannter Mandant oder ein Ziel
außerhalb des Zauns bleibt eine 404, eine nicht eingerichtete Messstelle ist 422.

`MessbedarfService` hält Zustandswechsel, append-only Protokoll und die Ereignisse
`messbedarf_erfasst`/`messbedarf_eingeloest` in einer Transaktion. Die Tabellen
`messbedarf`, `messbedarf_aenderung` und `messbedarf_kennzeichen_seq` haben erzwungene
RLS; Offboarding löscht sie vor Energieeinsatz und Messstelle. Die Laufzeitrolle darf
nicht löschen.

`MessstelleRegisterService` ergänzt eingelöste Bedarfe als
`geplant_fuer_einsaetze` und bietet `geplantFuerEinsatz=true`. Der Eintrag ersetzt weder
Quellenzustand noch letzten Wert: ohne Quelle bleibt die Beobachtung
`keine_datenquelle` mit `letzter_wert: null`. `BewertungMessbedarfNaht` gibt nur offene
Bedarfe als `geplant` an die Messabdeckung; dort haben sie nie eine Menge.

Verbindlicher Vertrag: [`docs/contracts/v2/bewertung.md`](../../contracts/v2/bewertung.md),
Abschnitt 4.1. Die API-Abnahme liegt in `MessbedarfApiTest`; Ranglisten- und
Messabdeckungsbestand bleibt in `BewertungRanglisteApiTest` belegt.
