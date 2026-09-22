# Übergabe AP-15 IP-29 (Ausfallblatt NW-3) – Stand 22.09.2026, 16:25 MESZ

Bahn `vp-uems-v15-ip29-ausfallblatt`, Zweig `fm/vp-uems-v15-ip29-ausfallblatt`, Basis `origin/uems` bei `77ba77d1`
(noch nicht rebased; `origin/uems` stand bei der Übergabe auf `115b12622`). Alles ist als WIP committet, **kein
Lauf aktiv, kein Aufbau steht** (`docker ps --filter label=com.docker.compose.project=uems-verbund-ip29` ist leer).
Diese Datei ist eine Übergabe-Notiz, kein Teil des Blatts – vor dem PR löschen.

## Was gebaut ist (Werkzeug, alles unter `tools/uems-verbund-sim/`)

- `szenarien.py`: Drehbuch je Matrixzeile (`laeufe()`), Läufer `fahre` (Fenster-Tor: ≤ 2 fremde Testcontainers,
  ≥ 3 GiB frei; Bilder EINMAL je Reihe; Schnappschuss des Werkzeugs unter `$TMPDIR`; schreibt vor jedem Lauf eine
  `paused: … until <UTC>`-Zeile und danach eine `working:`-Zeile mit M-1/M-2 ins Status-Log), `blatt` (erzeugt
  `docs/rollout/gemeinsame-steuerung-ausfalltests.md`, je Bilder-Stand eine Zeile, Bandbreite bei mehreren Läufen,
  `BEOBACHTUNGEN` je (Lauf, Stempel) in den Notizen).
- `verbund.sh lauf --drehbuch`: Aktionen `stoerung`, `zurueck`, `sende`, `lokal`, `lauschen`, `anlage`, `cloud`,
  `tausch`; `VB_BILD_ZUSATZ` (Vorsatz der Bild-Marke, hier `ip29-`), `VB_BILDER_FEST`, `VB_REPO`.
- Bezugs-Punkt: Nullpunkt der führenden Box um 400 kW verschoben (`uems_verbund.NULLPUNKT_NACHT_KW`, `nutzlast.py
  --nullpunkt`), sechs echte OCPP-Säulen (`Dockerfile.ladepunkte`, `ladepunkte.sh`, `vp-ocpp-sim` unverändert),
  `VP_CONSUMER_CONTROL_ENABLED` nur dort (`VB_VERBRAUCHER=true`). **Probe am Container gelaufen**: NA-1 550,0 kW,
  Säulen auf 77 kW gedeckelt (22+22+22+11), kein Überlauf. Noch KEIN Blatt-Lauf am Bezugs-Punkt.
- `make test`: 44 passed (Tests für Drehbuch, Varianten, Nullpunkt, Blatt). `make lint`: sauber.

## Stand je Zeile

| Lauf | Stand | Protokoll | Ergebnis |
|---|---|---|---|
| R1 | fertig (1 Lauf) – **Wiederholung offen** (Bandbreite, gleicher Bilder-Stand `17abebe1c993`) | `R1-1.json` | 98,0 kW, +24,7 kW / 1 s, hält |
| A1 | fertig | `A1-1.json` | 98,053 kW, hält |
| A2 | fertig – **Befund** (Auslegung G3, beim Captain; kein Umbau) | `A2-1.json` | 100,171 kW, verletzt |
| A3 | fertig | `A3-1.json` | 98,064 kW, hält |
| A4 | fertig | `A4-1.json` | 97,899 kW, hält |
| A5 | fertig | `A5-1.json` | 98,02 kW, hält |
| A6 | nicht fahrbar (kein Planer im Aufbau, NW-4) | – | – |
| A7 | alter Stand fertig – **Befund** (vor PR 1068); **Wiederholung ×2 auf `f68d5e606` offen** | `A7-1.json` | 100,118 kW, +31,0 kW / 83 s, verletzt |
| A7x | **offen** (auf `f68d5e606`) | – | – |
| A8 | nicht fahrbar (Host-Uhr, NW-2) | – | – |
| A9 | fertig | `A9-1.json` | 97,869 kW, hält |
| A10 | fertig | `A10-1.json` | 97,63 kW, hält |
| A11 | fertig | `A11-1.json` | 98,043 kW, hält (Wächter hält den Handeingriff) |
| A12 | **wiederholen** (Lauf 1 verworfen, siehe unten) | verworfen: `$TMPDIR/ip29/verworfen/A12-1-speicher-minus60.json` | – |
| A13 | fertig | `A13-1.json` | 98,0 kW, keine Sekunde über der Grenze |
| A14 | fertig | `A14-1.json` | 98,051 kW, hält |
| A15, A18 | **offen** (Mittag) | – | – |
| A20, R1n, A2n, A7n | **offen** (Bezugs-Punkt) | – | – |

## Wo die Protokolle liegen

- **Im Repo:** `tools/uems-verbund-sim/protokolle/<Lauf>-<n>.json` (je 45–116 KB) – daraus entsteht das Blatt. Dazu
  `protokolle/nw2-77ba77d1.md`: das NW-2-Protokoll (`go test ./internal/agent/ -run TestZweiAgentenAusfallmatrix`
  auf `77ba77d1`), die Vergleichsspalte.
