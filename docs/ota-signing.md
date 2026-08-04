# OTA-Signaturkette: Zeremonie, Release, Verlust, TOFU

> **Stufe 3 „Autonom" (das Anwenden ohne Menschen am Gerät) hat ein eigenes
> Betreiber-Handbuch: [`ota-autonomie.md`](ota-autonomie.md).** Es ist gebaut
> und im Labor geprüft - und nirgendwo eingeschaltet.

Betreiber-Handbuch zu **OTA Stufe 1 „Vertrauen"** (Scout `vp-ota-rollout-h4` §5/§8/§9,
Captain-Entscheide D1–D6). Es beschreibt genau eine Sache: **wie ein Edge-Release
unterschrieben wird und wie ein Gerät diese Unterschrift prüft.**

> **Was Stufe 1 NICHT tut: sie wendet nichts an.** Es gibt weiterhin keinen
> Schreibpfad zu irgendeinem Gerät, keinen Downlink und keinen Updater. Ein
> Gerät kann ein Release nach dieser Anleitung nur **prüfen und melden**
> („Release edge-2026.08.0 verifiziert, Anwendung erst in Stufe 2/3").
> Verteilt wird in Stufe 2, angewandt in Stufe 3 — und beides ist ab jetzt
> kryptografisch gedeckt.

Kontrakte: [`contracts/ota-release-manifest.schema.json`](contracts/ota-release-manifest.schema.json)
und [`contracts/ota-signature.schema.json`](contracts/ota-signature.schema.json).
Werkzeug: `edge-app/core/cmd/vp-ota`. Verifizierer auf dem Gerät:
`edge-app/core/internal/otaverify`.

---

## 1. Das Vertrauensmodell in fünf Sätzen

1. Es gibt **eine kalte Wurzel** (Root-Schlüssel). Sie liegt offline beim Owner,
   war nie auf einem Server und signiert **ausschließlich Trust-Sets**.
2. Es gibt **einen (oder mehrere) Release-Schlüssel**. Sie signieren die
   täglichen Releases. Welche gültig sind, sagt das **Trust-Set** — und das gilt
   nur, wenn die kalte Wurzel es unterschrieben hat.
3. Der **öffentliche** Teil der Wurzel ist im Core-Image **eingebacken**
   (`edge-app/core/internal/otaverify/rootkeys.json`, im Git nachlesbar). Ein
   Gerät vertraut nur dem, was dort steht.
4. **Es gibt keinen heißen Schlüssel in CI** (Entscheid D3). CI baut Images und
   erzeugt ein *unsigniertes* Manifest; unterschrieben wird offline beim Owner.
   Ein übernommener CI-Runner kann damit **kein vertrauenswürdiges Release
   erzeugen**.
5. Unterschrieben werden **die exakten rohen Bytes** der Manifest-Datei — die
   Signatur liegt **daneben** (`release.json.sig`), nie darin.

### Warum die Signatur abgetrennt ist

Ein `signature`-Feld *im* Manifest müsste sich über sich selbst berechnen. Man
müsste es zum Prüfen entfernen und den Rest neu serialisieren — und genau diese
Re-Serialisierung ist die Lücke: Schlüsselreihenfolge, Unicode-Escapes,
Zahlenformat, doppelte Schlüssel. Deshalb:

**Die zu signierenden Bytes sind:**

```
signing_input = kontext || dateibytes
```

* `dateibytes` = der Inhalt der Datei **Byte für Byte**, einschließlich jedes
  Leerzeichens, jeder Einrückung und eines etwaigen abschließenden
  Zeilenumbruchs. Es wird **nichts** normalisiert, umformatiert oder neu
  serialisiert — auf keiner Seite.
* `kontext` = `voltpilot-ota-release-v1\n` für ein Manifest bzw.
  `voltpilot-ota-trust-set-v1\n` für ein Trust-Set (Domain-Trennung: ohne sie
  wären beide „irgendein JSON mit Ed25519", und ein root-signiertes Trust-Set
  ließe sich als Manifest wiedereinspielen).

Erzeugt werden diese Bytes an **einer einzigen Stelle** im Code
(`otaverify.SigningInput`) — Signierwerkzeug und Gerät rufen dieselbe Funktion,
also können die beiden Seiten nicht auseinanderlaufen.

**Praktische Folge:** eine signierte Datei darf danach **nie** umformatiert,
durch `jq` geschickt, in eine `jsonb`-Spalte gelegt oder aus einem CI-Log
kopiert werden. Sie reist als Bytes oder gar nicht.

### Warum Ed25519

Standardbibliothek von Go (der Verifizierer läuft auf dem Gerät, und der Core
soll dafür **keine neue Abhängigkeit** bekommen), deterministisch, 32-Byte-
Schlüssel, 64-Byte-Signaturen, keine ASN.1-/Parameter-Fläche, aus der bei
RSA/ECDSA wiederholt Umgehungen entstanden sind. `minisign` ist darunter
dasselbe Ed25519, `cosign` brächte einen ganzen Abhängigkeitsbaum.

Der Algorithmus ist **fest verdrahtet**: ein anderer Wert im `alg`-Feld ist eine
Ablehnung, kein Fallback. (Ein Verifizierer, der den Algorithmus aus dem Dokument
übernimmt, lässt sich herunterhandeln — die klassische JWT-`alg`-Lücke.)

### Warum ein monotoner Boden statt einer Uhr

Ein Raspberry Pi hat keine gepufferte Uhr. Nach einem Stromausfall mit
blockiertem NTP kann seine Zeit beliebig falsch sein — ein zeitbasierter
Rückschritt-Schutz wäre dort wirkungslos oder sperrte das Gerät aus.

* **`min_from_seq`** (Ganzzahl) ist der **primäre** Anti-Rollback-Boden: ein
  Gerät unterhalb dieses Stands darf das Release nicht direkt anwenden (ihm
  fehlt eine Zwischenstufe, etwa eine `/data`-Migration).
* **`allow_downgrade`** unterscheidet den **gewollten** Tief-Rollback vom
  **Replay** eines alten, echt signierten Manifests durch einen
  Netzwerk-Angreifer. Ohne dieses Flag wird ein Release, das nicht neuer ist als
  der laufende Stand, abgelehnt.
* **`valid_until`** ist **nur ein Hinweis** und führt **nie** zu einer
  Ablehnung.
* **Widerruf** eines Schlüssels läuft ebenfalls uhrunabhängig: ein **neues,
  root-signiertes Trust-Set ohne diesen Schlüssel**. Das optionale `not_after`
  ist bestenfalls best effort, weil es an der Geräteuhr hängt.

---

## 2. Werkzeug bereitlegen

```bash
cd edge-app/core
go build -o ~/bin/vp-ota ./cmd/vp-ota
vp-ota --help
```

Alternativ ohne Installation: `go run ./cmd/vp-ota <befehl> …` aus
`edge-app/core`.

---

## 3. Einmalige Zeremonie (offline, beim Owner)

> **Diese Schritte laufen auf der Maschine des Owners, nicht in CI und nicht in
> einem Container mit Netz.** Ein USB-Datenträger oder ein verschlüsselter
> lokaler Ordner ist der richtige Ort für den Wurzel-Schlüssel.

### 3.1 Kalte Wurzel erzeugen

```bash
mkdir -p ~/voltpilot-ota && cd ~/voltpilot-ota
vp-ota keygen --id root-2026-a --role root --out .
```

Es entstehen zwei Dateien:

| Datei | Inhalt | Umgang |
|---|---|---|
| `root-2026-a.key` | **GEHEIM** (Modus 0600) | Offline-Datenträger, mindestens zwei Kopien an getrennten Orten. Nie kopieren auf einen Server, nie committen, nie in ein Backup mit Cloud-Sync. |
| `root-2026-a.pub` | öffentlich | Wandert ins Repo (nächster Schritt). |

Das Werkzeug **überschreibt niemals** eine vorhandene `.key`-Datei — das wäre der
eine Bedienfehler, der eine Wurzel unwiederbringlich vernichtet.

### 3.2 Wurzel ins Image einbacken

Den `public_key`-Wert aus `root-2026-a.pub` in
`edge-app/core/internal/otaverify/rootkeys.json` eintragen und **committen**:

```json
{
  "schema_version": "1.0",
  "keys": [
    {
      "key_id": "root-2026-a",
      "alg": "ed25519",
      "public_key": "<der Wert aus root-2026-a.pub>",
      "comment": "Kalte Wurzel, erzeugt 2026-08, offline beim Owner"
    }
  ]
}
```

Ein öffentlicher Schlüssel **darf** öffentlich sein — genau dadurch ist im Git
nachlesbar und überprüfbar, welcher Wurzel ein Image traut.

Danach den Wächter in `edge-app/core/internal/otaverify/verify_test.go` auf die
erwartete Wurzel festnageln — er ist absichtlich so geschrieben, dass er genau
in diesem Moment auffällt, und nagelt danach `key_id` **und** Schlüsselwert
fest, damit ein stiller Wurzeltausch die CI nie passiert. Erst ein **neu
gebautes Core-Image** trägt die Wurzel.

> **Gelaufen am 04.08.2026:** eingebacken ist `root-2026-a`; festgenagelt von
> `TestBakedRootIsExactlyTheCeremonyRoot` (otaverify) und, für den Sidecar, von
> `TestWithoutAnInjectedRootTheBakedAnchorIsUsed` (otaupdater).

### 3.3 Release-Schlüssel erzeugen

```bash
vp-ota keygen --id rel-2026-a --role release --out . \
  --comment "Release-Schluessel 2026"
```

Der geheime Teil bleibt beim Owner (er darf auf der Arbeitsmaschine liegen — er
ist ersetzbar, die Wurzel nicht).

### 3.4 Trust-Set bauen und mit der Wurzel unterschreiben

```bash
vp-ota trust-set --key rel-2026-a.pub --out trust-set.json
vp-ota sign --key root-2026-a.key --domain trust-set --in trust-set.json
```

Ergebnis: `trust-set.json` + `trust-set.json.sig`. **Beide Dateien** gehören zu
jedem Release-Paket dazu — ohne sie kennt das Gerät den Release-Schlüssel nicht.

Die Wurzel kann danach wieder offline verschwinden. Sie wird nur für
Trust-Set-Änderungen gebraucht.

---

## 4. Ein Release unterschreiben (pro Release)

### 4.1 Tag setzen, CI die Images bauen lassen

```bash
git tag edge-2026.08.0 && git push origin edge-2026.08.0
```

Der Tag-Lauf von `.forgejo/workflows/edge-images.yaml` baut beide Images
multi-arch (der Versionsstempel wird automatisch `<tag>-<kurzsha>`) und gibt im
Job **„Digests + Prüfsumme"** aus:

* die beiden `@sha256:`-Digests der Manifest-Listen,
* die `sha256`-Prüfsumme des unsignierten `release.json`.

Der Job braucht die Repo-Variable **`EDGE_RELEASE_SEQ`** (die nächste freie
Sequenznummer des Registers) — fehlt sie, bricht er laut ab, statt eine
Reihenfolge zu erfinden. Optional: `EDGE_MIN_FROM_SEQ`, `EDGE_STATE_SCHEMA`,
`EDGE_SIGNING_KEY_ID`.

> **Nichts im Wirkpfad hängt an diesem Lauf.** Der Forgejo-Runner schläft
> nachweislich ein. Wenn er nicht läuft: die Digests direkt aus der Registry
> holen und weiter mit 4.2.
>
> ```bash
> docker buildx imagetools inspect --format '{{.Manifest.Digest}}' \
>   git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:<voller-sha>
> ```

### 4.2 Manifest lokal erzeugen

**Aus einem CI-Log wird nicht kopiert** (Leerraum/Zeilenenden könnten sich
ändern und die Signatur zerstören). Die Ausgabe von `vp-ota manifest` ist
deterministisch — dieselben Eingaben ergeben byteweise dieselbe Datei:

```bash
vp-ota manifest \
  --release edge-2026.08.0 \
  --seq 12 \
  --commit 3bf8c038a1b2 \
  --artifact core=git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:… \
  --artifact nodered=git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered@sha256:… \
  --min-from-seq 9 \
  --state-schema 3 \
  --key-id rel-2026-a \
  --notes "Solarman-Lesepfad gehaertet; keine /data-Migration." \
  --out release.json

sha256sum release.json    # muss der Prüfsumme aus dem CI-Log entsprechen
```

Feldbedeutungen stehen im Kontrakt; die drei, bei denen man nachdenken muss:

* `--seq` — die **nächste** Nummer des Registers. Die Ordnung ist monoton.
* `--min-from-seq` — der Boden. Faustregel: der Stand, ab dem ohne
  Zwischenschritt aktualisiert werden darf. Im Zweifel der Stand des ältesten
  Geräts, das noch im Feld ist.
* `--state-schema` — die `/data`-Zustandsversion, die dieses Release verträgt.

### 4.3 Unterschreiben

```bash
vp-ota sign --key rel-2026-a.key --domain release --in release.json
```

Das erzeugt `release.json.sig`, legt `register.json` daneben und **druckt die
beiden nächsten Befehle** (Forgejo-Assets + Register-Eintrag) fertig aus.

Das Werkzeug erzwingt dabei die Rollentrennung: die Wurzel kann kein Release
unterschreiben, ein Release-Schlüssel kein Trust-Set, und ein Manifest, das einen
anderen `signing_key_id` nennt, wird gar nicht erst unterschrieben.

### 4.4 Gegenprüfen, bevor irgendetwas hinausgeht

```bash
vp-ota verify --root baked \
  --trust-set trust-set.json --manifest release.json
```

`--root baked` prüft gegen die Wurzel, die **in diesem Repo eingebacken** ist —
also genau die Prüfung, die ein Gerät durchführen wird. (Solange die Zeremonie
nicht gelaufen ist, ist sie leer und der Befehl sagt das; dann mit
`--root root-2026-a.pub` gegen die konkrete Wurzel prüfen.)

Mit `--current-seq <n>` lässt sich zusätzlich durchspielen, wie ein Gerät auf
einem bestimmten Stand urteilen würde (Boden, Rückschritt).

### 4.5 Assets anhängen und ins Register eintragen

Beide Befehle druckt `vp-ota sign` fertig aus. Der Vollständigkeit halber:

```bash
export FORGEJO_TOKEN=…      # Repo-Token, Rechte: repo (write)
REL=$(curl -sS -X POST https://git.tecmaxx.de/api/v1/repos/mamotec/voltpilot-ems/releases \
  -H "Authorization: token $FORGEJO_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tag_name":"edge-2026.08.0","name":"edge-2026.08.0"}' \
  | sed -E 's/.*"id":([0-9]+).*/\1/')

for f in release.json release.json.sig trust-set.json trust-set.json.sig; do
  curl -sS -X POST \
    "https://git.tecmaxx.de/api/v1/repos/mamotec/voltpilot-ems/releases/$REL/assets?name=$f" \
    -H "Authorization: token $FORGEJO_TOKEN" -F "attachment=@$f"
done
```

```bash
export VP_ADMIN_TOKEN=…     # das eigene Portal-Admin-Token
curl -sS -X POST https://portal.voltpilot.de/api/v1/admin/edge-releases \
  -H "Authorization: Bearer $VP_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @register.json
```

**Warum der Register-Eintrag nicht aus CI kommt:** er begleitet die
**Unterschrift**, und die entsteht per D3 offline. Ein Portal-Admin-Token in CI
wäre genau der heiße Schlüssel, den D3 vermeidet — und ein Wirkpfad, der auf
einen schlafenden Runner wartet.

**Was die api mit dem Eintrag macht:** sie legt die Manifest- und Signatur-Bytes
**unverändert** ab (Spalte `text`, niemals `jsonb` — das würde Schlüsselreihen-
folge und Leerraum normalisieren und die Signatur lautlos unprüfbar machen) und
prüft **Widerspruchsfreiheit** (Version/Sequenz/Commit/Schlüssel müssen zum
signierten Manifest passen). **Sie prüft die Signatur nicht** — der einzige
Verifizierer, auf den es ankommt, ist das Gerät mit seiner eingebackenen Wurzel.
Ein Register, das ein Manifest „segnet", erzeugte Sicherheitsgefühl an einer
Stelle, die nichts garantieren kann.

---

## 5. Auf einem Gerät prüfen (beaufsichtigt)

In Stufe 1 gibt es **keinen Downlink**. Der Prüfpfad ist eine Datei — und genau
so wird der Sidecar der Stufe 3 später erneut verifizieren.

```bash
# auf der Box, im Datenverzeichnis des Cores (Volume vp-edge-data)
mkdir -p /data/ota
# release.json, release.json.sig, trust-set.json, trust-set.json.sig hineinkopieren
```

Der Agent prüft danach spätestens **alle 30 s** und meldet das Ergebnis:

```bash
curl -s http://127.0.0.1:8484/health | jq '{version, ota_state, ota_reason}'
```

| `ota_reason` | Bedeutung |
|---|---|
| `Release edge-2026.08.0 (Stand 12) verifiziert, signiert mit 'rel-2026-a'. Anwendung erst in Stufe 2/3.` | Kette und Politik in Ordnung. **Es passiert nichts weiter** — das ist der Endzustand dieser Stufe. |
| `Release edge-2026.08.0 ist verifiziert und laeuft hier bereits.` | Dieses Gerät fährt bereits diesen Stand. |
| `Release … setzt mindestens Stand 9 voraus, hier laeuft 8 …` | Anti-Rollback-Boden: eine Zwischenstufe fehlt. Signatur war in Ordnung. |
| `Release … ist nicht neuer als der laufende Stand … nicht als Rueckschritt freigegeben.` | Replay-Schutz. Ein gewollter Rückschritt braucht `--allow-downgrade`. |
| `Release … ist nicht fuer das Apply-Backend 'compose' bestimmt …` | Falsches Backend — kein Rateversuch. |
| `… ist nicht gueltig signiert …` / `… nicht gueltig root-signiert …` | **Sicherheitsereignis.** Kette gebrochen. |
| `Diesem Stand ist kein Vertrauensanker eingebacken …` | Das Image ist älter als die Zeremonie (Abschnitt 3.2). |

Dasselbe steht im 15-s-Herzschlag im `update`-Block (`state` + `reason`) und
damit in der Cloud.

**Der eigene Stand (`current.json`) ist optional.** Solange ihn nichts schreibt
(erst Stufe 3 tut das), sagt der Verifizierer ehrlich, dass der Boden nicht
bewertbar war, statt eine Sequenznummer zu erfinden. Für einen gezielten Test
kann man ihn von Hand hinlegen:

```json
{ "release": "edge-2026.07.2", "release_seq": 11 }
```

*Ehrliche Grenze:* diese Datei ist integritätsrelevanter **lokaler** Zustand,
kein Vertrauensanker — wer `/data` beschreiben kann, kann den Boden absenken.
Dort liegt allerdings ohnehin die Geräteidentität (`device.key`). Der
uhrunabhängige Widerruf bleibt das root-signierte Trust-Set.

---

## 6. TOFU-Crossover: das erste schlüsseltragende Image je Box

Ein Gerät, das heute läuft, hat **keine eingebackene Wurzel** — es kann also
nicht prüfen, ob das Image, das ihm die Wurzel bringt, echt ist. Das ist ein
echter **Trust-on-First-Use**-Moment, und er wird nicht wegdefiniert, sondern
beaufsichtigt durchgeführt.

**Die Regel: pro Box, von Hand, über den alten `update.sh`-Weg — niemals als
Flotten-Fan-out.** Ein Fan-out wäre genau die Verteilung ohne Prüfung, gegen
die die ganze Kette gebaut ist.

### Checkliste je Box

1. **Vorher notieren**, was läuft (das Rollback-Ziel):
   ```bash
   curl -s http://127.0.0.1:8484/health | jq '{ref, version, pairing_state, cloud_connected}'
   docker compose images
   ```
2. **Digest prüfen, nicht Tag:** in der Registry nachsehen, welcher Digest zum
   Ziel-Tag gehört, und **diesen** pinnen:
   ```bash
   ./update.sh --core-image git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:…
   ```
   (`update.sh` erkennt das Deploy-Modell selbst und druckt am Ende die
   laufenden Digests als Rollback-Ziel — siehe `edge-app/DEPLOY.md`.)
3. **Gesundheit abwarten:** `/health` meldet wieder `cloud_connected: true`, im
   Portal steht die Anlage auf online, und mindestens **ein echter Steuerzyklus**
   ist gelaufen (die Pilsting-Regel). Kein Weitermachen mit der nächsten Box,
   bevor diese Box gesund ist.
4. **Wurzel bestätigen:** ein Testpaket nach Abschnitt 5 ablegen und prüfen,
   dass `ota_reason` **verifiziert** meldet. Meldet es „kein Vertrauensanker",
   trägt das Image die Wurzel nicht — dann stimmt der Digest nicht.
5. **Der Crossover-Stand steht seit Stufe 4 im PORTAL** — jedes Gerät meldet
   seine Vertrauens-Identität im Herzschlag, und unter **Plattform →
   Edge-Updates** trägt die Flotten-Matrix je Gerät eine Spalte *Vertrauen*
   (`gekreuzt ✓` / `Crossover offen` / `unbekannt`) plus die ruhige Zeile
   „Crossover offen: n Geräte". Die handgeführte Liste ist damit nur noch
   Beiwerk. **`unbekannt` heißt „älterer Stand", nie „nicht gekreuzt"** — ein
   Gerät, das die Identität gar nicht meldet, ist kein Befund.
6. **Bei Problemen zurück:** auf den in Schritt 1 notierten Digest pinnen und
   erneut `update.sh`.

Zwischen zwei Boxen liegt bewusst ein Abstand (mindestens ein voller Tageslauf
auf der ersten Box, Canary = Pilsting), damit ein Fehler nicht die ganze Flotte
erwischt.

### Das Trust-Set bleibt out-of-band — auch in Stufe 2

Seit Stufe 2 kommt das **Release** über den Downlink (retained auf
`ems/{t}/{s}/{d}/v2/update`). Das **root-signierte Trust-Set** kommt weiterhin
NICHT über diesen Weg, sondern liegt beim Crossover je Box im Datenverzeichnis:
es ist der Widerrufs-Anker, und den Widerruf über denselben Kanal zu verteilen,
über den auch die widerrufenen Sachen kamen, ist eine Kreisabhängigkeit. Ein
Gerät ohne Trust-Set lehnt eine Zuweisung deshalb **fail-closed** ab und sagt
das als Grund — sichtbar in der Flotten-Matrix, nie stillschweigend.

---

## 6b. Ein zugewiesenes Release anwenden (Stufe 2, beaufsichtigt)

Ab Stufe 2 entscheidet das **Portal**, welches Release eine Box bekommt; die
Box prüft es selbst und legt es ab. **Angewandt wird weiterhin von Hand am
Gerät** — ein autonomer Apply-Pfad ist Stufe 3.

```bash
# 1. Was hat das Portal dieser Box zugewiesen, und hat sie es selbst geprüft?
curl -s http://127.0.0.1:8484/api/ota/target | jq

# 2. Genau das anwenden (die Digests kommen aus der GEPRÜFTEN Zuweisung,
#    niemals aus einer Zwischenablage):
./update.sh --from-target
```

`--from-target` bricht ab, wenn es keine Zuweisung gibt oder ihre Kette nicht
geprüft ist (`verdict != ok`) — die Artefakt-Digests gibt der Core dann gar
nicht erst heraus. Nach einem erfolgreichen Lauf meldet die Box den angewandten
Stand zurück (`POST /api/ota/applied`); dieser Aufruf kann ausschließlich
bestätigen, was nachweislich läuft, und hebt den Anti-Rollback-Boden nur je an.

Im Portal steht die Box danach unter Plattform → Edge-Updates auf
**bestätigt ✓**; der Rollout gibt die nächste Welle erst frei, wenn sie 24 h
gesund läuft und (wo VoltPilot steuert) mindestens ein echter Steuerzyklus
bestätigt wurde.

---

## 7. Schlüsselverlust und Rotation

### 7.1 Release-Schlüssel ablösen — der vollständige Drill

Der günstige Fall: die kalte Wurzel löst den Release-Schlüssel ab. Der Drill
hat **fünf Schritte**, und Schritt 2 und 5 sind die, die ihn von „gut gemeint"
unterscheiden.

**Schritt 1 — neues Set erzeugen (offline, beim Owner):**

```bash
vp-ota keygen --id rel-2026-b --role release --out .
vp-ota trust-set --key rel-2026-b.pub --out trust-set-neu.json   # der alte fehlt jetzt
vp-ota sign --key root-2026-a.key --domain trust-set --in trust-set-neu.json
```

**Schritt 2 — GEGENPRÜFEN, bevor irgendetwas hinausgeht.** `vp-ota trust`
prüft das Set ALLEIN gegen die eingebackene Wurzel — es braucht dafür kein
Release, und genau deshalb gibt es diesen Unterbefehl: bis Stufe 4 hätte man
ein Manifest erfinden müssen, um seinen eigenen Widerruf zu prüfen.

```bash
vp-ota trust --root baked --trust-set trust-set-neu.json
```

Es druckt genau die Zeichenkette, die ein Gerät danach meldet
(`trust_set_key_ids`, `trust_set_generated_at`) — dieselbe, die im Portal in
der Spalte **Vertrauen** steht. **Erscheint der alte Schlüssel hier noch, ist
der Widerruf nicht passiert.**

**Schritt 3 — je Box ausliefern.** Das Trust-Set kommt **nicht** über den
Downlink (§6, „Das Trust-Set bleibt out-of-band"), sondern wird je Box ins
Datenverzeichnis gelegt — derselbe beaufsichtigte Weg wie beim Crossover:

```bash
# auf der Box, im Datenverzeichnis des Cores (Volume vp-edge-data)
cp trust-set-neu.json      /data/ota/trust-set.json
cp trust-set-neu.json.sig  /data/ota/trust-set.json.sig
curl -s http://127.0.0.1:8484/health | jq '{ota_state, ota_reason}'
```

**Eine Box nach der anderen, mit Abstand** — genau wie beim Crossover. Eine
Box, die das neue Set noch nicht hat, vertraut dem alten Schlüssel weiter; das
ist kein Fehler, sondern der Grund für Schritt 5.

**Schritt 4 — nachziehen:** `--key-id rel-2026-b` in `vp-ota manifest` und die
Repo-Variable `EDGE_SIGNING_KEY_ID`.

**Schritt 5 — den Fortschritt VERFOLGEN, statt ihn zu glauben.** Seit Stufe 4
meldet jedes Gerät seine Vertrauens-Identität im Herzschlag; im Portal unter
**Plattform → Edge-Updates** steht je Gerät, welches Set es fährt (Spalte
*Vertrauen*, Details im Geräte-Ausklapp). Der Drill ist **fertig, wenn jede
Box den neuen Stempel zeigt** — bis dahin ist der alte Schlüssel auf den
übrigen Boxen weiterhin gültig.

> Ein Gerät, das die Identität gar nicht meldet, steht auf **unbekannt**. Das
> heißt „älterer Stand", nicht „nicht gekreuzt" — es ist kein Befund und wird
> auch nicht als einer dargestellt.

### 7.1b Eine missglückte Rotation zurücknehmen

Der Rückweg ist billig, **solange die alten Dateien noch existieren** — sie
sind unverändert gültig signiert, ein Trust-Set läuft nicht ab:

```bash
# auf der betroffenen Box
cp trust-set-alt.json      /data/ota/trust-set.json
cp trust-set-alt.json.sig  /data/ota/trust-set.json.sig
curl -s http://127.0.0.1:8484/health | jq '{ota_state, ota_reason}'
```

Daraus folgen zwei Regeln für den Drill:

1. **Das alte Trust-Set NIE löschen, bevor jede Box gekreuzt ist.** Es ist der
   einzige Rückweg — und die Wurzel kann es jederzeit neu unterschreiben,
   solange sie existiert.
2. **Der alte Release-SCHLÜSSEL ist damit wieder gültig.** Wenn die Rotation
   erfolgte, WEIL er kompromittiert war, ist ein Rollback ein bewusstes
   Wiederöffnen: dann lieber vorwärts (ein drittes, frisch unterschriebenes
   Set) als zurück.

Ein Rollback der Manifest-Seite braucht es nicht: ein Release, das unter dem
neuen Set nicht mehr verifiziert, wird vom Gerät schlicht abgelehnt und nie
angewandt.

### 7.2 Kalte Wurzel verloren (kein Backup mehr)

Es können **keine neuen Trust-Sets** mehr erzeugt werden. Solange der aktuelle
Release-Schlüssel gültig ist, laufen Releases normal weiter — aber er lässt sich
nie wieder ablösen.

Der Ausweg ist eine **neue Wurzel + ein neues Image**, und das Einbringen dieses
Images ist ein erneuter TOFU-Crossover nach Abschnitt 6:

1. Neue Wurzel erzeugen (3.1), in `rootkeys.json` eintragen — die alte bleibt
   **zusätzlich** stehen, solange noch Geräte mit dem alten Image im Feld sind
   (das Root-Set ist eine Liste).
2. Neues Trust-Set mit der neuen Wurzel unterschreiben.
3. Je Box das neue Image beaufsichtigt einspielen (Abschnitt 6).
4. Erst wenn **alle** Boxen gekreuzt haben: die alte Wurzel aus `rootkeys.json`
   entfernen.

### 7.3 Kalte Wurzel kompromittiert

Der teure Fall. Behandeln wie 7.2 — **zusätzlich** muss die alte Wurzel in
Schritt 1 sofort entfernt werden, statt stehen zu bleiben. Jede Box braucht dann
zwingend den beaufsichtigten Crossover, weil kein bestehendes Gerät der neuen
Wurzel traut. Vorher jedes seit dem vermuteten Zeitpunkt ausgelieferte Release
gegen die Registry-Digests prüfen.

### 7.4 Was in keinem Fall hilft

* **Ablaufdaten** (`not_after`): hängen an der Geräteuhr, die nicht
  vertrauenswürdig ist.
* **`valid_until` im Manifest**: nur ein Hinweis, führt nie zu einer Ablehnung.
* **Das Register in der Cloud**: prüft keine Signaturen und kann keine
  entziehen.

Der belastbare Hebel ist immer das **neu unterschriebene Trust-Set**.

---

## 8. Was wo liegt

| Datei | Ort | Geheim? |
|---|---|---|
| `root-<id>.key` | Offline-Datenträger beim Owner | **Ja — der wichtigste Schlüssel des Systems** |
| `root-<id>.pub` | `edge-app/core/internal/otaverify/rootkeys.json` (Git) | Nein |
| `rel-<id>.key` | Arbeitsmaschine des Owners | Ja (ersetzbar) |
| `rel-<id>.pub` | im Trust-Set | Nein |
| `trust-set.json(.sig)` | Release-Asset + auf jedem Gerät unter `/data/ota/` | Nein |
| `release.json(.sig)` | Release-Asset + Register (`edge_release.manifest`) | Nein |

**In diesem Repo liegt kein einziger geheimer Schlüssel.** Alle Tests erzeugen
ihre eigenen Wegwerf-Schlüssel zur Laufzeit.

---

## 9. Belege

* Verifizierer + Politik: `edge-app/core/internal/otaverify/` (`verify_test.go`
  deckt manipulierte Bytes, reine Umformatierung, fremden Schlüssel,
  nicht-root-signiertes Trust-Set, Domain-Verwechslung, `alg`-Herunterhandeln,
  Boden, Rückschritt, Backend, Ablauf-vs-Widerruf ab).
* Werkzeug-Rundlauf: `edge-app/core/cmd/vp-ota/main_test.go` (echte Zeremonie in
  einem Temp-Verzeichnis, Manipulation, falsche Wurzel, Rollentrennung,
  bytegenauer Register-Rumpf).
* Gerät: `edge-app/core/internal/agent/ota_verify_test.go`.
* Register: `AdminApiTest.aSignedReleaseIsRegisteredByteExactAndNeverContradictsItsManifest`.
* Kontrakt-Beispiele: `docs/contracts/examples/ota-release-manifest.*.json`
  (vom echten Geräte-Parser per Pfad gelesen).
