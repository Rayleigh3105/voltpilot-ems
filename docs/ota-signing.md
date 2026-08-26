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
4. **Der RELEASE-Schlüssel liegt seit dem 04.08.2026 in CI** (Captain-Order
   „git tag → fertig", die Entscheid D3 bewusst revidiert). Die **kalte Wurzel
   nicht** — und genau diese Trennung trägt den Rest: siehe den nächsten
   Abschnitt.
5. Unterschrieben werden **die exakten rohen Bytes** der Manifest-Datei — die
   Signatur liegt **daneben** (`release.json.sig`), nie darin.

### Warum ein heißer Release-Schlüssel vertretbar ist

Die Revision von D3 ist kein Nachgeben, sondern ein Tausch mit vier
Gegenleistungen. **Alle vier müssen gelten; fällt eine weg, ist der Tausch
nicht mehr bezahlt:**

1. **Die kalte Wurzel bleibt offline beim Owner.** CI sieht sie nie. Ein
   missbrauchter Release-Schlüssel wird durch ein **neues root-signiertes
   Trust-Set** entwertet (§7.1) — ohne dass ein einziges Gerät angefasst werden
   muss und ohne dass ein Angreifer daran etwas ändern kann.
2. **Das Register-Konto darf ausschließlich REGISTRIEREN.** Es trägt die
   Realm-Rolle `edge-release-publisher` und erreicht damit genau zwei Routen
   (`GET …/edge-releases/next-seq` und `POST …/edge-releases`). Kein Rollout,
   keine Welle, kein Geräte-Ziel, nicht einmal die Flotten-Ansicht. Das steht
   **serverseitig** (`AdminEdgeReleaseController`, plus die Rückfallebene in
   `SecurityConfig`) und wird Endpunkt für Endpunkt nachgewiesen
   (`AdminApiTest.theReleasePublisherAccountMayOnlyRegisterAndReachesNoDevice`).
   Ein übernommener Runner kann die Release-LISTE verunreinigen — er erreicht
   **kein Gerät**.
3. **Der Mensch-Akt bleibt Mensch-Akt.** Was eine Anlage tatsächlich erreicht,
   ist ein *Rollout*, und den startet ein Portal-Admin im Portal
   (Plattform → Edge-Updates). Es gibt aus CI keinen Weg dorthin.
4. **Nichts in einem Wirkpfad hängt an CI** (§6-Doktrin, unverändert). Schläft
   der Runner, taucht das Release eben **später** in der Liste auf; ein
   laufender Rollout wartet nie auf ihn, und der Handpfad (§4b) bleibt
   vollständig gültig.

Dazu die Eigenschaft, die zwei davon überhaupt erst wirksam macht: **das Gerät
prüft selbst.** Ein Manifest ohne gültige Kette zur eingebackenen Wurzel wird
abgelehnt, egal wer es eingetragen hat — das Register „segnet" nichts (§4c).

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

**Beide nach `edge-app/ota/` kopieren und committen** (sie sind öffentlich, und
der Release-Lauf braucht sie für seine Gegenprüfung — `edge-app/ota/README.md`).

Die Wurzel kann danach wieder offline verschwinden. Sie wird nur für
Trust-Set-Änderungen gebraucht.

---

## 4. Ein Release veröffentlichen: `git tag` → fertig

```bash
git tag -a edge-2026.08.0 -m 'Solarman-Lesepfad gehaertet.
Keine /data-Migration.'
git push origin edge-2026.08.0
```

**Das ist alles.** Der Tag-Lauf von `.forgejo/workflows/edge-images.yaml` macht
danach in dieser Reihenfolge:

1. baut beide Images multi-arch (Versionsstempel `<tag>-<kurzsha>`),
2. liest die Digests der **Manifest-Listen** aus der Registry zurück (die
   Registry ist die Wahrheit darüber, was unter dem Tag liegt),
3. holt die **nächste Sequenznummer aus dem Register**
   (`GET /api/v1/admin/edge-releases/next-seq`),
4. erzeugt das Manifest (`vp-ota manifest`, deterministisch),
5. **signiert** es mit dem Release-Schlüssel aus dem CI-Geheimnis,
6. **prüft die Kette gegen die EINGEBACKENE Wurzel** (`vp-ota verify --root
   baked`) — dieselbe Prüfung, die jedes Gerät fährt, nur vorgezogen. Fällt sie
   durch, geht **nichts** hinaus,
7. hängt `release.json`, `release.json.sig`, `trust-set.json`,
   `trust-set.json.sig` an die Forgejo-Release,
8. trägt das Release ins Portal-Register ein.

**Was NICHT passiert — und mit Absicht nie aus CI passiert:** kein Rollout wird
gestartet, keine Welle freigegeben, keinem Gerät ein Ziel zugewiesen. Das
bleibt Portal → Plattform → Edge-Updates.

### 4.1 Die Eingaben und wo sie herkommen

| Feld | Quelle | Warum dort |
|---|---|---|
| `release` | der Tag-Name | — |
| `release_seq` | **das Register** (`next-seq`) | Sie steht IM signierten Manifest, also muss sie VOR dem Signieren feststehen — die api kann sie nicht erst beim Eintragen vergeben. |
| `target_commit` | der Commit des Tags | — |
| Artefakt-Digests | die **Registry** | Was dort liegt, ist die Wahrheit; ein Tag wäre kein Pin. |
| `state_schema` | `edge-app/core/otastate.schema` | Eine Eigenschaft des **Codes** — sie gehört in denselben Commit wie die Änderung, die sie nötig macht. |
| `min_from_seq` | Tag-Annotation `min-from-seq=<n>`, sonst **0** | Siehe den Kasten unten. |
| `notes` | der Fließtext der Tag-Annotation | Reist im selben Objekt, das den Lauf ausgelöst hat. |
| `urgent`, `allow_downgrade` | Tag-Annotation `urgent=true` / `allow-downgrade=true` | Seltene, bewusste Ausnahmen. |
| `signing_key_id` | **aus der Schlüsseldatei** | Manifest und Signatur können so gar nicht auseinanderlaufen. |

Eine Tag-Annotation sieht damit z. B. so aus:

```
Solarman-Lesepfad gehaertet.
min-from-seq=9
Keine /data-Migration.
```

Nur die **vier bekannten Schlüssel** gelten als Anweisung; jede andere Zeile —
auch eine mit Gleichheitszeichen — bleibt Fließtext und wird zur Release-Notiz.

> **Annotierten Tag nehmen (`git tag -a`).** Ein *leichter* Tag zeigt direkt auf
> den Commit, also liest der Lauf dessen **Commit-Nachricht** als Annotation.
> Das ist meist harmlos, aber eine Commit-Nachricht wurde nie als Anweisung
> geschrieben — und genau deshalb ist die Direktiv-Liste auf vier Schlüssel
> begrenzt.

> **⚠ `min_from_seq` ist standardmäßig 0, und das ist eine bewusste
> Entscheidung.** Die Order sagte „Vorgabe = vorherige Sequenz (keine
> Sprung-Erzwingung)" — unter `otaverify` sind das aber **zwei verschiedene
> Dinge**: ein Boden auf der Vorgänger-Nummer BLOCKIERT jedes Gerät, das ein
> Release übersprungen hat (`verify.go`: `cur < min_from_seq` ⇒ `deferred`), und
> genau das passiert regelmäßig — ein Rollout hält bei einem Fehlschlag an,
> eine Box ist ein paar Tage offline. Wir nehmen deshalb die
> sicherheitswahrende Lesart der Klammer: **kein Boden = keine
> Sprung-Erzwingung.** Ein Release, das wirklich eine Zwischenstufe braucht
> (etwa eine `/data`-Migration), setzt ihn ausdrücklich per
> `min-from-seq=<n>` in der Tag-Annotation. Umgekehrt lässt sich die andere
> Lesart mit **einer** Zeile herstellen (Repo-Variable `EDGE_MIN_FROM_SEQ`).

### 4.2 Wenn der Lauf abbricht

| Abbruch | Bedeutung | Was zu tun ist |
|---|---|---|
| `… trust-set.json fehlt` | Das root-signierte Trust-Set ist nicht im Repo. | Zeremonie §3.4 fahren, beide Dateien nach `edge-app/ota/` committen (`edge-app/ota/README.md`). |
| `Token vom Portal abgelehnt` | Dienstkonto falsch, deaktiviert oder Secret veraltet. | Einrichtung §4d prüfen. **Kein** stiller Rückfall auf eine Repo-Variable. |
| `Gegenpruefung … fehlgeschlagen` | Die Kette passt nicht zur eingebackenen Wurzel. | Das Release würde auf **jedem** Gerät abgelehnt. Schlüssel/Trust-Set prüfen — es geht nichts hinaus. |
| `release_seq muss groesser …` | Zwischen `next-seq` und dem Eintragen kam ein anderes Release. | Lauf wiederholen; er holt die neue Nummer. |
| `Release '…' ist bereits registriert` | Dieselbe Version, **abweichende** Bytes. | Nie überschreiben — neuen Tag ziehen. (Eine **bytegleiche** Wiederholung ist ein stilles 200.) |

Der Lauf ist **wiederholbar**: eine vorhandene Forgejo-Release wird
wiederverwendet, ein gleichnamiges Asset ersetzt, und eine bytegleiche
Registrierung ist ein 200 statt eines 409.

### 4b. Der Handpfad (unverändert gültig)

Er bleibt der Weg, wenn der Runner schläft, wenn die Automatik nicht
eingerichtet ist, oder wenn man ein Release bewusst offline erzeugen will.
Fehlt eines der Geheimnisse, **läuft der CI-Job grün durch, signiert nichts**
und druckt genau diese Schritte.

Digests notfalls direkt aus der Registry:

```bash
docker buildx imagetools inspect --format '{{.Manifest.Digest}}' \
  git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core:<voller-sha>
```

#### 4b.1 Manifest lokal erzeugen

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

#### 4b.2 Unterschreiben

```bash
vp-ota sign --key rel-2026-a.key --domain release --in release.json
```

Das erzeugt `release.json.sig`, legt `register.json` daneben und **druckt die
beiden nächsten Befehle** (Forgejo-Assets + Register-Eintrag) fertig aus.

Das Werkzeug erzwingt dabei die Rollentrennung: die Wurzel kann kein Release
unterschreiben, ein Release-Schlüssel kein Trust-Set, und ein Manifest, das einen
anderen `signing_key_id` nennt, wird gar nicht erst unterschrieben.

#### 4b.3 Gegenprüfen, bevor irgendetwas hinausgeht

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

#### 4b.4 Assets anhängen und ins Register eintragen

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

> **Historisch:** hier stand bis zum 04.08.2026 „warum der Register-Eintrag
> nicht aus CI kommt". Diese Begründung ist mit der Captain-Order bewusst
> abgelöst — nicht widerlegt: sie zielte auf ein **Portal-ADMIN**-Token in CI,
> und genau das gibt es weiterhin nicht. Das Konto, das jetzt einträgt, kann
> ausschließlich eintragen (§1, Punkt 2 der Gegenleistungen). Der Handpfad mit
> dem eigenen Admin-Token bleibt daneben gültig.

### 4c. Was die api mit dem Eintrag macht

Sie legt die Manifest- und Signatur-Bytes
**unverändert** ab (Spalte `text`, niemals `jsonb` — das würde Schlüsselreihen-
folge und Leerraum normalisieren und die Signatur lautlos unprüfbar machen) und
prüft **Widerspruchsfreiheit** (Version/Sequenz/Commit/Schlüssel müssen zum
signierten Manifest passen). **Sie prüft die Signatur nicht** — der einzige
Verifizierer, auf den es ankommt, ist das Gerät mit seiner eingebackenen Wurzel.
Ein Register, das ein Manifest „segnet", erzeugte Sicherheitsgefühl an einer
Stelle, die nichts garantieren kann.

Eine **bytegleiche** Wiederholung derselben Version beantwortet sie mit **200**
und dem gespeicherten Eintrag (ein erneut gestarteter CI-Job hinter einer
erfolgreichen Registrierung darf nicht rot werden); **abweichende** Bytes unter
derselben Version bleiben **409** — das Register ist die Papier-Spur, und zwei
verschiedene Manifeste unter einer Version wären genau die Lüge, die dort
niemand mehr bemerkt.

---

## 4d. Einmalige Einrichtung der Automatik (macht der Owner)

Vier Dinge, danach genügt `git tag`. **Bis alle vier stehen, läuft der Job grün
durch und signiert nichts** — die Automatik lässt sich also gefahrlos halb
vorbereiten.

### Schritt 1 — Trust-Set ins Repo

Aus der Zeremonie (§3.4), beide Dateien:

```bash
cp trust-set.json trust-set.json.sig  <repo>/edge-app/ota/
git add edge-app/ota/trust-set.json edge-app/ota/trust-set.json.sig
git commit -m "ota: root-signiertes Trust-Set"
```

Öffentliche Schlüssel dürfen öffentlich sein; genau dadurch ist im Git
nachlesbar, welchen Release-Schlüsseln die Flotte traut. Begründung und
Abgrenzung: `edge-app/ota/README.md`. **Ohne diese beiden Dateien bricht der
Lauf ab** — er könnte die Kette sonst nicht gegenprüfen.

**Dieselben zwei Dateien gehören einmalig ins Portal** (§6.0), damit jede neu
eingerichtete Box den Vertrauens-Anker automatisch mitbekommt. Das Repo bleibt
die reviewbare Wahrheit; das Portal ist der Auslieferpunkt.

### Schritt 2 — Keycloak: Rolle, Client, Dienstkonto

In einem **frischen** Realm-Import sind alle drei schon enthalten (der Client
kommt allerdings **deaktiviert**, siehe unten). Der bestehende Prod-Realm wurde
längst importiert, dort also von Hand — entweder in der Admin-Konsole
(`https://portal.voltpilot.de/auth/admin`, Realm `voltpilot`):

1. **Realm roles → Create role** → Name `edge-release-publisher`,
   Description „darf NUR ein signiertes Edge-Release registrieren".
2. **Clients → Create client** → Client ID `voltpilot-release-publisher`,
   Next → **Client authentication: On**, **Authorization: Off**,
   Authentication flow: **nur** „Service accounts roles" ankreuzen
   (Standard flow, Direct access grants, Implicit **aus**) → Next → Save.
3. **Clients → voltpilot-release-publisher → Credentials** → das Client secret
   kopieren (oder „Regenerate"). Das ist `VP_OTA_PUBLISHER_CLIENT_SECRET`.
4. **Clients → voltpilot-release-publisher → Service accounts roles →
   Assign role → Filter by realm roles** → `edge-release-publisher` → Assign.
   **Sonst nichts zuweisen** — das ist der ganze Punkt.

…oder mit `kcadm` (im Keycloak-Container, `docker compose exec keycloak bash`):

```bash
kcadm.sh config credentials --server http://localhost:8080/auth \
  --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"

kcadm.sh create roles -r voltpilot \
  -s name=edge-release-publisher \
  -s 'description=darf NUR ein signiertes Edge-Release registrieren'

kcadm.sh create clients -r voltpilot \
  -s clientId=voltpilot-release-publisher \
  -s publicClient=false -s serviceAccountsEnabled=true \
  -s standardFlowEnabled=false -s implicitFlowEnabled=false \
  -s directAccessGrantsEnabled=false -s enabled=true

CID=$(kcadm.sh get clients -r voltpilot -q clientId=voltpilot-release-publisher \
  --fields id --format csv --noquotes)
kcadm.sh get clients/$CID/client-secret -r voltpilot          # -> das Secret
SA=$(kcadm.sh get clients/$CID/service-account-user -r voltpilot \
  --fields id --format csv --noquotes)
kcadm.sh add-roles -r voltpilot --uid $SA --rolename edge-release-publisher
```

Gegenprobe — das Token muss die Rolle tragen **und sonst nichts Nützliches**:

```bash
TOK=$(curl -sS -X POST \
  https://portal.voltpilot.de/auth/realms/voltpilot/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=voltpilot-release-publisher \
  -d client_secret=… | sed -E 's/.*"access_token":"([^"]+)".*/\1/')

curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOK" \
  https://portal.voltpilot.de/api/v1/admin/edge-releases/next-seq   # 200
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOK" \
  https://portal.voltpilot.de/api/v1/admin/edge-updates             # 403
```

> **In einem frischen Deployment** liefert der Realm-Import den Client bereits
> mit — aber **`enabled: false`** und mit dem Secret aus
> `VP_RELEASE_PUBLISHER_SECRET` (`.env`). Fail-closed: solange niemand die
> Variable setzt, ist ein etwaiger Vorgabewert wertlos, weil ein deaktivierter
> Client gar kein Token ausgibt. Zum Einschalten: Variable setzen, Stack neu
> starten, Client in der Konsole auf **Enabled** stellen.

### Schritt 3 — die beiden Forgejo-Actions-Secrets

Repo → **Settings → Actions → Secrets**:

| Secret | Inhalt |
|---|---|
| `VP_OTA_RELEASE_KEY` | der **gesamte Inhalt** von `rel-2026-a.key` (die JSON-Datei, nicht nur das Feld) |
| `VP_OTA_PUBLISHER_CLIENT_SECRET` | das Client-Secret aus Schritt 2 |
| `VP_OTA_FORGEJO_TOKEN` | *optional* — Repo-Token mit `repo (write)` für die Release-Assets. Fehlt es, nimmt der Lauf `FORGEJO_USERNAME`/`FORGEJO_PASSWORD` (die für die Registry ohnehin da sind). |

```bash
cat rel-2026-a.key   # -> vollständig in VP_OTA_RELEASE_KEY einfügen
```

Der Schlüssel wird im Lauf in eine Datei **außerhalb des Checkouts** (0600)
geschrieben, nie auf eine Kommandozeile gelegt und am Jobende gelöscht — auch
nach einem Abbruch (`if: always()`).

### Schritt 4 — die alte Repo-Variable aufräumen

`EDGE_RELEASE_SEQ` wird nicht mehr gebraucht (die Ordnung kommt aus dem
Register) und ist nur noch der Rückfall für den Fall, dass die Automatik
**nicht** eingerichtet ist. Sie darf stehen bleiben; ein veralteter Wert stört
nicht, solange die Automatik läuft. `EDGE_STATE_SCHEMA` ist ebenfalls entbehrlich
— die Zustandsversion steht jetzt in `edge-app/core/otastate.schema`.

### Prüfen, ohne etwas zu veröffentlichen

Beide Selbsttests laufen ohne Forgejo, ohne Portal und ohne Docker:

```bash
tools/ota/test-release-publish.sh    # die Schritte einzeln, gegen einen Stub
tools/ota/test-release-workflow.sh   # der ECHTE run:-Text des Workflows
```

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

### 6.0 Das Trust-Set kommt beim EINRICHTEN automatisch

Seit dem 04.08.2026 (Captain-Order, nachdem der erste Live-Rollout mit „Das
Vertrauens-Set oder seine Signatur fehlt." abgelehnt wurde) bringt der
Installer den Vertrauens-Anker selbst mit: `install.sh` holt nach dem Start
das **aktuelle root-signierte Trust-Set** aus dem Portal und legt es unter
`/data/ota/` ab. **Der Handpfad unten bleibt vollständig gültig** — er ist der
Weg für Bestandsboxen und für den Fall, dass das Portal (noch) keines hat.

**Die Vertrauensgrenze, und sie ist der ganze Punkt:**

* **Die Installation ist ein SANKTIONIERTER TOFU-Moment.** Eine Box, die
  gerade eingerichtet wird, vertraut ihrem Installationskanal per Definition —
  sie hat sich soeben ihre **Images** darüber geholt. Das Trust-Set über
  denselben Kanal auszuliefern fügt **kein neues Vertrauen** hinzu: die Box
  prüft die Root-Signatur weiterhin **selbst** gegen ihre eingebackene Wurzel,
  der Kanal transportiert nur öffentliches Material.
* **Der spätere Austausch bleibt out-of-band.** Eine **laufende** Box holt sich
  **nie** ein Trust-Set über das Netz — das wäre der Widerrufs-Anker über genau
  den Kanal, den er widerruft. Der Core kennt die Route nicht; `update.sh`
  **erkennt** ein fehlendes Set und **nennt** den Weg, lädt aber keines
  herunter. Die Verteil-Entscheidung für eine **Rotation** (§7.1) ist davon
  unberührt und bleibt offen.

**Einmalig je Flotte** trägt der Betreiber das Set ins Portal ein (danach
bekommt es **jede** neue Box automatisch):

```bash
# Im Verzeichnis mit den beiden Dateien aus der Zeremonie (§3.4) - identisch
# mit edge-app/ota/ im Repo bzw. den Assets der Release edge-2026.08.0.
python3 - > /tmp/trust-set-payload.json <<'PY'
import json
print(json.dumps({"trustSet":  open("trust-set.json").read(),
                  "signature": open("trust-set.json.sig").read()}))
PY

curl -fsS -X PUT "https://portal.voltpilot.de/api/v1/admin/edge-trust-set" \
  -H "Authorization: Bearer $VP_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/trust-set-payload.json

# Gegenprobe - exakt das, was eine neue Box beim Einrichten lädt (anonym):
curl -fsS https://portal.voltpilot.de/api/v1/edge/trust-set/trust-set.json | diff - trust-set.json \
  && echo "bytegleich"
```

Das `python3` dient **nur** dem JSON-Verpacken für den Upload — die
**Ausliefer**-Routen geben die **rohen Bytes** heraus (`…/trust-set.json` und
`…/trust-set.json.sig` heißen wie die Zieldateien), damit der Installer
schlicht schreibt, was er lädt, und nirgends eine Zeichenkette dekodieren muss.
Genau dort entstünden sonst die stillen Byte-Abweichungen, an denen die
Signatur scheitert.

Die api legt die Bytes **unverändert** ab und prüft nur die FORM (parst?
`alg` = ed25519? Domain `trust-set`? steckt die Wurzel fälschlich im Set?) —
**die Signatur prüft sie bewusst nicht**, denn der einzige Verifizierer, auf
den es ankommt, ist das Gerät mit seiner eingebackenen Wurzel (dieselbe
Doktrin wie beim Register, §4c). Hochladen dürfen der Portal-Admin **und** das
schmale Veröffentlichungs-Konto (`edge-release-publisher`) — es entsteht in
derselben Zeremonie wie der Release-Schlüssel; mehr erreicht diese Rolle
dadurch nicht.

**Auf einer BESTANDSBOX** (vor dieser Automatik eingerichtet) genügt danach
ein Befehl im Deploy-Verzeichnis — der Ersatz für den bisherigen
scp-Zweizeiler, ausdrücklich eine Handlung des Betreibers an genau dieser Box:

```bash
./install.sh --refresh-trust
```

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
4. **Trust-Set ablegen** — auf einer Bestandsbox einmalig, danach nie wieder
   (eine NEU eingerichtete Box bringt es seit §6.0 selbst mit):
   ```bash
   ./install.sh --refresh-trust
   ```
   Ohne `install.sh` im Deploy-Verzeichnis der Handpfad, die zwei Dateien aus
   `edge-app/ota/` auf die Box kopieren und dann:
   ```bash
   docker compose cp trust-set.json     core:/data/ota/trust-set.json
   docker compose cp trust-set.json.sig core:/data/ota/trust-set.json.sig
   ```
   ⚠ **Immer die DATEIEN kopieren, nie das Verzeichnis.** `docker cp` eines
   Verzeichnisses setzt den Besitzer des ZIELVERZEICHNISSES auf die uid des
   Hosts (nachgemessen); `/data/ota` gehörte danach nicht mehr dem
   unprivilegierten Core-Benutzer, und der könnte weder `target.json` (seine
   Zuweisung) noch `current.json` (den bezeugten Stand) schreiben.
5. **Wurzel bestätigen:** ein Testpaket nach Abschnitt 5 ablegen und prüfen,
   dass `ota_reason` **verifiziert** meldet. Meldet es „kein Vertrauensanker",
   trägt das Image die Wurzel nicht — dann stimmt der Digest nicht. Meldet es
   „Das Vertrauens-Set oder seine Signatur fehlt.", fehlt Schritt 4 (genau
   diesen Grund erkennt auch `update.sh --from-target` und druckt den Weg).
6. **Der Crossover-Stand steht seit Stufe 4 im PORTAL** — jedes Gerät meldet
   seine Vertrauens-Identität im Herzschlag, und unter **Plattform →
   Edge-Updates** trägt die Flotten-Matrix je Gerät eine Spalte *Vertrauen*
   (`gekreuzt ✓` / `Crossover offen` / `unbekannt`) plus die ruhige Zeile
   „Crossover offen: n Geräte". Die handgeführte Liste ist damit nur noch
   Beiwerk. **`unbekannt` heißt „älterer Stand", nie „nicht gekreuzt"** — ein
   Gerät, das die Identität gar nicht meldet, ist kein Befund.
7. **Bei Problemen zurück:** auf den in Schritt 1 notierten Digest pinnen und
   erneut `update.sh`.

Zwischen zwei Boxen liegt bewusst ein Abstand (mindestens ein voller Tageslauf
auf der ersten Box, Canary = Pilsting), damit ein Fehler nicht die ganze Flotte
erwischt.

### Das Trust-Set bleibt out-of-band — auch in Stufe 2

Seit Stufe 2 kommt das **Release** über den Downlink (retained auf
`ems/{t}/{s}/{d}/v2/update`). Das **root-signierte Trust-Set** kommt weiterhin
NICHT über diesen Weg, sondern liegt je Box im Datenverzeichnis: es ist der
Widerrufs-Anker, und den Widerruf über denselben Kanal zu verteilen, über den
auch die widerrufenen Sachen kamen, ist eine Kreisabhängigkeit. Ein Gerät ohne
Trust-Set lehnt eine Zuweisung deshalb **fail-closed** ab und sagt das als
Grund — sichtbar in der Geräte-Zeile, nie stillschweigend.

**Die Einrichtungs-Automatik (§6.0) ändert daran nichts** — sie ist genau
deshalb an die INSTALLATION gebunden und nicht an die Laufzeit:

| | Wer holt? | Wann? | Warum zulässig |
|---|---|---|---|
| **Einrichtung** (`install.sh`) | der Installer, einmal | während der Installation | die Box vertraut ihrem Installationskanal ohnehin (sie hat ihre **Images** darüber geholt); sie prüft die Root-Signatur **selbst** |
| **Bestandsbox** (`install.sh --refresh-trust`) | ein **Betreiber**, je Box | ausdrücklich angestoßen | der Ersatz für den scp-Zweizeiler — dieselbe beaufsichtigte Handlung, nur getippt statt kopiert |
| **Laufende Box** | **niemand** | **nie** | ein Abruf zur Laufzeit ließe den Widerrufs-Anker über den Kanal reisen, den er widerruft |

Der Core kennt die Ausliefer-Route deshalb **gar nicht**; `update.sh`
**erkennt** ein fehlendes Set (der Grund steht wörtlich in der Ablehnung) und
**nennt** den Weg, lädt aber keines herunter. Für eine **Rotation** (§7.1)
bleibt die Verteilung damit unverändert die beaufsichtigte je Box — ein
automatischer Trust-Set-Downlink ist weiterhin **bewusst nicht gebaut** und
bräuchte zusätzlich einen monotonen Zähler im signierten Set gegen Replay
(Captain-Entscheid, kein Implementierungsdetail).

---

## 6b. Ein zugewiesenes Release anwenden

**Im Regelfall gar nicht** — das erledigt die Box selbst. Plattform →
**Edge-Updates** → Release wählen → Geräte ankreuzen → **Aktualisieren**. Die
Zuweisung geht retained hinaus, die Box verifiziert sie gegen ihre eingebackene
Wurzel und tauscht. Es gibt keinen zweiten Schritt und keine Freigabe mehr;
Details in [`docs/ota-autonomie.md`](ota-autonomie.md).

### Der Rückfall: von Hand, ohne Sidecar

Nur, wenn auf der Box (noch) kein Aktualisierer läuft:

```bash
# 1. Was hat das Portal dieser Box zugewiesen, und hat sie es selbst geprüft?
curl -s http://127.0.0.1:8484/api/ota/target | jq

# 2. Genau das anwenden (die Digests kommen aus der GEPRÜFTEN Zuweisung,
#    niemals aus einer Zwischenablage):
./update.sh --from-target
```

Dieser Weg braucht keinen Sidecar - dafür hat er weder Selbsttest noch
automatische Rücknahme; er ist deshalb der RÜCKFALL, nicht der Regelfall.
`--from-target` bricht ab, wenn es keine Zuweisung gibt oder ihre Kette nicht
geprüft ist (`verdict != ok`) — die Artefakt-Digests gibt der Core dann gar
nicht erst heraus. Nach einem erfolgreichen Lauf meldet die Box den angewandten
Stand zurück (`POST /api/ota/applied`); dieser Aufruf kann ausschließlich
bestätigen, was nachweislich läuft, und hebt den Anti-Rollback-Boden nur je an.
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
| `rel-<id>.key` | Arbeitsmaschine des Owners **+ Forgejo-Secret `VP_OTA_RELEASE_KEY`** | Ja (ersetzbar — §7.1) |
| `rel-<id>.pub` | im Trust-Set | Nein |
| `trust-set.json(.sig)` | **`edge-app/ota/` (Git)** + Release-Asset + **Portal (`edge_trust_set`, der Auslieferpunkt für neue Boxen, §6.0)** + auf jedem Gerät unter `/data/ota/` | Nein |
| `release.json(.sig)` | Release-Asset + Register (`edge_release.manifest`) | Nein |
| Client-Secret des Veröffentlichers | Forgejo-Secret `VP_OTA_PUBLISHER_CLIENT_SECRET`, Keycloak | Ja (Rolle: nur registrieren) |

**In diesem Repo liegt kein einziger geheimer Schlüssel.** Alle Tests erzeugen
ihre eigenen Wegwerf-Schlüssel zur Laufzeit.

Der Release-Schlüssel liegt seit dem 04.08.2026 **zusätzlich** als CI-Geheimnis
vor — die vier Gegenleistungen dafür stehen in §1 („Warum ein heißer
Release-Schlüssel vertretbar ist"). Die **kalte Wurzel** ist davon unberührt
und bleibt der Hebel, der einen missbrauchten Release-Schlüssel entwertet.

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
* **Autoritäts-Grenze der Automatik:**
  `AdminApiTest.theReleasePublisherAccountMayOnlyRegisterAndReachesNoDevice`
  (echtes Keycloak: das Dienstkonto registriert, bekommt aber auf Rollout,
  Welle, Not-Aus, Geräte-Ziel, Flotte, Journal, Mandanten, Registry und selbst
  auf die Release-LISTE ein 403 — und sieht ohne Mandant keine einzige
  Kundenzeile, auch nicht mit gesetztem Umschalter-Header).
* **Trust-Set-Bereitstellung (§6.0):**
  `AdminApiTest.theTrustSetIsUploadedByBothRolesAndServedByteExactToAnAnonymousInstaller`
  (echtes Keycloak + echte DB: beide Rollen laden hoch, ein ANONYMER Abruf
  bekommt die „unaufgeräumten" Bytes Zeichen für Zeichen zurück, die
  Form-Prüfungen inkl. „die Wurzel gehört nie ins Set", und die
  Publisher-Rolle wird dadurch kein Stück mächtiger) —
  `edge-app/test/install-selfcheck.sh` (gegen ECHTEN Docker: `install.sh`
  holt vom Stub-Portal und legt ab; die Bytes kommen unverändert an, andere
  Dateien in `/data/ota` überleben, und **das Verzeichnis bleibt für den
  unprivilegierten Core schreibbar** — die naive Verzeichnis-Kopie fällt
  hier durch) — `edge-app/test/update-selfcheck.sh` (`update.sh` NENNT den
  Weg bei fehlendem Set und lädt nachweislich **nichts** herunter).
* **Veröffentlichungs-Schritte:** `tools/ota/test-release-publish.sh`
  (Tag-Annotation, Zustandsversion, key_id, Token, next-seq, 201/200/409 gegen
  einen Stub — plus die ECHTE Zeremonie mit `go`, byteweise zurückgelesen) und
  `tools/ota/test-release-workflow.sh` (führt den **echten `run:`-Text** des
  Workflows aus: Sequenz aus dem Register, Schlüsseldatei 0600 außerhalb des
  Checkouts, kein Geheimnis im Protokoll, Abbruch ohne Trust-Set, grüner
  Handpfad ohne Geheimnisse, kein stiller Rückfall bei abgelehntem Token).
* Kontrakt-Beispiele: `docs/contracts/examples/ota-release-manifest.*.json`
  (vom echten Geräte-Parser per Pfad gelesen).
