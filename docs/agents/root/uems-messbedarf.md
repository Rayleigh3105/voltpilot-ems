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

Ort und Größe sind Wortlaut (`ort`, `groesse`) und optional Struktur
(`V20260923234500`): `standort_id` ODER `ort_id` (Gebäude/Bereich, höchstens einer, FK mit
Mandant) und `messgroesse`/`richtung`, geprüft gegen `MessstelleRegeln.GROESSEN_KATALOG`.
Die API nimmt beides als eine `ort_id`; fehlt der Wortlaut, leitet `MessbedarfService` ihn
aus der Struktur ab — Bericht (`BerichtUnternehmen`) und `BewertungMessbedarfNaht` lesen
weiter nur den Wortlaut. `ort_ziel.standort_*` löst `MessbedarfRepository.standorteDerOrte`
zum heutigen Tag auf. `GET /api/v1/unternehmen/messbedarf?standort=`
(`MessbedarfUebersichtController`) filtert je Bedarf über den Einsatz-Zaun; ⚠ ein Bedarf nur
mit Ort-Wortlaut steht an keinem Standort — das Portal ordnet ihn wie bisher über die Ortsbäume zu. Ein Ort mit Bedarf
lässt sich nicht löschen (FK → 409 `loeschen_gesperrt` in `OrtService.loeschen`).

`MessstelleRegisterService` ergänzt eingelöste Bedarfe als
`geplant_fuer_einsaetze` und bietet `geplantFuerEinsatz=true`. Der Eintrag ersetzt weder
Quellenzustand noch letzten Wert: ohne Quelle bleibt die Beobachtung
`keine_datenquelle` mit `letzter_wert: null`. `BewertungMessbedarfNaht` gibt nur offene
Bedarfe als `geplant` an die Messabdeckung; dort haben sie nie eine Menge.

Portal (`uemsMessplanung.ts`, `components/Messplanung.tsx`): Erfassen/Bearbeiten schreiben
Struktur und Wortlaut, Bearbeiten behält einen unerkannten alten Wortlaut, „Protokoll“ liest
`…/protokoll`, die Liste je Standort liest die Übersichtsroute einmal; der Register-Schalter
„Nur geplant für einen Energieeinsatz“ (`messstellen.ts`, `MessstellenPage.tsx`) erscheint nur,
wenn eine Messstelle einen Bedarf einlöst.

Verbindlicher Vertrag: [`docs/contracts/v2/bewertung.md`](../../contracts/v2/bewertung.md),
Abschnitt 4.1. Die API-Abnahme liegt in `MessbedarfApiTest`; Ranglisten- und
Messabdeckungsbestand sowie der Belegschutz beim Bearbeiten bleiben in
`BewertungRanglisteApiTest` belegt.
