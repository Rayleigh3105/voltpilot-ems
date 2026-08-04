# Release-Eingaben der OTA-Kette (im Repo versioniert)

Hier liegt das **root-signierte Trust-Set**, das jedes Release begleitet:

| Datei | Inhalt | Geheim? |
|---|---|---|
| `trust-set.json` | die Menge gültiger RELEASE-Öffentlichschlüssel | **nein** |
| `trust-set.json.sig` | die Signatur der kalten Wurzel darüber | **nein** |

## Warum im Repo und nicht in einem Secret

Ein öffentlicher Schlüssel **darf** öffentlich sein — genau dadurch ist im Git
nachlesbar und überprüfbar, welchen Release-Schlüsseln die Flotte gerade traut
(dieselbe Begründung wie für die eingebackene Wurzel in
`core/internal/otaverify/rootkeys.json`). Ein Secret würde denselben Inhalt
verstecken, ein drittes Geheimnis in die CI einführen und den **Widerruf
unsichtbar** machen: eine Rotation ist so ein reviewbarer Commit statt einer
stillen Änderung in einer Weboberfläche.

Ohne diese beiden Dateien kann der Release-Lauf seine **Gegenprüfung** gar nicht
fahren (`vp-ota verify --root baked --trust-set … --manifest …` braucht das Set),
also bricht er laut ab, statt ungeprüft zu veröffentlichen.

## Woher sie kommen

Aus der Zeremonie beim Owner (`docs/ota-signing.md` §3.4):

```bash
vp-ota trust-set --key rel-2026-a.pub --out trust-set.json
vp-ota sign --key root-2026-a.key --domain trust-set --in trust-set.json
vp-ota trust --root baked --trust-set trust-set.json   # Gegenprobe
```

Danach beide Dateien hierher kopieren und **committen**.

## Was hier NICHT passiert

* **Sie werden nicht eingebacken.** Das Trust-Set ist der Widerrufs-Anker; es
  liegt zur Laufzeit je Box unter `/data/ota/` und kommt dorthin
  **beaufsichtigt, pro Box** — nie über den Downlink (das wäre eine
  Kreisabhängigkeit: der Widerruf über denselben Kanal wie das Widerrufene).
  Die Kopie hier ist der Verteil-Ausgangspunkt und das Release-Asset.
* **Sie ersetzen den Rotations-Drill nicht.** Ein neues Set im Repo ändert an
  einer Box gar nichts, bevor es dort abgelegt wurde; den Fortschritt zeigt die
  Spalte *Vertrauen* im Portal (`docs/ota-signing.md` §7.1).
* **Ein geheimer Schlüssel liegt hier nie.**
