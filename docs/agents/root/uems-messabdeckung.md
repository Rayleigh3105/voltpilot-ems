# Messabdeckung (AP-16 IP-13)

`GET /api/v1/unternehmen/bewertung/messabdeckung?von=&bis=` liest dieselben ganzen
Kalendermonate, denselben Betrachtungsumfang und denselben Standort-Zaun wie die
Rangliste. `BewertungMessabdeckungService` ruft deshalb `BewertungRanglisteService`
auf; `BewertungMessabdeckungLeser` projiziert deren Nenner, Messstellenmengen,
Ersatzanteile und Anlagenreste nur in die vier P3-Spalten.

- `gemessen`: direkte, nicht archivierte Messstellen mit einer gelesenen Menge.
  Berechnete Messstellen und Verteilungen kommen bereits im IP-9-Leser nicht hinein.
- `geplant`: gemessene Messstelle ohne überlappende führende Datenquelle; die Menge
  fehlt (`null`) und wird nie als 0 ausgegeben.
- `ersatz`: nachgewiesener Ersatzanteil der gemessenen Menge, nicht zusätzlich addiert.
- `ungemessen`: ausschließlich der IP-9-Anlagenrest. Ohne eindeutige Anlagenstellung
  wird keine Zuordnung zu einem Einsatz geraten.

Eine Strom-Messstelle ohne Anlagenstellung verschwindet nicht aus der Ortssicht: sie
steht unter ihrem Gebäude/Standort als eigene Ortszeile. Ihr wird aber kein Anlagenrest
zugeschlagen; diese Verbindung liefert erst die IP-19-Naht als belegten Messbedarf.

`BewertungMessbedarfNaht` liefert bis IP-19 eine leere Liste. IP-19 hängt dort offene
Bedarfe mit Einsatz und optional eindeutiger Anlage ein; dadurch bleibt dieses Paket
ohne vorweggenommene Datenhaltung. K8 kommt aus der wirksamen Kriterien-Fassung und
wird über die vorhandene reine P3-Regel mit ungerundeten Mengen beurteilt.

Verbindliche Abnahme: [`messabdeckung.json`](../../contracts/v2/messabdeckung.json).
Alle drei NW-1-Zwillinge lesen sie zusätzlich zu `bewertung-vectors.json`.
`BewertungRanglisteApiTest` belegt Ahrenberg, Teilansicht und W8;
`BewertungMessabdeckungSchnittstelleVertragTest` hält DTO und OpenAPI zusammen.