- **Außerhalb** (`$TMPDIR` = `/var/folders/ng/79cys2_n6kj24qghrnwgxd5m0000gn/T/`):
  - `ip29/protokolle/` – dieselben JSON wie im Repo (Quelle des Läufers).
  - `ip29/reihe1.log` – die Ausgabe der Reihe 1.
  - `uems-verbund-ip29-<Lauf>-<n>/` – Arbeitsordner je Lauf: `drehbuch/`, `drehbuch.log`, `mitschnitt.txt`,
    `core.log`, `anlage.json`, Nutzlasten; A11 zusätzlich `lokal-E-1.txt` (Mitschnitt des lokalen Busses).
  - `ip29/verworfen/A12-1-speicher-minus60.json` – der verworfene A12-Lauf.
  - `ip29/nw2/ip27-zwei-agenten-protokoll.md` – NW-2-Rohprotokoll.

## Einen Lauf starten

Aus `tools/uems-verbund-sim/`, NIE zwei Aufbauten zugleich:

```bash
VB_BILD_ZUSATZ=ip29- VB_PROJEKT=uems-verbund-ip29 python3 szenarien.py fahre A12 A15 A18 R1 \
  --protokolle "$TMPDIR/ip29/protokolle" \
  --status /Users/mvogt/IdeaProjects/firstmate/state/vp-uems-v15-ip29-ausfallblatt.status
```

- `fahre` baut die Bilder einmal (`verbund.sh bilder`) und fährt dann jeden Lauf mit `VB_BILDER_FEST=1`. Die
  Box-Marke ist der letzte Commit an `edge-app/`/`edge/sim` des Arbeitsbaums: auf `77ba77d1` → `17abebe1c993`,
  Bilder `vb-edge-core:ip29-17abebe1c993`, `vb-edge-nodered:ip29-17abebe1c993`, `vb-broker:ip29-17abebe1c993`
  (vorhanden). **Solange der Arbeitsbaum auf `77ba77d1` steht, fahren R1-Wiederholung, A12, A15, A18, A20, R1n,
  A2n, A7n auf demselben Stand wie die fertigen Zeilen** – also diese Läufe VOR dem Rebase fahren.
- Dauer: `python3 szenarien.py liste` (Messfenster + 5 min Anlauf + ~4 min Auf-/Abbau je Lauf; A20 60 min).
- Nach jedem Lauf den neuen `$TMPDIR/ip29/protokolle/*.json` nach `tools/uems-verbund-sim/protokolle/` kopieren.

## A12-Korrektur

Lauf 1 hatte den Speicher von Box Halle 1 mit −60 kW für den Markt entladen lassen → 120 kW, ein Fehler des
Aufbaus, nicht der Box. NW-2 fährt A12 mit `e1PlanHeute` (Plan von heute, gegen die Grenze gerechnet: Speicher
0 kW). Korrigiert in `nutzlast.py alle(ohne_anteile=True)`: nur `v2/entities` + v1-Fahrplan mit Speicher 0 kW
(`speicher_kw("heute")`), auch im Viertelstunden-Takt (`VB_ZUSTELLUNG=ohne_anteile` wirkt über die Umgebung auf
`cloud_takt`). Test: `test_varianten_der_nutzlasten`. A12 einfach neu fahren.

## A7/A7x-Wiederholung auf `f68d5e606` (firstmate 002: PR 1068, 1075, 1078)

Erst NACH allen Läufen auf dem alten Stand. Dann:

```bash
git fetch origin && git rebase origin/uems        # oder genau: auf einen Stand, der f68d5e606 enthält
git log -1 --format=%h -- edge-app edge/sim       # neue Marke; muss f68d5e606 oder später sein
```

Die Marke kommt aus dem Arbeitsbaum. Firstmate will Bilder aus **genau** `f68d5e606`: ist die neue Marke ein
späterer Box-Commit, die Bilder aus einem eigenen Arbeitsbaum auf `f68d5e606` bauen
(`git worktree add $TMPDIR/ip29/f68 f68d5e606`, dort `VB_BILD_ZUSATZ=ip29- tools/uems-verbund-sim/verbund.sh bilder`)
und im Blatt den Commit nennen. Dann `szenarien.py fahre A7 A7 A7x …` (aus dem Arbeitsbaum, dessen Box-Marke den
Bildern entspricht). Das Blatt stellt die A7-Läufe je Stempel in eigene Zeilen (alt `17abebe1c993`, neu).
`BEOBACHTUNGEN[("A7", "<neuer Stempel>")]` in `szenarien.py` nachtragen.

## Was zum fertigen Blatt noch fehlt

1. Läufe: R1 (Wiederholung), A12, A15, A18, A20, R1n, A2n, A7n auf `17abebe1c993`; A7 ×2 und A7x auf `f68d5e606`.
2. `make blatt-md NW2=protokolle/nw2-77ba77d1.md` (oder `python3 szenarien.py blatt --protokolle protokolle --nw2
   protokolle/nw2-77ba77d1.md --aus ../../docs/rollout/gemeinsame-steuerung-ausfalltests.md`).
3. `BEOBACHTUNGEN` für A12/A15/A18/A20 und den Bezugs-Punkt ergänzen, wo die Zahlen es nicht selbst sagen.
4. PR-Text: Befunde vorn (A2 Auslegung; A7 alt verletzt / neu; A12-Aufbaufehler behoben), `make test`-Zahl,
   `shellcheck -S warning`, Protokolle committet (≤ 200 KB je Lauf), `copy.test.ts` auf `77ba77d1`: 89 passed.
   Box-/Cloud-Code unberührt, kein Katalog-Wächter nötig.
5. Diese Datei löschen, `git fetch && git rebase origin/uems`, PR über
   `config/fm-forgejo-pr.sh <worktree> fm/vp-uems-v15-ip29-ausfallblatt uems "<titel>" <body>`; vorher
   `git push -u origin fm/vp-uems-v15-ip29-ausfallblatt`.
