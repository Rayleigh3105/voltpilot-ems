# UEMS-Rechte an den Schreibrouten: `@Recht`, `RechtInterceptor`, `RechtPruefung` (AP-03 IP-6)

Neu angelegt am 15.09.2026. Spezifikation: AP-03 §6.2 Punkt 5, §4.9 („Schreibpfade tragen ein Recht"), W2, §8 IP-6.
Code: `zugriff/Recht`, `zugriff/RechtZiel`, `zugriff/RechtInterceptor` (über `zugriff/RechtKonfiguration` an
`/api/v1/**` ohne `/api/v1/admin/**`), `zugriff/RechtPruefung`, `zugriff/RechtFehlt` + `RechtFehltAntwort`. Beweis:
`RechtRoutenArchitekturTest` (rein), `RechtAufruferTest` (rein), `RechtMatrixApiTest` (Testcontainers).

## Was gilt

- **Jede Kunden-Schreibroute** (POST, PUT, PATCH, DELETE unter `/api/v1/`, nicht `/api/v1/admin/**`) trägt `@Recht`
  direkt UNTER der Mapping-Zeile oder steht mit Grund in `RechtRoutenArchitekturTest.OHNE_RECHT`. Seit AP-03 IP-7
  (`uems-rechte-steuerung.md`) sind es 163 Routen mit `@Recht`; in der Liste stehen nur noch die zwei öffentlichen
  (Registrierung, Enrollment). Beide Listen sind genau.
- **`@Recht(value, ziel, variable)`**: die Kennung aus `rechte-matrix.json` (zur Laufzeit `RechteMatrixDatei`) und das
  Objekt, an dessen Standort HEUTE geprüft wird — `UNTERNEHMEN`, `ANLAGE` (`siteId`), `STANDORT` (`standortId`), `ORT`
  (`ortId`), `DEVICE` (`deviceId`), `GERAET` (`id`, Tabelle `geraet`), `MESSSTELLE` (`id`), `BEZUGSGROESSE` (`id`)
  oder `DIENST`.
- **Reihenfolge (W2):** das Objekt wird unter der Verbindung der Anfrage aufgelöst, also unter Mandanten-RLS und
  Standort-Zaun.
  - Unsichtbar oder unbekannt: die Anfrage geht an die Route, deren eigene 404 bleibt byte-gleich.
  - Sichtbar, nach dem Vertrag aber außerhalb (nur Messstelle, Bezugsgröße — ohne Zaun): dieselbe 404, die
    die Route für eine unbekannte Kennung gibt (`RechtPruefung.nichtGefunden` je Controller). `geraet` trägt den Zaun
    selbst (`V20260918102000`, entschieden A am 21.09.2026): wie `device` unsichtbar, die Route antwortet.
  - Im Geltungsbereich ohne Recht: 403 `{code: recht_fehlt, message, recht, rolle_noetig[, umfang_noetig]}`, der Satz
    nennt die Kundenadministratoren.
- **Das Urteil** spricht `RechteAbleitung.darf` mit dem Aufrufer aus `ZugriffContext` (Standorte als ID). Nie
  zugewiesen = Kundenadministrator (E12). Angenommene Unterstützung = Unterstützer mit Umfang. Die Plattform bekommt die
  `P`-Zeilen (Anlage anlegen/löschen, Cockpit).
- **`DIENST`**: der Interceptor prüft vor, ob der Aufrufer eines der Rechte irgendwo hat (Unternehmen oder ein eigener
  Standort). Die genaue Prüfung steht in `RechtRoutenArchitekturTest.DIENST`: Kennzahl/Bericht in ihren Diensten
  (`KennzahlAufrufer`), Korrektur über `KorrekturRechte.aufrufer`, Box anmelden (`siteId`) und Bezugsgröße (Geltung im
  Körper) im Controller über `RechtPruefung.pruefen`/`pruefenGeltung`.
- **Körper-Ziele:** Ort verschieben prüft den neuen Elternknoten (`pruefenStandortOderOrt`); „gültig ab" vor heute
  braucht `aenderung.rueckwirkend` (`RechtPruefung.rueckwirkend`, Ort anlegen/Fläche/verschieben).
- **Nicht geprüft, gezählt:** ohne Zugriff-Kontext (Token ohne Kontoart, OIDC aus) und die Plattform am Umschalter
  `X-Tenant-Id` (W3, bis IP-8). Zähler `voltpilot_recht_total{ergebnis=erlaubt|recht_fehlt|ausserhalb|unsichtbar|
  ohne_kontext|umschalter}`, Anfrage-Attribut `RechtInterceptor.URTEIL`.

## ⚠ Fallen für die Folgepakete

- ⚠ **Neue Schreibroute:** `@Recht` unter die Mapping-Zeile, der Rechte-Kommentar bleibt darüber
  (`RechteKennungenDerRoutenTest` liest die Zeile direkt über dem Mapping). Kein `@Recht` an Lese- oder Admin-Routen.
- ⚠ **IP-7 ist gebaut** (`uems-rechte-steuerung.md`): die 46 Steuerungsrouten und die 4 ohne eigene Matrix-Zeile
  (Simulation und Steuerungs-Vorschau = `messwerte.ansehen`, Nutzungsprofil und Vorschlags-Gedächtnis =
  `betriebsweise.aendern`, Preisblatt = `anlage.verwalten`) tragen ihr Recht. Zwei Rechte in einem Aufruf lösen
  `DIENST` plus genaue Prüfung im Handler.
- ⚠ **IP-8:** der Umschalter wird ungeprüft durchgereicht (`Ergebnis.UMSCHALTER`). Stellt IP-8 ihn ab, fällt der Zweig
  in `RechtPruefung.ungeprueft` weg.
- ⚠ **Neue 404 im Controller:** Wer an einer `MESSSTELLE`-, `BEZUGSGROESSE`- oder `GERAET`-Route die 404 für eine
  unbekannte Kennung ändert, zieht `RechtPruefung.nichtGefunden` nach. `RechtMatrixApiTest.ausserhalbIst…` vergleicht
  beide Antworten.
- ⚠ **Messstelle ohne Ort heute:** `messstelle.bearbeiten` gilt „irgendwo" (sie hängt an keinem Standort). Bekommt die
  Messstelle einen Zaun (IP-10/IP-11), werden ihre Routen „unsichtbar" und die eigene 404 der Route greift — ohne
  Änderung hier. Bis dahin sind Messstellen lesbar und ihre Existenz ist nicht geheim. Die 404 außerhalb kommt darum vor
  der Prüfung des Körpers, eine unbekannte Kennung mit falschem Körper antwortet 400.
- ⚠ **Korrekturen** prüfen am Unternehmen: Bearbeiter je Standort (Zelle S) werden abgewiesen, bis die Korrektur ihren
  Standort nennt.
- ⚠ **Körper-Ziele mit gemischten Rollen:** die Vorprüfung „irgendwo" plus Zaun reicht NICHT für Bearbeiter an A und
  Leser an B. Wer ein Ziel aus dem Körper nimmt, ruft `RechtPruefung.pruefen` (heute: Box anmelden, Bezugsgröße, Ort
  verschieben). Offen: Messstelle → Ort zuordnen (Kennzeichen im Körper) prüft nur das Messstellen-Recht.
- ⚠ **`INSERT … RETURNING` im engen Zaun:** ein neues `ort` ist erst mit seiner Zuordnung sichtbar. `OrtRepository.anlegen`
  vergibt die Kennung darum selbst. Wer eine gezäunte Zeile anlegt, die erst danach sichtbar wird, macht es ebenso.
- ⚠ **Tests:** `authentication(new KeycloakRealmRoleConverter().convert(jwt))`, sonst fehlt der Kontext und es wird nicht
  geprüft. Einen Handler, der nicht laufen soll, hält `RechtMatrixApiTest.BisZumHandler` (Kopf `X-Test-Bis-Handler`,
  Status 299) an. Eine Route mit `consumes` braucht den passenden `Content-Type`, sonst 415 vor jedem Interceptor.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='RechtRoutenArchitekturTest,RechtAufruferTest,RechteKennungenDerRoutenTest')
(cd services/api && ./mvnw test -Dtest='RechtMatrixApiTest')
```
