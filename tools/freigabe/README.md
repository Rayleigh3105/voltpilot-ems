# Tor-Prüfer der ersten UEMS-Produktfreigabe (AP-14 IP-21)

`pruefe-tor.sh` legt je Tor des Freigabeplans vor, **was belegt ist und was fehlt**.
Es öffnet kein Tor und empfiehlt auch keines — **jedes Tor öffnet der Betreiber selbst**.
Die Prüfpunkte je Tor sind die Liste aus §3.4 des entschiedenen Konzepts
„Erste Produktfreigabe“, wörtlich genommen; die Tore und Fallen stehen in
[`docs/agents/root/uems-freigabe.md`](../../docs/agents/root/uems-freigabe.md).

```sh
bash tools/freigabe/pruefe-tor.sh G0
bash tools/freigabe/pruefe-tor.sh G1 \
  --stand        /BETREIBER/freigabe-stand.yaml \
  --laeufe       /LAEUFE/surefire-reports \
  --blatt        /BETREIBER/bestandsblatt-2026-10-01.txt \
  --generalprobe /BETREIBER/generalprobe \
  --paare        /BETREIBER/q07-paare.json   # wahlfrei; Vorgabe tools/nw3-box-image/paare.json
```

| Exit | Bedeutung |
|---|---|
| 0 | kein Punkt offen — der Betreiber kann entscheiden |
| 1 | mindestens ein Punkt offen; die Zeilen nennen ihn und wer ihn liefert |
| 2 | Aufruffehler oder unlesbares Stand-Blatt (dann die Hilfe lesen) |

## Ein Urteil je Punkt, aus genau drei

| Urteil | Heißt | Blockiert |
|---|---|---|
| `belegt` | es gibt einen nachprüfbaren Beleg; die **Fundstelle** steht dabei (Datei, Commit, Datum) | nein |
| `offen: …` | was fehlt **und wer es liefert** — Crew oder Betreiber | ja |
| `nicht maschinell prüfbar: …` | was nur der Betreiber wissen kann; er hat es im Stand-Blatt mit Datum bestätigt, **das Werkzeug hat es nicht nachgeprüft** | nein |

## Ehrlichkeit vor Bequemlichkeit

Ein Beleg ist **nie** „die Datei existiert“. Was das Werkzeug tatsächlich prüft:

- **Nachweis-Klassen** (V0, NW-2, NW-4) gelten nur mit einem **grünen Surefire-Bericht
  dieses Standes**. Das Werkzeug **fährt die Klassen nicht** — es liest
  `services/api/target/surefire-reports` (oder `--laeufe <verzeichnis>`) und sagt, von
  wann der Bericht ist. Liegt dort `stand.txt` mit einem Commit, wird er gegen den
  geprüften Stand gehalten: er gilt, wenn er **derselbe Commit** ist oder ein anderer Commit
  mit **demselben Baum** (`git rev-parse <sha>^{tree}`) — so trägt der Merge-Commit auf `main`
  den eingefrorenen `uems`-Stand unter anderem SHA. Die Belegzeile nennt, welcher Fall griff;
  ein anderer Baum ist offen. Ohne die Datei trägt ein Surefire-Bericht **keinen Commit**,
  dann gilt: ein Bericht, der älter ist als der geprüfte Commit, ist kein Beleg.
  **Übersprungen ist nicht grün**, rot ist nicht grün.
- **Bestandsblatt** (M-1): eine datierte Ergebnisdatei des Betreibers, **jünger als sieben
  Tage** (`--blatt`). Die Auswertung selbst — Q03 Lage c/f erklärt, Q15 WAL-Archiv läuft —
  weiß nur er und steht im Stand-Blatt, als zwei Punkte `m1_ausgewertet` und `q15_wal_archiv`.
  M-1b ist erst bestätigt, wenn beide es sind. Q15 steht eigens, weil er auch die Zusage Z-015 der
  Bewertung trägt (`tools/bewertung/uebungen.py`, AP-20 IP-19).
- **Generalprobe** (NW-1): `probe.json` mit `exit_code` 0, 21 oder 22 **und** Z08 = 0 in
  Rubrik C und nach dem alten Start (`W1.Z08`) — erfolgreiche DELETE-Marker sind ein
  Schaden, kein bestandener Lauf. Und: eine **Migrationssumme unter einer Sekunde** ist
  kein Produktions-Beleg, sondern ein Wegwerf-Bestand; das Werkzeug sagt das und hält den
  Punkt offen. Mit so einer Zahl lässt sich kein Fenster planen.
