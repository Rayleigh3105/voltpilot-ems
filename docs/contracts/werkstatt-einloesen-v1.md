# Werkstatt: Einlösen des Einmal-Codes durch die Box (v1)

Eine frisch eingerichtete Box löst in der Werkstatt einen Einmal-Code ein. Damit hält die API ihren Geräteschlüssel fest (D2), hinterlegt ihren Tunnel-Schlüssel und öffnet das Probe-Fenster für den Techniker-Zugang des Werkstatt-Dienstes. Hintergrund: [Werkstatt](../werkstatt.md), [Werkstatt-Dienst](../../services/werkstatt-dienst/README.md). API-Seite: `services/api/…/werkstatt/EinloesenVertrag.java` und `EinloesungService.java`. Box-Seite: der Befehl `werkstatt-anmelden` im Go-Core (`edge-app/core/internal/werkstatt`, in `vp-edge-core` und `vp-edge-light` über den gemeinsamen Programmrahmen). Beide lesen die [Vektoren](werkstatt-einloesen-vectors.json); kanonischer Text, Formen und Vektoren ändern sich nur gemeinsam.

## Ablauf

1. Der Werkstatt-Dienst holt für genau diese Box einen Code: `POST /api/v1/werkstatt-dienst/codes` mit `{"edgeRef": "edge-…"}` (nur Rolle `werkstatt-dienst`). Es gibt ihn nur in einer laufenden Freigabe, für eine erzeugte Kennung mit gültigem Prüfzeichen, die nicht gekoppelt ist und noch kein Zertifikat hat. Er gilt 30 Minuten und einmal; die API speichert nur seinen sha256. Ein neuer Code ersetzt den offenen.
2. Der Dienst reicht ihn über die SSH-Standardeingabe an die Box weiter. Der Code steht weder im Log noch in einem Beleg.
3. Die Box schickt `POST /api/v1/werkstatt/einloesen` (ohne Konto, Rate-Limit je Absender und gesamt).

## Der Befehl auf der Box

```
printf '%s\n' "$CODE" | vp-edge-light werkstatt-anmelden --wireguard <öffentlicher WireGuard-Schlüssel> \
    --host-schluessel SHA256:… [--daten <Datenverzeichnis>] [--portal <Portal-Adresse>] [--zeit 30s]
```

- Der Code kommt als erste Zeile über die **Standardeingabe**, nie als Argument (er stünde sonst in der Prozessliste). Er steht in keiner Ausgabe.
- Kennung (`<daten>/ref`) und Geräteschlüssel (`<daten>/identity/device.key`) legt der erste Start an; der Befehl liest sie nur und erzeugt nie etwas. Fehlt eines, endet er mit 2. Nur eine erzeugte Kennung mit gültigem Prüfzeichen kann einlösen.
- Die Fassung ist die des laufenden Programms (dieselbe, die `/health` meldet). Die Zertifikatsanfrage baut der Befehl neu aus dem Geräteschlüssel.
- Tunnel- und Host-Schlüssel nennt der Aufrufer: der Werkstatt-Dienst, der sie selbst von der Box gelesen hat.
- `--daten` und `--portal` ersetzen `VP_DATA_DIR` und `VP_PORTAL_BASE_URL`; ohne sie gilt die Konfiguration der Box. Auf Edge Light stehen beide in UCI (`vp-edge-light.main.data_dir`, `…portal_url`).
- stdout: bei Erfolg die Antwort des Portals als JSON, sonst nichts. Rückgabe `0` eingelöst, `2` Aufruf oder auf der Box fehlt etwas, `3` vom Portal abgelehnt (4xx, Grund und gegebenenfalls `schluessel_festgehalten` auf stderr), `4` Portal nicht erreicht oder 5xx.

## Anfrage

JSON, alle Felder Pflicht:

| Feld | Form |
|---|---|
| `edgeRef` | die Kennung der Box, `edge-` und sechs Zeichen und ein Prüfzeichen ([Vektoren](edge-ref-vectors.json)), genau wie die Box sie führt |
| `code` | `wk-` und 26 Zeichen aus `a-z2-7` (128 Bit, Base32 klein ohne Auffüllung) |
| `fassung` | die Fassung des laufenden Programms, etwa `edge-light-2026.11.0`; muss die Fassung der Freigabe sein |
| `geraeteSchluessel` | der öffentliche Geräteschlüssel, EC P-256, als SubjectPublicKeyInfo (DER), Base64 |
| `wireguardSchluessel` | der öffentliche Tunnel-Schlüssel, 44 Zeichen Base64 |
| `hostSchluessel` | Fingerabdruck des SSH-Host-Schlüssels, `SHA256:` und 43 Zeichen |
| `csrPem` | die Zertifikatsanfrage der Box (PEM, höchstens 20 480 Zeichen), mit **demselben** Schlüssel wie `geraeteSchluessel` |
| `signatur` | ECDSA P-256 mit SHA-256 über den kanonischen Text, ASN.1 DER, Base64 |

