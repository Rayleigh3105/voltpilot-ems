# Plan-Quittung 1.0 (AP-15 IP-10, Regeln P3 und Y3)

Verbindlich: [Schema](mqtt-plan-result.schema.json), [Vektoren](plan-result-vectors.json).
Die Box urteilt über jeden Plan 2.0 fachlich und meldet das Urteil auf
`ems/{tenant_id}/{site_id}/{device_id}/v2/plan-result`, QoS 1, **retained**
(das letzte Urteil der Box, wie `measurement-config-status`). Der Topic liegt im
`v2/#`-Teilbaum der Box; die Broker-ACL erlaubt ihn bereits
(`AclGrantWriter`, ein `v2/#` je Gerät) — keine ACL-Änderung.

## Wann die Box quittiert

- nach jeder Annahme eines `…/v2/plan` (auch bei der retained Wiederzustellung nach
  einem Neuverbinden — das Urteil ist dasselbe, die Cloud schreibt idempotent);
- nach jeder Ablehnung, mit einem `grund` aus dem geschlossenen Vokabular unten.
- Eine leere retained Nachricht (Löschen des Plans) ist kein Plan und wird nicht quittiert.
- Der beim Start von der Platte geladene Plan ist keine Zustellung und wird nicht quittiert.

## Felder

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `schema_version` | ja | `"1.0"` |
| `tenant_id`, `site_id`, `device_id` | ja | müssen dem Topic gleichen (Topic- und Payload-Identität) |
| `ts` | ja | wann die Box geurteilt hat (Box-Uhr, RFC 3339) |
| `angenommen` | ja | `true` = der Plan ist der wirksame Plan der Box |
| `grund` | nur bei `false` | Grund der Ablehnung (geschlossen, siehe unten); bei `true` verboten |
| `plan_id` | wenn lesbar | Kennung des beurteilten Plans; fehlt nur, wenn die Box sie nicht lesen konnte |
| `generated_at` | wenn lesbar | Echo des `generated_at` des beurteilten Plans |
| `lauf_nr` | wahlfrei | Echo der Laufnummer, sobald der Plan sie trägt (IP-15); heute nie gesendet |
| `anteile_revision` | wahlfrei | Revision der wirksamen Anteile (IP-17); heute nie gesendet |

Weitere Felder werden von der Cloud überlesen (additive Erweiterung).

## Gründe einer Ablehnung (geschlossen)

| `grund` | Wann (Go `plan2.Parse` bzw. Agent) |
|---|---|
| `unlesbar` | kein JSON-Objekt; `plan_id` fehlt dann in der Quittung |
| `schema_version_unbekannt` | `schema_version` ist nicht `"2.0"` |
| `slot_minutes_ungueltig` | `slot_minutes` < 1 |
| `keine_entitaeten` | keine Entität bzw. keine Entität mit verwertbarem Slot |
| `fremde_box` | `device_id` im Plan nennt eine andere Box |

Ein neues Wort braucht einen Eintrag hier, in den Vektoren, in Go (`plan2.Grund*`), in Java
(`PlanResultListener.GRUENDE`) und im CHECK von `plan_zustellung` im selben Release.

## Cloud: `plan_zustellung`

Je Box und Plan eine Zeile (`device_id`, `plan_id`), RLS mit `FORCE`:

- **veröffentlicht** schreibt der Optimierer direkt nach dem Senden auf `…/v2/plan`
  (`veroeffentlicht_um`, `generated_at`);
- **angenommen/abgelehnt** schreibt die api beim Empfang der Quittung (`urteil`, `grund`,
  `quittiert_um` = `ts` der Box, `empfangen_um` = Uhr der Cloud).

Beide schreiben per Upsert; wer zuerst ankommt, legt die Zeile an. Eine ältere Quittung
überschreibt kein jüngeres Urteil derselben Zeile. Die Cloud verwirft eine Quittung mit
fremder Identität, unbekanntem Grund, Grund bei Annahme, fehlendem Grund bei Ablehnung,
für eine Box außerhalb ihres Standorts und ohne `plan_id` (sie ist keinem Plan zuzuordnen).

**Veröffentlicht gegen angenommen** (Fall R11): je Box der zuletzt veröffentlichte und der
zuletzt angenommene Plan, beide über `generated_at` geordnet — „erzeugt 10:15 · angenommen
10:00“ heißt: die Box fährt noch den Plan des Laufs davor.

**Alte Box:** sie sendet keine Quittung und keinen Block. Ihre Zeilen tragen nur
„veröffentlicht“; „angenommen“ bleibt leer. Daraus folgt heute kein Alarm, keine Ablehnung
und kein anderes Flottenbild — Metriken und Alarmregeln zur Quittung sind IP-11.

## Spiegel im Herzschlag (Y3)

`ems/{tenant_id}/{site_id}/{device_id}/status` bleibt `schema_version: "1.0"`. Der
wahlfreie Block `gemeinsame_steuerung` erscheint nur, solange die Box einen Plan 2.0 mit
`plan_id` hält (angenommen oder nach einem Neustart von der Platte geladen), und fehlt wieder
nach dem Löschen des Plans. Eine Box ohne Plan 2.0 sendet ihren Herzschlag wie zuvor
(bis auf den neuen Namen in `supports[]`):

| Feld | heute | Bedeutung |
|---|---|---|
| `plan_id` | ja | Kennung des wirksamen (zuletzt angenommenen) Plans 2.0 |
| `waechter.einspeisung` | wenn ein Einspeisewächter läuft | Stufe wie `export_guard.state` (`aus`, `ueberwacht`, `regelt`, `haelt`, `zieht_zusammen`, `sicherheitskappe`) |
| `waechter.bezug` | nie (IP-18) | Stufe des Bezugswächters, gleiches Vokabular |
| `messpunkt_alter_s` | wenn gemessen | Alter der jüngsten verwertbaren Messung am eigenen Messpunkt in Sekunden |
| `rolle` | nie (IP-17) | `fuehrt` · `steuert_mit` · `liest` |
| `anteile_revision` | nie (IP-17) | Revision der wirksamen Anteile |

Der Block spiegelt, er entscheidet nichts: die Cloud liest ihn heute nicht; die
Status-Zuhörer überlesen ihn, Lebenszeichen, Quellenstatus und Fähigkeiten bleiben gleich.

## Fähigkeit

`plan_quittung` in `supports[]` ([Fähigkeiten](edge-supports.md)): die Box sendet Quittung
und Block. Sie wird **gemeldet**, nicht über `edge-capabilities.json` abgeleitet — wie
`events` und `automation_paused_until_revoked`, damit Bestandsboxen keinen neuen
„Update nötig“-Hinweis bekommen.
