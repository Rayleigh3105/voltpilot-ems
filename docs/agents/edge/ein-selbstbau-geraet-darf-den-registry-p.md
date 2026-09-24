# ⚠ Ein SELBSTBAU-Gerät darf den Registry-Push nie scheitern lassen (Einheitsmodell Stufe 3)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 54).


`componentapply.Derive` ist alles-oder-nichts, und `roleFor` kennt den Typ
`modbus-generic` nicht. Ohne einen ausdrücklichen Skip hätte **EIN** vom Kunden
selbst definiertes Modbus-Gerät den GANZEN Push scheitern lassen — die Anlage
verlöre also mit ihrem ersten eigenen Gerät die Anwendung ihres Wechselrichters
und aller Quellen. Der Skip sitzt deshalb in `ParseDriver`, **vor** der
Marken-Prüfung (ein Selbstbau-Gerät trägt per Konstruktion keine Marke), und
liefert `ok=false` = „dieses Gerät liest diese Box nicht" — dieselbe Semantik wie
beim Vor-Stufe-1-Treiber ohne Verbindung.

- `componentapply.CommunicationSelfBuild` (`modbus_baukasten`) ist wörtlich mit
  der Cloud geteilt (`SelfBuildDefinition.COMMUNICATION`) — **beide zusammen
  ändern**, sonst beginnt die Box Pushes abzulehnen, die sie ignorieren sollte.
- Sein LESEPLAN reist im FLOW, nicht in `sources.json`: je Kanal ein
  `vp-modbus-read`, das seine Telemetrie selbst je Entität publiziert. Der
  `driver`-Block trägt hier nur Anzeige/Kontext.
- Eine Anlage mit AUSSCHLIESSLICH Selbstbau-Geräten ergibt `ErrNoConfiguration` —
  der dokumentierte Fall des leeren Solls, kein Fehler des Kunden (vor der
  Übernahme ein Halt, danach bleibt keine Katalog-Quelle in `sources.json`).
- **Der Palette-Knoten prüft die LAN-Regel unabhängig noch einmal**
  (`vp-palette/lib/private-host.js`, verdrahtet in `vp-modbus-read.js`): ein
  ausgerollter Flow ist eine Anweisung von aussen, und wer eine Verbindung
  öffnet, prüft ihr Ziel selbst (die OTA-Sidecar-Disziplin). Ein nicht
  nachweisbar privates Ziel wird gar nicht erst angeklopft — der Knoten liest
  NICHTS und sagt laut warum. Es ist der vierte Zwilling derselben Regel; alle
  vier lesen `docs/contracts/lan-host-vectors.json`.
- **⚠ „Von der Box übersprungen" heisst NICHT „auf der Box unsichtbar" (Befund
  L5, Scout `vp-portal-box-spiegel-s2`).** Bis zum 31.08.2026 folgte das eine
  aus dem anderen: ein Selbstbau-Gerät stand in keiner Quelle, also auf
  `:8484` NIRGENDS — „der Kunde sieht sein eigenes Gerät nur im Portal". Zwei
  Dinge sind seither getrennt:
  - **Anzeige:** `componentapply.CustomDevices` (rein, ohne Uhr und I/O) leitet
    aus DEMSELBEN Push die Zeilen der Gruppe „Eigene Geräte" ab (Name,
    Kommunikationsart · Adresse · die vom KUNDEN benannten Kanäle, „schaltbar"
    nach Stufe 4); `Agent.CustomDevices` ergänzt die Frische aus derselben
    Lese-Karte und demselben Fenster wie der Herzschlag, und
    `GET /api/sources` trägt sie additiv als `custom_devices`. Die Gruppe ist
    auf JEDER Anlage read-only — angelegt, geändert und gelöscht wird im
    Portal —, und der `web_test.go`-Wächter verweigert ein `data-vp-edit`
    darin.
  - **⚠ Die Pille sagt den MECHANISMUS, nicht ein Warten:** ohne Messwert heisst
    sie „Wird über eine Regel gelesen", nie „Wartet auf erste Daten" wie bei
    einer Quelle. Die Box POLLT dieses Gerät gar nicht selbst — sein Leseplan
    ist ein generierter Flow —, ein Warten würde also niemand tun.
  - **BILANZ:** unverändert keine. `topology.IsSelfBuiltType` gibt jedem
    Selbstbau-Typ (`modbus-generic`, `modbus-load`) in `DefaultRole` die Rolle
    `""`. Ohne diesen Zweig entschied die KATEGORIE, und ein `modbus-generic`
    ist `meter` — ein vom Kunden `power_kw` genannter Kanal wurde damit **als
    NETZANSCHLUSSPUNKT** gerendert (im Labor reproduziert: der Netz-Knoten trug
    „Netzanschluss …, Wärmepumpe (Selbstbau …)"). Die Regel steht in allen DREI
    Zwillingen und in `docs/contracts/v2/topology-vectors.json` — **zusammen
    ändern.**
- Beweise: `componentapply_test.go` (der Skip rettet Wechselrichter + Quellen,
  „nur Selbstbau ⇒ ErrNoConfiguration"), `customdevices_test.go` (dieselbe
  Entität wird übersprungen UND gelistet, eine Adresse wird nie erfunden),
  `internal/topology` (die geteilten Vektoren), `internal/web`
  (`custom_devices` + der Struktur-/Read-only-Wächter),
  `jstest/ui.test.js` (die reinen Zeilen-Texte),
  `vp-palette/test/private_host_spec.js`.