Kein Feld darf einen Zeilenumbruch tragen.

### Kanonischer Text

Zeilen `name=wert`, jede mit `\n` abgeschlossen, genau in dieser Reihenfolge, UTF-8:

```
vp-werkstatt-einloesen.v1
edge_ref=<edgeRef>
code=<code>
fassung=<fassung>
geraete_schluessel=<geraeteSchluessel>
wireguard_schluessel=<wireguardSchluessel>
host_schluessel=<hostSchluessel>
csr_sha256=<sha256 der Bytes von csrPem, hex klein>
```

Signiert wird mit dem Geräteschlüssel, der auch die Zertifikatsanfrage trägt. So beweist die Box, dass sie den Schlüssel besitzt, und bindet Code, Tunnel-Schlüssel und Host-Schlüssel an ihn.

## Antwort

`200`, `Cache-Control: no-store`, nichts davon ist geheim:

```json
{
  "schema": "vp-werkstatt-einloesung.v1",
  "edgeRef": "edge-k7m2xq3",
  "freigabe": "2026-11-mango-1",
  "tunnelErgebnis": "angelegt",
  "tunnel": {"adresse": "10.10.16.2", "boxNetz": "10.10.16.0/20", "technikerNetz": "10.10.32.0/24",
             "serverEndpunkt": "wartung.voltpilot.de", "serverPort": 51820, "serverPublicKey": "…", "serverAdresse": "10.10.16.1"},
  "probe": {"fensterId": "…", "technikerId": "…", "technikerName": "Werkstatt-Dienst", "beginn": "…", "ende": "…"},
  "geraeteSchluessel": {"sha256": "…", "festgehaltenAm": "…"}
}
```

`tunnelErgebnis` ist `angelegt`, `unveraendert` (derselbe Schlüssel schon hinterlegt) oder `getauscht`.

| Status | Bedeutung |
|---|---|
| `400` | eine Form stimmt nicht, mit Grund; oder die Zertifikatsanfrage ist ungültig |
| `403` `{"message": "Der Code gilt nicht."}` | **dieselbe Antwort** für einen unbekannten, abgelaufenen, ersetzten oder fremden Code, für eine beendete Freigabe und für eine falsche Signatur |
| `409` | Code schon eingelöst; Fassung passt nicht zur Freigabe; Box schon gekoppelt oder mit Zertifikat; Obergrenze der Freigabe erreicht; Tunnel-Schlüssel anders ohne Tausch; `{"code": "schluessel_festgehalten"}` ein anderer Geräteschlüssel ist festgehalten |
| `422` | die Zertifikatsanfrage trägt einen anderen Schlüssel als `geraeteSchluessel` |
| `429` | zu viele Anfragen |

## D2: der festgehaltene Geräteschlüssel

- Nach dem Einlösen nimmt `POST /api/v1/enrollment/{ref}/csr` nur noch eine Anfrage mit genau diesem Schlüssel an. Jede andere bekommt `409` mit `"code": "schluessel_festgehalten"`; die Box wertet 409 wie bisher als „warten“.
- Ausgestellt (und ausgeliefert) wird nur ein Zertifikat für eine Anfrage mit diesem Schlüssel.
- Die Zertifikatsanfrage aus der Einlösung ersetzt eine fremde, die vorher gespeichert wurde.
- Ein anderer Schlüssel ersetzt den festgehaltenen nur mit einem Code, den der Dienst ausdrücklich als Tausch geholt hat (`{"edgeRef": …, "tausch": true}`), und nur, solange die Box ungekoppelt ist.
- Boxen ohne Festhaltung verhalten sich wie bisher.
- Auf dem CSR-Weg prüft die API außerdem das Prüfzeichen einer erzeugten Kennung (422 bei falschem); Sticker-Kennungen (`VP-`) gehen weiter über das Register.

## Vektoren

[`werkstatt-einloesen-vectors.json`](werkstatt-einloesen-vectors.json): ein Test-Geräteschlüssel (nur für Tests erzeugt, PKCS#8), eine vollständige Anfrage mit gültiger Signatur (aus Python), ihr kanonischer Text, `csr_sha256` und `geraete_schluessel_sha256`, dazu `signatur_go`: derselbe Text, vom Go-Core signiert. Java prüft beide Signaturen, Go die aus Python; so ist belegt, dass die API annimmt, was die Box signiert. Dazu Änderungen eines Feldes, nach denen die Signatur nicht mehr gilt (`signatur_ungueltig`), und Formfehler (`formfehler`). ECDSA ist nicht deterministisch: Ein Leser prüft die Signatur des Vektors und, wenn er selbst signiert, dass die API seine Signatur annimmt; Byte-gleich ist nur der kanonische Text.
