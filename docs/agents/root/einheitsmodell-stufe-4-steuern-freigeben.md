# Einheitsmodell Stufe 4: „STEUERN FREIGEBEN" — aus dem Sensor wird ein schaltbares Gerät

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 30).


Die Stufe, die die Captain-Vision einlöst (Konzept `vp-modbus-baukasten-k6` **§2.4** — die sechs
Leitplanken sind wörtlich die Vorlage —, §2.3 Schritt 3+5, §2.5; `vp-komponenten-einheit-h2` §3.3):
Ein/Aus **und Sollwert**, freigegeben durch einen geführten Test, den der Kunde selbst fährt. Alles
ist ADDITIV — ein Gerät ohne Freigabe verhält sich zeichengleich wie nach Stufe 3, und **ein
Bestandsgerät bekommt durch diese Stufe keinen Schreibweg**.

- **⚠ DIE TRAGENDE REGEL: kein Wert außerhalb des Freigegebenen, keine Adresse zur Laufzeit.** Je
  Gerät wird GENAU EIN Schreib-Register freigegeben, mit fester Art. **Ein/Aus** kann per
  Konstruktion nur die zwei bei der Freigabe festgelegten Konstanten schreiben; **Sollwert** nur
  Werte innerhalb der festgelegten Min/Max-Klemme, mit fester Einheit/Skalierung, plus einen
  **Sicherheitswert** für Stille und Widerruf. Die reine `components/SwitchDefinition` (Docker-frei,
  das `SelfBuildDefinition`/`Tagesprotokoll`-Muster) ist der Zaun: `NormalizedSwitch.rawFor(v)`
  klemmt beidseitig, und **`safeRaw()` wird ausdrücklich NICHT in das Betriebsband geklemmt** — der
  Sicherheitswert liegt normalerweise UNTER dem Minimum, ihn hineinzuklemmen machte aus „aus" ein
  „lauf langsam weiter". Der Palette-Zwilling (`vp-modbus-switch.js` `plan`/`safeValue`) hält
  dieselbe Trennung: `toRaw` klemmt ins Band, `rawOf` nur auf 0..65535.
