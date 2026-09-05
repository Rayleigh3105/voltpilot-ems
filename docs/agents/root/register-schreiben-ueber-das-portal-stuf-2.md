# Register schreiben über das Portal, Stufe 2 (Box): freie Register, drei Lanes

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 98).


Die zweite Stufe des Konzepts `data/vp-reg-schreib-konzept-p8` (§2.8, §2.6).
**Sie löst die harte `0x00E7`-Allowlist des Portal-Kanals ab** — angekündigt,
nicht unterlaufen: der Stufe-1-PR schrieb selbst, ein weiteres Register sei
„eine Code-Änderung hier, mit eigenem Review". Kein neuer Schreibweg: es bleibt
bei GENAU EINEM Einmal-Schreib-Kern mit zwei Triggern.

- **⚠ ZWEI POLITIK-UMFÄNGE, EINE SCHICHT, EINE `AdmittedWrite`.**
  `installerwrite.Admit` bleibt der ENGE Umfang der `:8484`-Taste (das
  Export-Limit-Register, Deckel 7000, kW-Kopie — ihre Oberfläche ist ein
  Werkzeug für EINE Zahl und bleibt es); `installerwrite.AdmitExpert`
  (`expert.go`) ist der Umfang des PORTAL-Kanals: freies Holding-Register bzw.
  Spule, Wert 0..65535 (Spule 0/1), Funktionscode passend zur Registerart. Beide
  bauen dieselbe `AdmittedWrite` mit unexportierten Feldern und teilen
  Bestätigungs-Token, `expected_before`-Schranke und Einmaligkeit WÖRTLICH — es
  gibt weiterhin genau zwei Konstruktoren und keinen Weg an ihnen vorbei.
- **⚠ Produktionsfix 28.08.2026 — die Vorschau trägt keinen Schreibwert.** Der
  Cloud-Vertrag verbietet `value` bei `mode=lesen`; der Core bildet dessen
  Abwesenheit auf dem lokalen Bus als `Value=0` ab. Der Solarman-Palette-Knoten
  hatte nach Einführung der freien Portal-Register noch die alte enge
  `:8484`-Prüfung `0x00E7 && 1..7000` und ließ deshalb JEDE Portal-Vorschau
  still fallen — sichtbar als exakt 30-s-Timeout, obwohl Beobachtungen liefen.
  Seit Palette **0.9.1** prüft `vp-installer-write-request.parse` die gemeinsame
  Holding-Form 0..65535, akzeptiert Dry-Runs ohne Wert bzw. mit `0` und lässt
  die zwei unterschiedlichen Umfänge dort, wo sie hingehören: `Admit` (lokal,
  eng) und `AdmitExpert` (Portal, frei).
- **DREI LANES, und die ASYMMETRIE ist die Sicherheit:** `primary` — die Cloud
  nennt NICHTS, die Box nimmt ihren eigenen Wechselrichter; `entity` — die Cloud
  nennt nur die Kennung, den Endpunkt löst die Box aus IHRER angewandten
  Registry auf; `lan` — nur hier reist der Endpunkt, und nur hier muss die Box
  ihn deshalb selbst beurteilen (`probe.IsPrivateHost`, der **fünfte Konsument**
  von `docs/contracts/lan-host-vectors.json` — kein fünfter Zwilling; der
  Palette-Knoten prüft es vor dem Wählen ein zweites Mal).
- **⚠ Die Selbstkonflikt-Sperre gilt dem GERÄT, nicht der Zahl.** Das
  Steuer-Rücklesen nennt die Register, die unser Executor auf dem PRIMÄR-Gerät
  schreibt; dieselbe Nummer auf einem eigenen Modbus-Gerät des Kunden ist ein
  völlig anderes Register, und sie zu verweigern wäre ein erfundener Konflikt.
  Sie bleibt die EINE harte Ablehnung und greift weiterhin schon in der Vorschau.
- **Neuer Bus-Pfad, kein neuer Schreibweg:** `Agent.WriteOnce` verzweigt auf
  `edge/installer-write/*` (Solarman, Flow-Kontext-Lock des Wechselrichter-Tabs)
  bzw. das neue Paar `edge/register-write/*` → Palette-Knoten
  `vp-register-write` (**Palette 0.9.0**, die Stufe-4-Schreibmechanik über
  `modbus-conn.writeValue` **OHNE Auto-Aus** — dort ist das Zurücklaufen der
  Zweck, hier das Stehenbleiben). Die Nachrichten-FORM ist byte-gleich, ein
  Handler bedient beide.
- **Ein Register ohne bekannte Skala bekommt KEINE erfundene Einheit** — weder
  im Plan noch im Audit-Protokoll (`installerwrite.Entry.Kw` ist ein ZEIGER und
  fehlt dann). Die kundenlesbare Einheit kommt aus dem Register-Wissen der Cloud.
- **Kontrakt:** rein beschreibende Präzisierung (`mqtt-register-write.schema.json`
  — alle drei Lanes werden ausgeführt, `refused_policy`/`not_supported` sagen
  genauer, wofür sie stehen) plus zwei neue Fixtures
  (`…valid.entity-coil.json`, `…valid.lan-preview.json`). **Keine Formänderung**,
  `schema_version` bleibt 1.0.
- **Beweise:** `installerwrite/expert_test.go` (5, u. a. „der enge Umfang bleibt
  eng") · `internal/registerwrite` (die drei Lanes, die LAN-Whitelist, die
  Spulen-Regel als LANE-Eigenschaft, die Kontrakt-Vorgaben, die zwei Fixtures per
  PFAD) · `agent/register_write_test.go` (+6) ·
  `vp-palette/test/register_write_spec.js` (10) ·
  `nodered/inverter-control-routing.test.js` + `flows-sync.test.js`.
  Edge-Details: `edge-app/AGENTS.md` „Stufe 2 „Freie Register"".

