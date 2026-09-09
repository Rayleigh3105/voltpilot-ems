# Der HTTP/JSON-Lesetyp (P5-HTTP): `vp.http.read` neben `vp.mqtt.read`

Angelegt am 09.09.2026. Konzept: `data/vp-deye-diybms-luecke-l5/report.md` §3.2b „Ebene 1,
HTTP/JSON". Die MQTT-Hälfte und die volle Begründung des Bausatzes stehen in
`der-generische-batterie-anschluss-p5-ebe.md` — **hier steht nur, was ANDERS ist.**

## Warum es das gibt

„Ich habe ein BMS mit Web-Oberfläche" war die zweithäufigste Ausgangslage nach dem MQTT-Fall,
und die Anschlussart stand im Assistenten schon SICHTBAR und gesperrt da. Der Vorlagen-Fall ist
DIYBMS v4: `GET http://<controller>/ha` mit dem Kopfzeilen-Schlüssel `ApiKey` liefert ein
flaches Dokument (`soc`, `v`, `c`, `pwr`, `lowcellv`, `highcellv`, …).

**Es ist ein zweiter LESETYP, kein zweiter Bausatz.** Alles hinter der Feld-Zuordnung ist
unverändert dasselbe: dieselben Standard-Kanäle, dieselben Aggregate, dieselbe SoC-Ableitung
(P5b), dieselbe Speiser-Bindung (P6), derselbe Entitätstyp `user-defined-battery`, dieselben
Routen `/api/v1/sites/{id}/components/battery[/{entityId}]`.

## Was neu ist

| Stück | Wo |
|---|---|
| Katalogtyp `vp.http.read` | `services/api/src/main/resources/flowcatalog/catalog.json` + `frontend/portal/src/flows/catalog.json` (byte-gleich) + `edge-app/nodered/flowc/catalog.js` |
| Der ausführende Knoten | `edge-app/nodered/vp-palette/nodes/vp-http-read.js` (+ `lib/http-mapping.js`), Palette **0.12.0** |
| Transport / `communication` | `http_local` (`UserDefinedBatteryDefinition.COMMUNICATION_HTTP`, Go-Zwilling `componentapply.CommunicationHTTPLocal`) |
| Herkunfts-Art des Flows | `http-device` (`docs/contracts/v2/flow-graph.schema.json`) |
| Vertrags-Beispiel | `docs/contracts/v2/examples/flow-graph.valid.http-battery.json` |
| Die Portal-Vorlage | `HTTP_VORLAGEN` in `frontend/portal/src/batterieAnschluss.ts` (`diybms-v4-ha`) |

## Die vier Unterschiede zum MQTT-Lesetyp — und ihre Gründe

- **Der Wertepfad ersetzt den Topic-Filter, und er trägt einen PLATZHALTER.** MQTT wird nicht
  abgefragt, es kommt an — viele Nachrichten, je eine Quelle. HTTP ist EINE Antwort mit EINEM
  Dokument, und das Aggregat lebt darin: `cells.*.v` trifft jede Zelle der Liste, so wie
  `emon/diybms/+/+` jedes Zell-Topic trifft. **Ohne den Platzhalter wäre `min`/`max` an einem
  HTTP-Anschluss ein Feld ohne Bedeutung.** `*` steht immer für ein GANZES Segment (Liste oder
  Objekt); `__proto__` & Co. sind wie überall verboten.
- **Der Wertepfad ist PFLICHT.** Beim MQTT-Lesetyp heißt ein leerer Pfad „die Nachricht IST der
  Wert" (der häufigste MQTT-Fall: ein Topic, eine nackte Zahl). Eine HTTP-Antwort ist ein
  Dokument — ein leerer Pfad wäre die Aufforderung, es als Zahl zu lesen.
- **Es gibt KEIN `stale_s`.** Eine Antwort ist EIN Zeitpunkt. Was sie nicht enthält, fehlt; eine
  vorige Antwort wird nie noch einmal veröffentlicht, denn sie wäre ein Messwert von damals mit
  dem Zeitstempel von jetzt. Ein Fehlschlag veröffentlicht deshalb GAR NICHTS. Der Compiler
  lehnt ein mitgeschicktes `stale_s` benannt ab, statt es still zu verwerfen.
- **EIN Flug je HOST.** Trifft der Takt auf eine noch laufende Abfrage, wird er ÜBERSPRUNGEN.
  Ein BMS mit einem einzigen Web-Server hält keine Warteschlange aus, und zwei überlappende
  Abfragen hätten aus einem langsamen Gerät ein unerreichbares gemacht. Die Sperre liegt auf
  Modul-Ebene, weil zwei Anschlüsse auf demselben Host dasselbe Gerät sind.

## ⚠ Das GEHEIMNIS reist NIE im Flow-Dokument