- **⚠ FC16 ist die Vorauswahl fürs Register, NICHT FC6** (die belegte Fronius-/Deye-Lektion „FC6
  wird angenommen, aber nicht übernommen"); eine Spule kennt nur FC5, dort ist die Wahl gar keine.
  Der Codec kann jetzt beides (`modbus-tcp.js` `buildWriteCoilRequest`/`parseWriteCoilResponse` +
  `buildReadCoilsRequest`) — **eine Spule ist das EINE Modbus-Objekt, dessen Drahtform nicht ihr
  Wert ist: `0xFF00` heißt EIN**, deshalb nimmt der Frame-Bauer einen BOOLEAN, nie die Zahl.
- **KEIN freier Schreib-Baustein.** Geschrieben wird ausschließlich durch den generierten Executor
  **`vp.modbus.switch`** — generated-only + origin-gestempelt, wörtlich das `vp.consumer.reactive`-
  Muster (D-19). Der Katalog-Eintrag steht in allen DREI Katalogen; **das D-19-Tor ist dabei
  datengetrieben geworden** (`generatedOrigin` je Typ in flowc, `generated_origin` in api/portal)
  statt gegen `consumer-policy` fest verdrahtet — sonst hätte ein zweiter generierter Baustein das
  Tor entweder umgangen oder eine zweite Prüfung gebraucht.
  - **⚠ Das Tor hat DREI Zwillinge, und sie müssen zusammen wandern:** flowc (`compile.js`,
    `generatedOrigin`), api (`FlowGraphValidator`, `generated_origin`) und Portal
    (`flows/validate.ts`). Beim Bau war der Portal-Zwilling als EINZIGER auf `consumer-policy`
    verdrahtet geblieben — ein gültiges Schalter-Dokument fiel dort mit einer Meldung durch, die
    obendrein die falsche Regel nannte. **Die Meldung nennt seither, WELCHER generierte Flow den
    Baustein besitzt** (`generated_origin_label`, ebenfalls Katalog-Daten): ein generisches „einem
    generierten Flow vorbehalten" ist bei zwei Bausteinen keine Auskunft mehr. Ein generierter Typ
    OHNE `generated_origin` ist ein Katalog-Fehler und fällt fail-closed durch — nie ein stiller
    Rückfall auf den origin-kind eines anderen.
  - **⚠ Katalog-Parameter heißen `name`, nicht `key`.** Beide Validatoren lesen `spec.name`; der
    Stufe-4-Eintrag kam mit `key` (als EINZIGER von 57 Parametern) und ließ damit jedes
    Schalter-Dokument mit fünf erfundenen „Parameter fehlt"-Fehlern durchfallen. Weil kein Test
    ein `vp.modbus.switch`-Dokument validierte, war das unsichtbar — die zwei Zwillings-Tests
    (`FlowGraphValidatorTest.modbusSwitchFixtureValidatesCleanOnlyWithItsOwnOrigin` +
    `validate.test.ts`) sind seither der Wächter, und sie prüfen BEIDE Richtungen (eigener origin
    gültig · ohne origin abgelehnt · fremder origin abgelehnt).
  - **Bewusste Abweichung vom Brief:** der Auftrag nennt „einen eigenen, geschlossenen
    origin-Zweig". Der Schalter behält den BESTEHENDEN `modbus-device`-Zweig, weil Leitplanke 6
    (ein Socket) verlangt, dass er im SELBEN generierten Flow lebt wie die Lese-Knoten des Geräts
    — ein eigener origin-kind teilte den Geräte-Flow in zwei und damit den Socket.
- **Der Freigabe-Assistent ist ein EIGENER Schritt an der fertigen Komponente**, nie der fünfte
  Schritt des Anlege-Wegs: vor der Freigabe ist das Gerät ein Sensor, und diese Trennung IST die
  Aussage. Er zeigt Register, Schalt-Art, beide Konstanten bzw. Klemme + Sicherheitswert und die
  FOLGEN — dann den begrenzten Test.
- **⚠ DIE REIHENFOLGE IST DIE SICHERHEIT: das automatische Aus wird ARMIERT, BEVOR geschrieben
  wird** (`agent/switchtest.go`, das Kalibrier-Muster `time.AfterFunc`), nicht nachdem der
  Schreibvorgang gelungen ist. Daraus folgt die Regel, die man beim Aufräumen zerstören würde: ein
  FEHLGESCHLAGENER Test behält seinen armierten Wachhund — der Schreibvorgang kann angekommen sein
  und nur seine Antwort verloren haben. Aus demselben Grund ist ein Timeout im Portal ausdrücklich
  **„unklar", nie „fehlgeschlagen"**, und der Satz sagt, dass das Gerät von selbst zurückfällt.
- **Die Freigabe traegt wer/wann/EVIDENZ** (Anforderung 3). Die Evidenz entsteht SERVER-seitig aus
  dem bestandenen Test (`SelfBuildComponentService.switchEvidence` — geschriebener Rohwert, und nur
  wo es ein Rueckleseregister gibt, das Rueckgelesene) und reist im BELEG mit
  (`ComponentConnectionReceipts.Receipt`), nie im Freigabe-Aufruf: ein Nachweis, den der Client
  behaupten darf, ist keiner. Sie stirbt mit ihrem Beleg (dieselbe 30-min-Regel) und landet in
  `switch.freigabe.evidence` — weil der Block in der DEFINITION wohnt, traegt ihn die
  Fassungs-Historie ohne Zutun mit. **Ohne Rueckleseregister wird KEIN Rueckleseergebnis
  behauptet**; dort traegt die Bestaetigung des Kunden allein.
- **Die BRUECKE ist verdrahtet** (Anforderung 9): die Komponenten-Karte des Anlagen-Modells bietet
  „Regel mit dieser Komponente erstellen" → `#/anlage/{id}/steuerung?komponente={entityId}` →
  `RegelnKapsel` oeffnet den geführten Baukasten vorbefuellt. **Ein EIGENER Effekt neben dem
  Verbraucher-Deep-Link**, weil der auf `consumers` wartet und eine Anlage mit einem selbst
  gebauten Geraet oft gar keinen Verbraucher hat — die Bruecke haenge dort nie an. Sie ist ein
  ABSPRUNG mit Vorbefuellung, nie eine gemeinsame Leinwand (der generierte Geraete-Flow bleibt
  unsichtbar), und ohne Messwert oeffnet der normale Drei-Tueren-Weg statt eines Baukastens ohne
  waehlbare Groesse.
- **Totmann, dreistufig und ehrlich benannt** (Leitplanke 4): (a) Wünsche verfallen per TTL, der
  Arbiter zieht zurück; (b) der Executor re-assertiert (60 s) und schreibt bei Rückzug/Staleness
  (180 s) AKTIV den Aus- bzw. Sicherheitswert (die Shelly-Regel); (c) ein generisches Modbus-Gerät
  hat **keinen** eingebauten Geräte-Totmann — das sagt der Dialog WÖRTLICH
  (`SwitchDefinition.DEADMAN_NOTE` ⟷ `schaltFreigabe.TOTMANN_HINWEIS`, beide zusammen ändern).
  Das optionale „Watchdog-Register des Geräts" ist Vorgabe LEER, kein Zwang.
- **Klemme + Zyklen-Guard laufen VOR dem Executor** (Leitplanke 5): die Freigabe schreibt
  Nennleistung und Schonzeiten in `guard_config`/`guards.limits` — genau den Block, den der
  Registry-Push trägt und aus dem der Arbiter die Verbraucher-Klemme und `guards.CycleGuard` baut.
  **Bewusste Vereinfachung gegenüber dem Brief-Wortlaut** (der `consumer_profile` nennt): es
  entsteht keine Profilzeile, weil der Zaun am Push hängt, nicht an der Tabelle — die Wirkung ist
  dieselbe, der Weg ist kürzer und hat keinen zweiten Speicher.
- **EIN Socket-Gesetz** (Leitplanke 6): der Schalt-Executor lebt in Node-RED (der Go-Core hat keinen
  Modbus-Client) und schreibt über `lib/modbus-conn.js` — die Bibliothek wurde dafür um
  `writeValue`/`readCoils` erweitert, sodass Lesen UND Schreiben durch DIESELBE Warteschlange je
  (host, port) laufen. Nie ein zweiter TCP-Pfad zum selben Gerät (die Deye-Kollisionslektion). Der
  Test-Kanal ist bewusst ein EIGENES Topic-Paar (`edge/switch/request|result`) und ein eigener
  Knoten, damit `vp-modbus-probe` seine Nur-Lese-Eigenschaft als Eigenschaft des CODES behält.
- **Der Anlagen-Not-Aus bleibt der Plattform-Hebel** (`VP_CONTROL_ENABLED ∧
  `VP_CONSUMER_CONTROL_ENABLED`): der Kern veröffentlicht ihn retained auf `edge/control/gate`, weil
  das `control_enabled` des Entitäts-Kommandos die WECHSELRICHTER-Zertifizierung trägt und hier die
  falsche Frage beantwortet. Der Executor ist fail-closed. **Die Geräte-Freigabe ersetzt die
  TYP-Zertifizierung** (für beliebige Selbstbau-Geräte strukturell unmöglich), nie den Not-Aus.
- **api:** `POST/DELETE /api/v1/sites/{id}/components/custom/{entityId}/switch-test[/cancel]` +
  `…/switch-release` (`SiteComponentController`, RLS-gefenced wie jede `/sites/**`-Route). **Die
  Freigabe braucht BEIDES**: einen bestandenen Test auf GENAU dieser Definition (der Beleg keyt über
  `switchReceiptFields` auf Adresse/Art/Konstanten/Klemme — eine geänderte Adresse ist ein anderes
  Register) UND die bestätigte Wirkung; eines allein trägt keine der beiden Aussagen. Der Widerruf
  ist SOFORT wirksam, **lässt die Definition aber stehen** (eine Rücknahme ist keine
  Beweisvernichtung) und löscht nur den Beleg. Beide Wege schreiben ins `consumer_audit_event`
  (Migration `V20260821000000` weitet nur dessen CHECK — **es entsteht KEINE Tabelle**: die
  Schalt-Definition wohnt in `measurement_point.connection_json`, und die Fassungs-Historie trägt
  die Freigabe dadurch ohne Zutun mit).
- **Beweise:** rein Go `internal/probe` (Zulassung des Schaltens erbt JEDE Lese-Regel und bringt
  eigene mit: FC↔Registerart, Spulen-Werte 0/1, TTL 1..120, Abbruch ohne on/ttl) + `SwitchDefinition`
  (Klemme, Konstanten-only, Sicherheitswert unterhalb des Bandes, deutsche Gründe je Fall,
  Freigabe braucht beides) · Palette `test/switch_spec.js` (13, u. a. die GETEILTE Warteschlange
  gegen ein in-process-Gateway und „ein Gerät, das den Schreibvorgang schluckt, fällt am Rücklesen
  auf, nicht am Echo") · flowc `compile.test.js` (der Schalter kompiliert in den GERÄTE-Flow und
  wird in einem fremden Flow verweigert — auch mit `consumer-policy`-origin) · Testcontainers
  `SelfBuildComponentApiTest` (+2: die Reise ohne Test → ohne Bestätigung → freigegeben →
  zurückgenommen, Fähigkeit + Klemme in der Entität, Audit-Spur, RLS auf jeder Route; und der
  entwertete Beleg) · Portal `schaltFreigabe.test.ts` (19) + `SchaltFreigabeDrawer.test.tsx` (9) +
  `AnlagenModellSection.test.tsx` (+4).
- **NICHT in dieser Stufe:** mehrere Schreib-Register je Gerät · HTTP/MQTT-Schreiben (folgt der
  jeweiligen Lese-Art, Stufe 3b) · Vorlagen-Verwaltung (Stufe 6) · Bilanz-Rollen.

