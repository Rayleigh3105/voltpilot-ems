# Quellen-Identität ist DETERMINISTISCH; Umbenennen ist label-only (vp-vier-erzeuger-p9)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 24).


`sources.DeterministicID` leitet die Quellen-ID aus der TRANSPORT-IDENTITÄT ab
(role + communication + ip/port + unit_id bzw. serial+mb_slave_id), sodass
Löschen + Neu-Anlegen desselben physischen Geräts auf DIESELBE `src-`ID
konvergiert — tragend für die Cloud: das Portal pinnt eine übernommene Entität
an die Quellen-ID (`measurement_point.edge_source_id`); mit Zufalls-IDs machte
jede Neuanlage dasselbe Gerät zum „Neuen Gerät" und die Re-Adoption erzeugte
eine ZWEITE Entität (der Pilsting-Geister-Erzeuger). Regeln, die halten müssen:

- Label/Intervall/kWp sind NIE Teil der Identität (Umbenennen darf die ID nicht
  ändern); die Rolle IST Teil der Identität (ein als Netz re-addiertes Gerät
  darf keinen Erzeuger-Pin wiederbeleben — das wird ehrlich als verwaister Pin
  sichtbar). Kollision mit einer EXISTIERENDEN Quelle (identische Identität
  doppelt angelegt) → Fallback `NewID()` + lauter Warn, nie ein Crash.
- **Umbenennen läuft über `PUT /api/sources/{id}`** (`Agent.RenameSource`,
  label-only, 1–64 Zeichen; Inline-Edit-Stift in `static/sources.js` — Enter
  speichert, Esc/Blur bricht ab). Niemals wieder eine Lösch+Neuanlege-UI als
  Umbenennen-Ersatz anbieten.
- Bestehende Zufalls-IDs bleiben unangetastet (die ID wird nur bei POST
  vergeben); erst ein Löschen+Neuanlegen wandert auf die deterministische ID.

Beweise: `sources_test.go TestDeterministicID…`, `agent/sources_id_test.go`
(Konvergenz nach delete+re-add, Kollisions-Fallback, Rename hält die ID),
`web_test.go TestSourcesRenameIsLabelOnly`.

