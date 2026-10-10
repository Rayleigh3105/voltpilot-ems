# Fernwartung: Rückmeldung des Tunnel-Dienstes ans Portal (v1)

Der Tunnel-Dienst meldet dem Portal, was er auf dem Wartungsserver sieht: je Box „verbunden seit“ und „zuletzt gefragt um“, je Fenster „Schlüssel abgeholt um“. Das Portal zeigt es an Box und Fenster. Hintergrund: [Fernwartung](../fernwartung.md#rückmeldung-des-tunnel-dienstes), Seite des Dienstes: [Tunnel-Dienst](../../services/tunnel-dienst/README.md#rückmeldung-ans-portal).

**Die Rückmeldung ist Anzeige.** Sie fließt nie in den [Soll-Stand](fernwartung-soll-v1.example.json) zurück, aus dem der Dienst Peers, Fenster und Schlüsselausgabe ableitet. Die API hält sie in eigenen Tabellen und liest sie nur für die Routen des Portals.

Vektor: [`fernwartung-rueckmeldung-v1.example.json`](fernwartung-rueckmeldung-v1.example.json). Er ist die Meldung zum [Vektor des Soll-Stands](fernwartung-soll-v1.example.json). Der Test des Tunnel-Dienstes erzeugt ihn Byte für Byte (`TestVertragsvektorDerMeldung`), der Test der API liest ihn streng und nimmt ihn an (`FernwartungRueckmeldungRegelnTest`). Vertrag, Vektor, `meldung.Bericht` (Go) und `FernwartungRueckmeldung.Meldung` (Java) ändern sich nur gemeinsam.

## Anfrage

```
PUT /api/v1/fernwartung/rueckmeldung
Authorization: Bearer <Token des Dienstkontos, Rolle tunnel-dienst>
Content-Type: application/json
```

| Feld | Bedeutung |
|---|---|
| `version` | `1` |
| `gemeldetUm` | die Uhr des Wartungsservers, als die Meldung entstand |
| `gestartetUm` | seit wann dieser Lauf des Dienstes läuft. Was er meldet, weiß er erst seit diesem Zeitpunkt |
| `schluesselausgabe` | `true`, wenn die [Schlüsselausgabe](fernwartung-schluessel-v1.md) eingeschaltet ist und lauscht |
| `boxen[]` | jede Box aus dem letzten frisch abgeholten Soll-Stand, höchstens 10 000 |
| `boxen[].id` | die `id` des Box-Peers aus dem Soll-Stand |
| `boxen[].verbundenSeit` | seit wann der Dienst die Box ohne Unterbrechung verbunden sieht; `null`: nicht verbunden |
| `boxen[].zuletztGefragtUm` | Beginn der letzten Anfrage dieser Box an die Schlüsselausgabe; `null`: seit `gestartetUm` keine |
| `fenster[]` | jedes Fenster aus dem Soll-Stand, das gerade in der Kernel-Menge `fenster` steht, höchstens 10 000 |
| `fenster[].id` | die `id` des Fensters aus dem Soll-Stand |
| `fenster[].schluesselAbgeholtUm` | wann die Box den Schlüssel dieses Fensters abgeholt hat; `null`: seit `gestartetUm` nicht |

- Zeitangaben sind RFC 3339 in UTC auf ganze Sekunden. Jedes Feld steht immer da; `null` ist eine Aussage, kein fehlender Wert.
- **Sonst steht nichts in der Meldung:** kein Schlüssel, kein Fingerabdruck, keine Adresse, kein Name. Box und Fenster sind nur über die `id` benannt, die das Portal selbst vergeben hat.
- **Die Meldung ist der ganze Stand des Dienstes.** Eine Box oder ein Fenster, das sie nicht nennt, kennt der Dienst gerade nicht.

### Was die Angaben heißen

| Angabe | Woran der Dienst sie festmacht |
|---|---|
| verbunden | der letzte WireGuard-Handshake der Box ist höchstens 3 Minuten alt. Eine Box mit Tunnel erneuert ihn alle 2 Minuten; eine Unterbrechung unter 3 Minuten sieht der Dienst nicht |
| `verbundenSeit` gleich `gestartetUm` | die Box war schon verbunden, als der Dienst startete: **mindestens** seit dann |
| `verbundenSeit` später | der Handshake, mit dem die Box (wieder) verbunden war |
| `zuletztGefragtUm` | die Box hat `/v1/schluessel` aufgerufen. Das tut nur eine Box, deren Tunnel mit `service-tunnel.sh` ab den Fenster-Schlüsseln eingerichtet ist |
| `schluesselAbgeholtUm` | die Box hat in einer **späteren** Anfrage den Prüfwert der Liste genannt, die den Schlüssel dieses Fensters enthält. Den Prüfwert nennt sie erst, nachdem sie die Liste geprüft und in ihre Schlüsseldatei geschrieben hat. Die erste solche Anfrage seit `gestartetUm` zählt |

Ein Fenster ohne SSH-Schlüssel am Techniker-Zugang steht mit `schluesselAbgeholtUm: null` in der Meldung: Es gibt nichts abzuholen. Ob der Zugang einen Schlüssel trägt, weiß das Portal selbst.

## Antwort

| Ergebnis | Bedeutung |
|---|---|
| `204` | angenommen und gespeichert |
| `400` | die Meldung hat nicht die verlangte Form: kein JSON, unbekanntes Feld, andere `version`, eine `id` ist keine UUID oder steht doppelt, zu viele Einträge, eine Zeitangabe liegt nach `gemeldetUm`, oder `gemeldetUm` weicht um mehr als 5 Minuten von der Uhr der API ab |
| `413` | die Meldung ist größer als 2 MiB |
| `422` | die Meldung nennt eine Box oder ein Fenster, das die API nicht kennt. **Nichts aus dieser Meldung wird gespeichert** |
| `401`, `403` | kein Token oder nicht die Rolle `tunnel-dienst`. Kunden-, Publisher- und Admin-Token bekommen 403 |
| `404`, `405` | diese API kennt die Rückmeldung noch nicht (älterer Stand) |

Fehler tragen `{"message": "…"}`.

## Regeln

- **Die API misst das Alter selbst.** Sie hält zu jeder Box und jedem Fenster fest, wann sie die Meldung angenommen hat, nach ihrer eigenen Uhr. Das Portal zeigt dieses Alter und behandelt eine Angabe, die älter als 3 Minuten ist, als unbekannt.
- **Unbekannt ist kein „nicht verbunden“.** Fehlt die Meldung, ist sie alt oder nennt sie die Box nicht, sagt das Portal genau das.
- **Der Dienst meldet nach jedem Lauf,** also im Abstand seines Abrufintervalls (30 s), in einem eigenen Aufruf mit 5 s Frist. Scheitert der Aufruf, ändert das nichts an Soll-Stand, Firewall und Schlüsselausgabe; der Dienst versucht es in wachsendem Abstand wieder, höchstens alle 10 Minuten.
- **Beide Seiten vertragen die jeweils ältere andere.** Ein Dienst mit Rückmeldung an einer API ohne diese Route bekommt 404 und fragt alle 10 Minuten wieder nach. Eine API mit dieser Route und ein Dienst ohne Rückmeldung: Es kommt keine Meldung, das Portal zeigt „keine Meldung“.
- **Gespeichert wird nur der letzte Stand** je Box, je Fenster und je Dienstkonto. Ein Verlauf entsteht nicht; das Protokoll der Fernwartung bleibt davon unberührt.