- **Rückweg** (NW-8): `rueckweg.json` mit `exit_code` 0, bekannter `wiederherstellung_ms`
  und bytegleichem Flyway-Stand samt Q01.
- **NW-3**: **jedes** (core, palette)-Paar im Feld braucht ein Protokoll unter
  `docs/rollout/nw3-protokoll-*.json`, in dem jeder Punkt `gruen` ist; die Zeile nennt jedes
  Paar einzeln. Welche Paare im Feld laufen, sagt Q07 des Betreibers — die Liste ist ein
  Parameter: `tools/nw3-box-image/paare.json` oder `--paare <datei>`. Fehlt sie, ist NW-3
  offen. Nennt das Protokoll `core_ref`/`palette_ref` anders als die Liste, zählt es nicht.
  Ist ein Paar **aus dem Tag gebaut statt das Release-Artefakt**, sagt das Werkzeug das
  dazu. Für **GA** zählt nur ein Protokoll für ein Paar, das **nicht** in der Liste steht.
- **Gemergte Pakete** (G0): der PR-Commit muss vom geprüften Stand aus erreichbar sein.
  M-2 verlangt zusätzlich, dass `main` ein **Vorfahre** des geprüften Standes ist.

## Das Stand-Blatt des Betreibers

Was nur der Betreiber wissen kann — Pilotkunden eingewilligt, Support-Weg geprobt,
Alarm-Übung NW-6 gefahren, gitops gemergt — fragt das Werkzeug über **eine kleine, von ihm
gepflegte Datei** ab. **Nie interaktiv, nie geraten.**

Die Vorlage ist [`freigabe-stand.example.yaml`](freigabe-stand.example.yaml); **die echte
Datei gehört nicht ins Repo**, sie liegt beim Betreiber und wird über `--stand` gereicht.

```yaml
nw6_alarmuebung:
  bestaetigt: ja
  am: 2026-10-14
  durch: Betreiber
  beleg: zwoelf Alarme ausgeloest, Zustellung an "betreiber" beobachtet
```

Zwei Regeln, die das Werkzeug erzwingt:

1. **Ein Stand-Blatt-Eintrag macht einen maschinell prüfbaren Punkt niemals grün.**
   Wer NW-4 im Blatt bestätigt, während der Surefire-Bericht fehlt, bekommt weiter
   `offen`. Das Blatt beantwortet ausschließlich die Punkte, die es beantworten darf.
2. **Eine Bestätigung ohne Datum ist keine Bestätigung** (`am: JJJJ-MM-TT` ist Pflicht),
   und ein Blatt, das der Leser nicht versteht, bricht ab (Exit 2) statt zu raten.

## Prüfen

```sh
python3 -m unittest discover -s tools/freigabe -p 'test_*.py'
shellcheck tools/freigabe/*.sh
```

Die Lesefunktionen (`zaehler`, `lies_stand_txt`, `gleicher_stand`, `lies_stand`, die Leser von
`probe.json` und `rueckweg.json`) nutzt auch der Matrix-Prüfer der Bewertung
([`tools/bewertung/pruefe_matrix.py`](../bewertung/pruefe_matrix.py), AP-20 IP-4). Wer sie ändert,
fährt auch `python3 -m unittest discover -s tools/bewertung -p 'test_*.py'`.

Die Tests bauen ein Wegwerf-Repo mit genau der Geschichte, die G0 verlangt, und prüfen die
Fälle, an denen das Werkzeug scheitern könnte: alles belegt → Exit 0 · ein Beleg fehlt →
Exit 1 und die Zeile nennt ihn · roter oder übersprungener Surefire-Bericht → offen ·
Bericht von einem anderen Baum oder älteren Stand → offen, gleicher Baum unter anderem
Commit → belegt mit Nennung · NW-3 je Paar, ein fehlendes oder rotes Paar → offen · Blatt älter als sieben Tage → offen ·
Wegwerf-Generalprobe → „kein Produktions-Beleg“ · Stand-Blatt kann einen maschinellen Punkt
nicht grün machen · unbekanntes Tor → Hilfe.
