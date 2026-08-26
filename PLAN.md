# Plan: Edge-Release radikal vereinfachen — „Release wählen, Geräte wählen, fertig"

Captain-Auftrag 2026-08-26. Nachtrag: **drei** Bestandsboxen; ein einmaliger
Ein-Befehl-Handgriff je Box ist akzeptabel; Signaturprüfung + technische
Sicherungen bleiben; ein nötiger Registry-Klick wird als `blocked:` gemeldet.

---

## Das Leitprinzip in EINEM Satz

> **Jedes Tor über den ZUSTAND DES GERÄTS fällt. Jede Eigenschaft des
> SIGNIERTEN RELEASE bleibt.**

Das ist die Trennlinie, an der alles Weitere hängt. Sie ist genau die Grenze,
die der Auftrag zieht („Signaturprüfung darf bleiben, sofern sie vollautomatisch
in der CI passiert"): eine Release-Eigenschaft wird beim Takt automatisch
bewertet und braucht NIE einen Menschen am Gerät; ein Geräte-Zustands-Tor
braucht genau das.

### Das tragende Sicherheits-Argument für die entfallenen Tore

Der heute *offiziell gesegnete* Handpfad `update.sh --from-target` tauscht
**roh**: ohne Neutral-Zeit-Nachweis, ohne Interlock, ohne Selbsttest, ohne
Rücknahme. Der autonome Pfad bleibt nach diesem Umbau **strikt sicherer als
das, was wir heute von Hand tun** — Signaturkette, Images-vor-dem-Stopp,
Rückfall-Dreifachsicherung, Selbsttest und LKG-Rücknahme bleiben unangetastet.
Die entfallenen Tore verhindern also keine Gefahr, die der Handpfad nicht schon
täglich eingeht.

---

## (a) + (b) Tor-Inventar mit Fundstelle und Urteil

### A. Edge — Tore über den GERÄTE-Zustand → **ENTFERNEN**

| # | Tor | Fundstelle | Urteil |
|---|-----|-----------|--------|
| A1 | Compose-Profil `ota` (Sidecar läuft sonst gar nicht) | `edge-app/docker-compose.yml` `updater.profiles`, `install.sh generate_compose()`, `update.sh detect_ota_profile()` | **entfernen** — `updater` wird ein normaler Dienst wie `core`/`nodered` |
| A2 | Geräte-Schalter `autonomy.json` + `VP_OTA_AUTONOMOUS` | `otaapply/files.go ReadAutonomy`, `decide.go` Tor 1, `web.go` (`:8484`-Schalter), Compose-Env | **entfernen** (Code, nicht nur Default) |
| A3 | Einmal-Freigabe `ApplyRequest` (`:8484`-Taste **und** Portal-Apply) | `otaapply/apply_request.go`, `agent/ota_apply.go`, `agent/ota_apply_downlink.go`, `cloud`-Abonnent, `mqtt-ota-apply.schema.json` | **entfernen** — sie existiert nur, weil Autonomie AUS war |
| A4 | Neutral-Zeit **T** (`neutralzeit`, `neutralzeit_zu_kurz`) | `otaapply/neutral.go`, `decide.go`, `VP_OTA_NEUTRAL_VERIFIED`, `internal/neutralcal` (`:8484`-Messtest) | **entfernen als Verweigerung**. Die Wachhund-**Frist** bleibt (Arithmetik, kein Tor) mit festem sicherem Wert |
| A5 | `failed.json` Dauersperre („einmal zurückgerollt = nie wieder") | `decide.go` `Failed.Blocks`, `otaapply/files.go` | **Dauersperre entfernen**; die Datei bleibt als **Protokoll** des letzten Fehlschlags (Herzschlag/Portal zeigen ihn), eine neue Zuweisung versucht wieder |
| A6 | `kern_still` (Kern meldet seinen Zustand nicht) | `decide.go` `BlockerCoreSilent` | **entfernen** — sein einziger Zweck war zu wissen, ob gerade gesteuert wird (A4) |
| A7 | Interlock `Dispatching` + Eil-Pfad `ModeOtaNeutral` | `decide.go` `BlockerInterlock`, `ActionNeutral`, `agent/neutral.go`, Manifest-Feld `urgent` | **entfernen** — dieselbe Begründung wie A4 |
| A8 | Plattenwächter als **Verweigerung** | `decide.go` `BlockerDisk` | **umbauen**: erst automatisch aufräumen (`PlanPrune` vorziehen), dann messen. Reicht es dann nicht, ehrlich melden — das ist eine physikalische Grenze, kein Tor |
| A9 | Registry-Token je Gerät von Hand | `otaupdater/registry.go`, `docs/ota-autonomie.md` §4 | **automatisieren** — siehe (d) |

### B. Edge — Eigenschaften des SIGNIERTEN RELEASE → **BLEIBEN**

Alle vollautomatisch aus dem CI-signierten Manifest bewertet, keiner braucht je
einen Menschen am Gerät:

* Signaturkette gegen die eingebackene Wurzel (`otaverify.Verify`), Trust-Set,
  `alg`-Pinning, Domain-Trennung.
* Anti-Rollback-Boden `min_from_seq` / `allow_downgrade` — die Replay-Sicherung,
  ohne die die Signatur nichts wert wäre. In der CI steht der Boden per Vorgabe
  auf 0, blockt im Normalfall also nie.
* `compat.backends` (das Release ist gar nicht für Compose gemacht).
* `state_schema` (das Release kann unseren `/data`-Stand nicht lesen) — feuert
  ausschließlich bei einem ausdrücklichen **Rückschritt**.
* „läuft hier bereits" → `idle` (kein Tor, sondern „nichts zu tun").

### C. Edge — technisch nötige Schritte INNERHALB des Tauschs → **BLEIBEN**

Keiner davon verweigert vor dem Start; sie strukturieren den Tausch:
Images **vor** jedem Stopp holen, Digest-Gegenprüfung, dreifache
Rückfallsicherung, Brotkrume, **eine Komponente nach der anderen**, Selbsttest,
LKG-Rücknahme bei Fehlschlag, Wachhund.

### D. Cloud/Portal → **ENTFERNEN**

| # | Tor | Fundstelle | Urteil |
|---|-----|-----------|--------|
| D1 | Wellen + `BakeGate` (24 h gesund + Steuerzyklus, D4) | `ota/BakeGate.java`, `RolloutService.promote/bakeOfWave`, `POST …/promote` | **entfernen** — eine Aktualisierung erfasst alle gewählten Geräte sofort |
| D2 | Wellen-Automatik `auto_advance` | `RolloutService.setAutoAdvance`, `POST …/auto-advance`, Spalte `rollout.auto_advance` | **entfernen** (ohne Wellen gegenstandslos) |
| D3 | Auto-Halt bei `failed`/`rolled_back`/verstummt | `RolloutService.reconcile` | **entfernen als Sperre** → wird Information: die Zeile ist rot, die anderen Geräte laufen weiter |
| D4 | „höchstens EIN lebender Rollout" (409) | `RolloutService.createRollout`, partieller Unique-Index | **entfernen** |
| D5 | `pause` / `resume` / `halt` | `RolloutService`, drei Routen | **entfernen** (ohne Wellen kein Gegenstand) |
| D6 | Portal-Apply („Auf Gerät anwenden") | `RolloutService.requestApply`, `POST /devices/{id}/apply`, `ota/ApplyApproval.java`, Tabelle `device_apply_request` | **entfernen** |
| D7 | `canApply == false` → 409 | `RolloutService.requestApply` | entfällt mit D6 |
| D8 | `pinned` (Gerät bleibt, wo es ist) | `device_update_target.pinned`, `UpdateTargetRequest` | **entfernen** |
| D9 | Kanal `canary`/`stable` | `rollout.channel`, `device_update_target.channel` | **entfernen** — ohne Canary-Ring bedeutungslos |
| D10 | Zustand `wartet_auf_anwendung` (= „Sie sind dran") | `RolloutStates` | **entfernen** — niemand ist mehr dran |
| D11 | „nur ein SIGNIERTES Release ist zuweisbar" | `RolloutService.signedRelease` | **BLEIBT** — ohne Manifest hat das Gerät nichts zu prüfen |

---

## (c) Der Weg für die Bestandsboxen

`install.sh` startet den Sidecar bei einer **frischen** Installation schon heute
(`dc --profile ota up -d`). Nach A1 ist er ein normaler Dienst, also erst recht.

Für die drei Bestandsboxen: `update.sh` bezieht das Profil bisher nur ein, wenn
der Sidecar **schon läuft**. Nach dem Umbau gibt es kein Profil mehr, und
`up -d --remove-orphans` startet den `updater` als gewöhnlichen Dienst mit.

> **Der eine Handgriff je Bestandsbox (drei Stück, danach nie wieder):**
> ```
> cd /srv/voltpilot-edge && ./update.sh
> ```
> (bzw. der Deploy-Ordner der Box). Er zieht die neue `docker-compose.yml`,
> holt die Images und startet den `updater` dauerhaft mit.

## (d) Registry-Zugang — Entscheidung

`otaupdater` liest heute `<data>/ota/registry-auth.json` und fällt sonst auf die
Umgebung des Docker-Clients im Container zurück (leer). Der Host ist durch
`install.sh` bereits per `docker login` angemeldet — die Zugangsdaten liegen in
`${DOCKER_CONFIG:-$HOME/.docker}/config.json`.

**Entscheidung: automatisch ableiten statt von Hand hinterlegen.**
`install.sh` und `update.sh` lesen nach dem Login den `auths`-Eintrag der
Registry aus der Host-Konfiguration und legen ihn per `docker compose cp` als
`/data/ota/registry-auth.json` ab. Kein neues Geheimnis, kein CI-Secret, kein
Captain-Klick, und die Box heilt sich bei jedem Update selbst.

*Grenze, ehrlich:* nutzt der Host einen **Credential-Helper** (`credsStore`),
steht in `config.json` kein Klartext-Eintrag. Dann warnt der Installer laut und
nennt den EINEN bereits dokumentierten Befehl. Fällt auch das aus, melde ich den
Registry-Sichtbarkeits-Klick als `blocked:`.

## (e) Umbau-Reihenfolge

1. **Edge-Kern** — `otaapply.Decide` auf die Release-Tore eindampfen; A2/A4/A5/
   A6/A7 samt Dateien, Env und Tests entfernen; A8 umbauen.
2. **Edge-Rand** — `agent` (Apply-Downlink, Neutral-Modus, `neutralcal`),
   `:8484` (Schalter + „Jetzt anwenden"-Karte), `cloud`-Abonnent.
3. **Compose/Installer** — Profil weg, `updater` als normaler Dienst,
   Registry-Zugang automatisch, `update.sh` ohne Profil-Erkennung.
4. **Verträge** — `mqtt-ota-apply.schema.json` + Beispiele entfernen.
5. **Cloud** — `RolloutService` auf „Release + Geräte" eindampfen; `BakeGate`,
   `ApplyApproval`, Wellen/Kanal/Pin/Auto-Halt raus; Migration für die toten
   Spalten und `device_apply_request`.
6. **Portal** — EINE Fläche: Release wählen → Geräte ankreuzen → „Aktualisieren";
   je Gerät Ziel/Ist/Zustand/Grund.
7. **Tests + Doku** — Soak-Matrix (`autonomy_off` raus), Unit-/API-/Portal-Tests,
   `docs/ota-autonomie.md` neu, `ota-signing.md`/`AGENTS.md` nachziehen.
