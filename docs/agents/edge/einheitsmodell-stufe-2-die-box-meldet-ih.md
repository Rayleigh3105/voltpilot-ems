# Einheitsmodell Stufe 2: die Box MELDET ihre Verbindungen — und wird zum Spiegel

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 53).


Cloud-Seite, Migration und die Uebernahme-Regeln: Root-`AGENTS.md`
„Einheitsmodell Stufe 2". Was HIER gelten muss:

- **`local_setup` traegt seit dieser Stufe die VERBINDUNG** (`agent.localSetupSummary`
  -> `cloud.LocalSetupEntry`, Vertrag `docs/contracts/v2/edge-entity-config.md` §5.1):
  `family`, `communication`, `connection` (VERBATIM als `json.RawMessage` — das
  `entities.Entity.Driver`-Muster, damit die Bytes unterwegs nicht umgeformt werden und
  ein neues Feld in `inverter.Connection` ohne zweite Zuordnungstabelle mitreist),
  `interval_s`, `capacity_kwp`, `registry_unit_id`. Das sind GENAU die Felder, die
  `sources.Source`/`inverter.Selection` speichern — weniger, und die Uebernahme waere
  kein No-op mehr.
- **Was die Box nicht hat, wird WEGGELASSEN** (`omitempty`), nie als 0/"" gesendet: nur so
  kann die Cloud „nicht gemeldet" von „ist 0" unterscheiden, und nur so heisst ein
  fehlendes `connection` „diese Box meldet noch keine Verbindungen" statt „dieses Geraet
  hat keine".
- **⚠ DER BEWEIS, dass die Uebernahme nichts aendert, lebt hier:**
  `agent/component_adopt_test.go` faehrt die ECHTE Kette
  `localSetupSummary -> (Cloud-Treiberblock) -> componentapply.Derive -> Plan.SameAs`
  an einer Pilsting-artigen Anlage. `SameAs` ist eine STRUKTURGLEICHHEIT ueber ALLE
  Felder — wer `componentapply.Driver`, `sources.Source` oder `inverter.Connection`
  erweitert, muss das neue Feld auch MELDEN und PUSHEN, sonst faellt der Beweis um (er
  ist mutationsgeprueft).
- **`componentapply.Driver` traegt jetzt `registry_unit_id`** und `Derive` reicht es an
  `sources.Normalize` weiter — ohne das verloere eine Uebernahme die MaStR-Referenz des
  Betreibers beim ersten Rueckschreiben.
- **`:8484` ist auf einer portal-verwalteten Anlage ein read-only SPIEGEL.** Bis Stufe 1
  lehnte nur die API ab (`refuseIfPortalManaged`) und die Seite bot die Knoepfe weiter an
  — ein Klick lief in eine Ablehnung. Jetzt tragen `/api/inverter` und `/api/sources`
  additiv `portal_managed` (aus `InverterController.PortalManagedComponents`), und
  `VP.setPortalManaged` blendet JEDE mit `data-vp-edit` markierte Bedienung aus und zeigt
  EINEN ruhigen Satz. **Gesperrt wird ausschliesslich das AENDERN** — Sehen, „Verbindung
  testen", Koppeln, Netzwerk, Steuerungs-Freigabe, Not-Aus, Modbus-Spiegel und
  Messwert-Aufbereitung bleiben lokal und unberuehrt (§4.3). Ein neuer Bearbeiten-Knopf in
  der Anlage-Karte braucht `data-vp-edit`, sonst ueberlebt er die Uebernahme sichtbar.
- **⚠ „Verbindung testen" WAR diese Zusage nicht, und der Grund ist der WOHNORT des
  Knopfes** (Befund L6, Scout `vp-portal-box-spiegel-s2` §3.3): der Test sass
  ausschliesslich IM Bearbeiten-Formular (`invTestBtn`) bzw. im Hinzufuegen-Drawer
  (`srcTestBtn`) — beide oeffnen sich nur ueber `data-vp-edit`-Knoepfe, die
  `setPortalManaged` ausblendet. Auf genau den Anlagen, auf denen der Kunde nichts
  aendern DARF, war der lokale Test damit unerreichbar. Seither traegt JEDE Zeile
  (Wechselrichter `invRowTestBtn`, jede Quelle) eine EIGENE, **nicht editierende** Taste
  ohne `data-vp-edit`, die die GESPEICHERTE Verbindung prueft (dieselbe Route
  `/api/test-connection`, kein neuer Endpunkt) und ihren Beleg direkt unter ihrer Zeile
  zeigt. **Regel fuer jede kuenftige Handlung hier: `data-vp-edit` markiert, was AENDERT —
  eine reine Pruefung traegt es nie**, sonst verschwindet sie genau dort, wo sie gebraucht
  wird (`web_test.go` prueft beide Richtungen).
- **⚠ Zwei Fallen des Zeilen-Belegs, beide im Browser gefunden:** (1) die Quellen-Liste
  wird alle 10 s per `innerHTML = ""` neu gezeichnet — ein je Zeichnung neu gebauter
  Kasten waere mitten im Test weg; die Kaesten leben deshalb je Quellen-ID in
  `verifyPanels` und der Takt setzt aus, solange ein Test laeuft. (2) `verify.js` SETZT
  `panel.className` bei jedem Ergebnis neu, eine eigene Zusatzklasse ueberlebt den ersten
  Klick also nicht — der Zeilen-Kasten wird an seiner STELLE erkannt
  (`.rows > .verify-panel`), nie an einer Klasse.
- **Der gefuehrte Vier-Schritt-Flow ist portal-bewusst** (`commissioning.js` `derive(...,
  portalManaged)`, VIERTES additives Argument): Schritt 2 heisst dort „Geräte im Portal
  anlegen" (Konzept `vp-komponenten-einheit-h2` §4.3) statt „… werden hier nachgetragen",
  Schritt 1 bietet „Gerät ansehen"/„Verbindung prüfen" statt „Ändern"/„Wechselrichter
  auswählen", und ohne Wechselrichter gibt es GAR KEINEN Knopf — eine Handlung, die
  gesperrt ist, wird nicht angeboten. Fehlt das Argument, ist jedes Wort zeichengleich wie
  vorher (Wächter im jstest).
- `static/*` ist `//go:embed`-ed — Kern nach jeder Aenderung neu bauen.
- Beweise: `agent/component_adopt_test.go` (6) · `internal/web` (`portal_managed` +
  Spiegel-Struktur + „Verbindung prüfen" ohne `data-vp-edit`) ·
  `internal/web/jstest/ui.test.js` (4 reine Faelle + 5 portal-bewusste Flow-Faelle).

