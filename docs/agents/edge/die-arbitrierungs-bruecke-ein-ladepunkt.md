# Die ARBITRIERUNGS-BRÜCKE: ein Ladepunkt hört auf denselben Arbiter (P5/K3)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 85).


Cloud-Seite, Kontrakt und die Trennung „wirkt sofort / braucht das Release": root
`AGENTS.md` „Verbrauchsmanagement v1 — Paket 5". Was HIER gelten muss:

- **⚠ SIE KANN DEN PHYSISCHEN RAHMEN NUR VERENGEN, NIE WEITEN.** `ocppStep` fragt je
  Sitzung `arb.DecisionFor(entityID)` (Zuordnung über `charge_point_id` aus dem
  Registry-Descriptor) und übersetzt das Urteil in ZWEI Felder der schon existierenden
  `lastmgmt.Session` — `CapKw` (DECKELT: `MaxKw = min(Stecker, L)`) und `SourceExempt`
  (BEFREIT von der Quellen-Bahn, wörtlich der Boost-Mechanismus). Budget,
  Sicherheitsabstand, §14a, Rotation, Mindestleistung, Totmann und das TxDefault-Profil
  binden unverändert DANACH. Es gibt keinen Weg, auf dem ein Halter mehr Leistung
  bekommt, als die Anlage physisch hergibt.
- **Die Übersetzung ist rein** (`agent/ocpp_bridge.go`, ohne Bus und ohne Uhr — das
  `otaapply`/`probe`-Muster); `ocppApplyBridge` ist Verdrahtung mit einem Cache je
  Entität.
- **⚠ Die BEFREIUNGS-Schwelle ist ein RANG, keine Klassenliste**
  (`ocppBridgeExemptRank = 50`): ab `deadline-fallback` aufwärts (also auch `market` und
  `flow+override`) hat jemand entschieden, DASS jetzt geladen wird — ein plain `flow`
  (40) hat das nicht. Eine Liste hätte bei jeder neuen Klasse gepflegt werden müssen.
- **⚠ Der Grund heißt `plan` oder `regel`, NIE `wartet`** (`lastmgmt.ReasonPlan`/
  `ReasonRule`; Rang 50/60 ⇒ plan, sonst regel): bei einem Deckel 0 fehlt keine
  LEISTUNG, es HÄLT etwas — und der Kunde muss den Hebel erkennen können. Ein
  „wartet auf Leistung" schickte ihn zur Anschlussgrenze statt zu seiner Regel.
- **⚠ `sessionPolicy` trägt die LEGACY-Regel, und sie ist tragend** (`lastmgmt.go`
  `splitExempt`): eine Säule ohne eigene `Source` UND ohne Anlagen-Standard hat GAR
  KEINE benannte Politik — sie bleibt dann an die Bahn GEBUNDEN, statt als „schnell"
  befreit zu werden. Ohne die Unterscheidung fesselte die Bahn eines Nachbarn eine
  `schnell`-Säule (im Go-Test als echter Defekt gefunden).
- **⚠ `SourceAllowsMinimum` kommt vom SITE-Standard, nie von der einzelnen Säule**
  (`ocpp.go`): das „Sonne zuerst"-Zugeständnis ist eine ANLAGEN-Aussage; je Säule
  gerechnet hätte eine einzige `sonne_zuerst`-Säule die Mindestleistung für ALLE
  freigegeben.
- **Ohne Bindung ändert sich NICHTS**: keine `charge_point_id` im Descriptor ⇒ kein
  Halter ⇒ die Steuerart der Säule gilt wie vor P5 (in
  `TestWithoutABindingTheStationFollowsItsSourceByteForByte` festgenagelt).
- **Die Quellen-Bahn je Säule** (`charge_points[].source`/`min_kw` im retained
  `charging-config`) folgt der Regel der Allowlist: ein UNBEKANNTES Wort überspringt den
  EINTRAG, statt auf `schnell` aufzulösen — das wäre eine Netzstrom-Freigabe, die
  niemand erteilt hat.
- Beweise: `internal/lastmgmt/perstation_test.go` (5, mutationsgeprüft) ·
  `agent/ocpp_bridge_test.go` (6, an den SÄULEN gemessen) · Rig
  `test/e2e-ocpp.sh` L14a–d (ein ZWEITER Kern mit eigener Registry — die Brücke deckelt,
  befreit und tritt ohne Halter zurück; die Wünsche reisen über `cmd/vp-mqtt-pub`, ein
  reines Rig-Werkzeug, das in KEIN Kunden-Image gehört).

