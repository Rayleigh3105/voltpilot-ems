# Fernwartung: Schlüsselausgabe des Tunnel-Dienstes (v1)

Eine Box fragt den Wartungsserver über den Wartungstunnel, wessen SSH-Schlüssel sich gerade bei ihr anmelden darf. Der Tunnel-Dienst antwortet mit den Schlüsseln der Techniker, für die ein Fenster zu **dieser** Box offen ist. Hintergrund: [Fernwartung](../fernwartung.md#anmeldung-an-der-box-fenster-schlüssel), Server-Seite: [Tunnel-Dienst](../../services/tunnel-dienst/README.md#schlüsselausgabe).

Vektor: [`fernwartung-schluessel-v1.example.txt`](fernwartung-schluessel-v1.example.txt). Er ist die Antwort an die Box `10.10.16.2` aus dem [Vektor des Soll-Stands](fernwartung-soll-v1.example.json) bei einer Stunde Restlaufzeit; der Test des Tunnel-Dienstes erzeugt ihn Byte für Byte (`TestVertragsvektorDerAntwort`).

## Anfrage

```
GET http://<server>:<port>/v1/schluessel?warte=<sekunden>&stand=<prüfwert>
```

| Teil | Bedeutung |
|---|---|
| `<server>` | die Server-Adresse im **Techniker-Netz**, bei den Vorgaben `10.10.32.1`. Nur sie erreicht eine Box: Ihr Tunnel führt nur das Techniker-Netz als erlaubtes Netz |
| `<port>` | `VP_TUNNEL_SCHLUESSEL_PORT` des Dienstes, im Beispiel `8022`. Ist der Wert nicht gesetzt, lauscht niemand |
| `warte` | so viele Sekunden hält der Server die Anfrage offen, solange sich die Liste nicht ändert. Fehlt der Wert oder ist er `0`, kommt die Antwort sofort. Mehr als 300 wird auf 300 gekürzt |
| `stand` | der Prüfwert der letzten Antwort. Fehlt er oder ist er leer, kommt die Antwort sofort |

- Klartext-HTTP, HTTP/1.0 oder 1.1, **eine Anfrage je Verbindung**; der Server schließt nach der Antwort. Den Schutz liefert der Tunnel: WireGuard lässt von einer Box nur ihre eigene Adresse durch, der Absender **ist** die Box. Eine Anmeldung gibt es nicht, einen Rumpf hat die Anfrage nicht.
- Die Box hält die Verbindung offen, bis die Antwort da ist. Schließt sie nach der Anfrage ihre Schreibseite, gilt sie dem Server als gegangen und bekommt keine Antwort. `uclient-fetch` und `wget` von BusyBox tun das nicht.
- Je Box ist **eine** Anfrage offen. Eine neuere löst die ältere ab; die ältere endet mit 429.

## Antwort

`200`, `text/plain`, Zeilen mit `\n`, Felder durch **ein** Leerzeichen getrennt:

```
vp-wartung-schluessel 1 <prüfwert>
schluessel <restlaufzeit> <zugang> ssh-rsa <base64>
ende <anzahl>
```

| Zeile | Regel |
|---|---|
| Kopf | genau drei Felder: das Wort, die Version `1`, der Prüfwert (16 Zeichen `0-9a-f`) |
| `schluessel` | genau fünf Felder; keine, eine oder bis zu acht Zeilen, geordnet nach `<zugang>` |
| `<restlaufzeit>` | ganze Sekunden bis zum Ende des Fensters, mindestens 1, abgerundet |
| `<zugang>` | die ID des Techniker-Zugangs aus dem Portal, `[A-Za-z0-9_-]{1,64}` |
| `ssh-rsa <base64>` | der öffentliche Schlüssel in Normalform, wie er in die Schlüsseldatei gehört: RSA 2048 bis 4096 Bit, keine Optionen, kein Kommentar |
| `ende` | die Zahl der `schluessel`-Zeilen. Fehlt die Zeile oder stimmt die Zahl nicht, ist die Antwort abgeschnitten |

Die leere Liste ist eine gültige Antwort und heißt: Für diese Box ist gerade kein Fenster mit SSH-Schlüssel offen.

```
vp-wartung-schluessel 1 99ba3c5f3272c926
ende 0
```

Der **Prüfwert** hängt nur an der Liste (welcher Zugang, welcher Schlüssel), nicht an der Restlaufzeit. Nennt die Box ihn in `stand`, bleibt die Anfrage offen, bis die Liste eine andere ist, ein Fenster abläuft oder `warte` um ist; danach kommt die dann gültige Liste mit neuer Restlaufzeit. Setzt der Dienst das Ende eines Fensters neu (verlängert oder gekürzt, um mehr als 5 s), während die Anfrage offen ist, kommt die Antwort ebenfalls sofort: mit demselben Prüfwert und der neuen Restlaufzeit.

## Andere Ergebnisse

| Ergebnis | Bedeutung für die Box |
|---|---|
| `503` | der Dienst hat seit seinem Start noch keinen gültigen Soll-Stand abgeholt, oder er kann die offenen Fenster nicht lesen. **Keine Liste, auch keine leere** |
| `429` | diese Anfrage wurde von einer neueren derselben Box abgelöst |
| `403` | der Absender ist keine Box-Adresse |
| `400`, `404`, `405` | `warte` oder `stand` haben nicht die verlangte Form; anderer Pfad; andere Methode |
| keine Verbindung, keine Antwort | Dienst oder Schlüsselausgabe laufen nicht; von einer Techniker-Adresse aus verwirft die Firewall des Servers die Pakete |

## Regeln für die Box

- **Nur eine vollständige, formgerechte Antwort `200` gilt.** Alles andere ändert den Stand der Box nicht: Es kommt nichts dazu, und was da ist, verfällt zu seiner Frist.
- **Die Antwort ist die ganze Liste.** Ein Schlüssel, den sie nicht mehr nennt, wird sofort gestrichen, ohne auf seine Frist zu warten. So verschwindet ein ersetzter oder entfernter Schlüssel und der eines vorzeitig geschlossenen Fensters.
- **Die Frist führt die Box selbst,** gemessen an ihrer Laufzeit seit dem Start und nicht an der Uhr: Laufzeit beim Empfang plus `<restlaufzeit>`. Der Server kann einen Schlüssel nicht zurückholen, wenn die Box ihn nicht mehr fragt.
- Die Box fragt wieder, bevor eine Frist abläuft, und übernimmt aus **jeder** gültigen Antwort die Restlaufzeit, auch wenn der Prüfwert gleich geblieben ist: Sie kann länger oder kürzer geworden sein.
- Die Box prüft jede Zeile selbst, auch den Schlüssel (`ssh-rsa`, Länge, Zeichen), und kappt eine Restlaufzeit über ihrem eigenen Höchstwert.
