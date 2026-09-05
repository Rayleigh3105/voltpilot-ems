# Die VERTRAUENS-IDENTITAET im Herzschlag

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 33).


Additiv, ohne jeden neuen Wirkpfad zum Wechselrichter. Cloud-Seite + Portal:
root `AGENTS.md` „Edge-Updates: EIN Schritt"; Rotations-Drill:
[`docs/ota-signing.md`](../docs/ota-signing.md) §7.1.

- **Der Herzschlag traegt die Vertrauens-Identitaet** (`cloud.TrustSummary` im
  `update`-Block, gebaut in `agent/ota.go otaRefreshTrust`, zwischengespeichert
  mit eigenem mtime-Stempel - die Ed25519-Pruefung laeuft nur bei geaendertem
  Trust-Set). Sie beantwortet „traegt diese Box ein schluesseltragendes Image?"
  (TOFU) und „hat sie das neue Trust-Set schon gesehen?" (Rotation), und sie
  gilt UNABHAENGIG von einem Release - genau die Box ohne Zuweisung ist die,
  deren Crossover-Stand der Betreiber wissen muss.
  - **`otaverify.InspectTrust` ist die EINE Quelle** und faehrt die ersten zwei
    Schritte von `Verify`: ein Trust-Set, das die eingebackene Wurzel NICHT
    unterschrieben hat, wird NICHT berichtet. Werkzeug (`vp-ota trust`) und
    Geraet rufen dieselbe Funktion - zwei Quellen fuer „welches Set faehrt
    diese Box" waeren zwei Wahrheiten.
  - **⚠ ABWESEND und LEER sind verschiedene Aussagen.** Ein aelterer Stand
    sendet den Block gar nicht („unbekannt"); ein Image OHNE Wurzel sendet ihn
    mit LEERER `root_key_ids` (`[]`, nie `null` - deshalb das explizite
    `append([]string{}, ...)`), und das heisst „Crossover offen" - der
    dokumentierte Vor-TOFU-Zustand, kein Fehler.
- **⚠ ENTFALLEN am 26.08.2026: die Einmal-Freigabe.** Sowohl die
  `:8484`-Taste „Jetzt anwenden" (`agent/ota_apply.go`, `static/ota.js`) als
  auch ihr Portal-Zwilling (`agent/ota_apply_downlink.go`, Kontrakt
  `mqtt-ota-apply.schema.json`, Topic `v2/apply`) sind ERSATZLOS weg. Sie
  existierten nur, weil die Autonomie per Vorgabe AUS war; ohne dieses Tor
  haben sie keinen Gegenstand mehr. **Wer je wieder einen zweiten Weg zum
  Anwenden einzieht, muss jedes Tor ein zweites Mal absichern** - der Grund,
  aus dem es damals genau EINEN gemeinsamen Kern gab
  (`OtaRequestApplyWithToken`).

