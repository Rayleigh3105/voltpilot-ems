# ⚠ Register schreiben: DIE ADRESSE IST NICHT DAS ZIEL (Produktionsvorfall 20.08.2026)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 97).


Der Auftrag reist auf `ems/{t}/{s}/{d}/v2/register-write`, und auf diesem Pfad
hört GENAU EINE Sache zu: der Core der Box, der sich unter dieser Geräte-Kennung
angemeldet hat (`edge-app/core/internal/cloud` `Link.topic`). **WELCHES Gerät
beschrieben werden soll, steht im `target`-Feld der Nutzlast** — der Kontrakt
trennt die beiden ausdrücklich, und die drei Lanes sind genau deshalb drei.
Landet ein Auftrag auf einer Geräte-Zeile, hinter der kein Core steckt, ist er
**NICHT-retained und damit spurlos weg**: kein Abonnent, keine Ablehnung, keine
Zeile in irgendeinem Protokoll — auf BEIDEN Seiten. Diese Stille hat zwei
Untersuchungsrunden gekostet.

- **Die Adresse folgt dem ZIEL, nie der `deviceId` des Aufrufers.**
  `RegisterWriteService.resolveDevice` leitet sie aus dem gewählten Ziel ab, wenn
  die Plattform das MELDENDE Gerät kennt (Komponente bzw. gemeldete Quelle über
  `RegisterWriteTargets`), und überstimmt eine abweichende Angabe im Rumpf LAUT.
  Ohne meldendes Gerät bleibt es bei der Angabe des Aufrufers — `primary` (dort
  IST das Ziel das Gerät) und eine frei getippte LAN-Adresse, die keine
  gemeldete Quelle trifft. Die Regel selbst ist rein und Docker-frei
  geprüft: `registerwrite/RegisterWriteGateway` (`RegisterWriteGatewayTest`).
- **⚠ Die Lebendigkeit ist ein VERDACHT, kein Tor.** `lastSeenAt` ist
  `max(received_at)` der TELEMETRIE — eine ganz andere Kette als das
  MQTT-Abonnement des Cores: eine frisch eingerichtete Box ohne konfigurierten
  Wechselrichter sendet keine einzige Telemetrie-Zeile und hört trotzdem zu. Eine
  nie gemeldete Zeile wird deshalb NICHT abgewiesen; hat aber eine ANDERE Zeile
  derselben Anlage gemeldet, reist der Verwechslungs-Verdacht als `Choice.note`
  mit, wird protokolliert und steht im Schweige-Grund (`RegisterWriteSilence`) —
  die einzige Stelle, an der ein Mensch das Schweigen erklärt bekommt.
- **⚠ DIE ANTI-KOINZIDENZ-REGEL FÜR TESTS AUF DIESEM PFAD** (der Grund, warum es
  so lange unentdeckt blieb — beide Suiten konnten eine vertauschte Kennung
  STRUKTURELL nicht sehen): der Java-Stellvertreter abonnierte die WILDCARD
  `ems/+/+/+/v2/register-write` und antwortete auf `topic + "-result"`, echot also
  jede Adresse zurück; der Go-Test ruft `a.onRegisterWrite(payload)` DIREKT auf,
  das Abonnement des Cloud-Links kommt darin gar nicht vor; und die Test-Anlage
  hatte GENAU EIN Gerät, also fielen richtige und falsche Antwort ohnehin
  zusammen. **Ein Test über Adressierung muss ALLE beteiligten Kennungen
  auseinanderhalten** (Mandant ≠ Anlage ≠ meldendes Gerät ≠ zweite Geräte-Zeile ≠
  Entitäts-Kennung) und den Stellvertreter auf GENAU EIN Topic hören lassen
  (`DeviceStub.answerOnlyOn`). Dieselbe Falle steckte in
  `RegisterWritePublisherTest`, das `requested_at` nur mit
  Sekunden-genauen Fixture-Instants sah und nie mit dem, was `Instant.now()`
  wirklich ausgibt.
- **Beweise:** `RegisterWriteGatewayTest` (8, rein) ·
  `RegisterWriteApiTest.theOrderIsAddressedToTheREPORTINGBoxAndNeverToASilentDeviceRow`
  (echtes EMQX, Herzogau-Form: zwei Geräte-Zeilen, Stellvertreter NUR auf dem
  Pfad der meldenden Box) · Go
  `agent/register_write_integration_test.go` (echter Agent über einen echten
  Broker: der Auftrag auf dem EIGENEN Topic wird beantwortet, der auf einer
  fremden Kennung löst NICHTS aus).
- **⚠ Was auf der BOX niemals eine Spur hinterlässt: eine VORSCHAU.** Das
  Box-Audit (`GET :8484/api/installer-write`) führt bewusst nur bestätigte
  SCHREIBvorgänge (`if admitted.Apply()`), ein Probelauf steht dort also nie —
  eine leere Audit-Liste sieht bei einer funktionierenden Vorschau exakt so aus
  wie bei einem Auftrag, der nie ankam. Sie taugt deshalb NICHT als Beleg für
  „der Downlink kommt nicht an"; seit dem Vorfall protokolliert die Box jeden
  ANGENOMMENEN Auftrag und jedes gesendete Ergebnis auf INFO
  (`agent/register_write.go`), und DAS ist die Zeile, die die Frage beantwortet.

