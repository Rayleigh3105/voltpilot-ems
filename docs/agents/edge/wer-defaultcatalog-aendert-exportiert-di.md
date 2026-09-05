# ⚠ Wer `DefaultCatalog()` ändert, exportiert die Vorlagen neu

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 26).


Seit Einheitsmodell Stufe 0a existiert der Geräte-Katalog ZUSÄTZLICH als
cloud-seitige Daten: `internal/inverter/templates.go` leitet aus
`DefaultCatalog()` eine Vorlage je Marke+Modell ab, und
`cmd/vp-template-export` schreibt sie in die eingecheckte Datei
`services/api/src/main/resources/componenttemplates/builtin.json`, aus der die
api ihr Vorlagen-Register füllt.

**Der Katalog hier bleibt die Wahrheit** (er entscheidet, was die Box wirklich
lesen kann) — die Datei ist nur seine Darstellung. Nach jedem Katalog-Edit:

```bash
(cd edge-app/core && go run ./cmd/vp-template-export)   # oder --check
```

`TestBuiltinTemplateExportMatchesTheCommittedFile` vergleicht Katalog und Datei
BYTEWEISE, ein vergessener Export ist also ein roter `go test ./...`-Lauf, kein
stiller Kunden-Defekt. Der Export ist deterministisch und trägt bewusst KEINEN
Zeitstempel — sonst wäre der Byte-Vergleich unmöglich. Details + die
Ehrlichkeitsregel (`channels`/`writes` sind `null`, nie `[]`, weil die Kanäle im
Decode-Profil und der Schreibweg im Steuer-Adapter wohnen) stehen in der
Wurzel-`AGENTS.md` unter „Einheitsmodell Stufe 0a".