Der HTTP-Lesetyp ist der erste Anschluss dieses Bausatzes mit Zugangsdaten (Kopfzeilen-
Schlüssel / Bearer / Basic). Sein Weg ist ausdrücklich festgelegt:

- **Gespeichert** wird er in `connection_json` unter dem OBERSTEN Schlüssel `auth_secret`
  (`UserDefinedBatteryDefinition.SECRET_FIELD`). Der Name ist load-bearing:
  `ComponentSecrets.isSecretKey` greift genau daran, also maskiert ihn JEDE Auflistung — auch
  ohne eine Vorlage, aus der Geheimnis-Schlüssel sonst kämen. Ein verschachteltes
  `auth.secret` wäre der Maske entgangen.
- **Zum Portal** reist nur die Maske. Ein Speichern, das die Maske oder gar nichts schickt,
  BEHÄLT den gespeicherten Wert (`UserDefinedBatteryService.auth`) — dieselbe Disziplin wie
  beim Katalog-Gerät. Dasselbe gilt für die Vorschau (`?entityId=`), damit sie exakt das tut,
  was das Speichern täte.
- **Zur Box** reist er im Registry-Push (`driver.connection.auth_secret`) — der Kanal, über den
  jedes andere Gerätekennwort dieser Box auch kommt. Der `vp-http-read`-Knoten liest ihn aus der
  per-Gerät ausgerollten Entitäts-Konfiguration `edge/entities/{id}/config`.
- **Im FLOW-Dokument steht er nie**, und der Grund ist konkret: das Dokument ist über
  `GET /sites/{siteId}/flows/{flowId}/versions/{v}` für JEDEN Portal-Benutzer des Mandanten
  lesbar. Ein Kennwort darin wäre ein Kennwort im Browser. Der Flow trägt nur die Anmelde-ART,
  bei `header` den Namen der Kopfzeile und bei `basic` den Benutzernamen; ein `secret` im
  Dokument wird von flowc BENANNT abgelehnt, nie still verworfen.

Ohne Schlüssel fragt die Box gar nicht erst ab (Status „Zugangsdaten fehlen") — ein 401 wäre
ein Fehler, den niemand verschuldet hat. Deshalb lehnt auch die api eine Anmeldung ohne
Schlüssel beim Anlegen benannt ab, statt eine Batterie zu speichern, die schweigt.

## ⚠ Zwei Herkunfts-Arten, ein Ableiter

`vp.http.read` hat eine EIGENE `origin.kind` (`http-device`), obwohl es dieselbe Batterie und
derselbe Assistent ist: ein Ebene-1-Lesetyp, der unter der Herkunft seines Geschwisters gälte,
ließe ein gefälschtes `mqtt-device`-Dokument eine HTTP-Abfrage aufsperren.

`vp.soc.derive` gehört dagegen BEIDEN. Dafür nimmt `generated_origin` seit diesem Paket eine
LISTE (`["mqtt-device","http-device"]`) — im flowc-Katalog wie im api-Flow-Katalog, und beide
Prüfer normalisieren Wort-oder-Liste. Der Ableiter rechnet auf den Standard-Kanälen und kennt
den Transport gar nicht; genau das ist der Sinn der Zwei-Ebenen-Trennung.

## ⚠ Rollout-Reihenfolge (wie bei `mqtt_local`)

Eine Box ohne `componentapply.CommunicationHTTPLocal` lehnt den Treiber einer solchen
Komponente ab („nennt keine Marke"), und `Derive` ist alles-oder-nichts — die Anlage verlöre
die Anwendung ihres Wechselrichters und aller Quellen. **Das Edge-Release muss eine Anlage
erreichen, BEVOR dort die erste HTTP-Batterie angelegt wird.**

## Der Stand der Live-Vorschau

Die Cloud-Hälfte ist da: `POST /components/battery/preview` schickt den geprüften
`connection`-Block über den Probe-Kanal, beim HTTP-Lesetyp OHNE `listen_s` (die Box ruft
einmal ab, sie lauscht nicht). Die BOX-Hälfte des Probe-Kanals ist für beide Lesetypen
gleichermaßen offen — eine ältere Box antwortet `not_supported`, und das Portal sagt genau das
(„kann diese Auskunft noch nicht abrufen"), nie „es kam nichts an".

## Tests

```bash
(cd edge-app/nodered/vp-palette && npx mocha test/http_read_spec.js --timeout 15000 --exit)
(cd edge-app/nodered/flowc && node --test compile.test.js)
(cd edge-app/core && go test ./internal/componentapply/...)
(cd services/api && ./mvnw test -Dtest='UserDefinedBattery*Test')
(cd frontend/portal && npx vitest run src/batterieAnschluss.test.ts src/components/BatterieAssistent.test.tsx)
```
