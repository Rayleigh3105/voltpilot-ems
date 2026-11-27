# Schaltspur eines Handeingriffs

Die Schaltspur zeigt, wo die Zeit zwischen einem Klick im Portal und dem bestätigten Zustand eines Verbrauchers hingeht (vp-schalten-3s).
Sie trägt EINE Kennung über jeden Abschnitt und ist reine Anzeige: sie steuert nichts, entscheidet nichts und ersetzt keine Rücklesung.

## Kennung

Die API vergibt je Handeingriff (Start, Stopp, „Automatik fortsetzen“) eine Spur und schickt ihre Kennung als `request_id` im Umschlag auf `ems/{t}/{s}/{d}/v2/desired`:

```
override:<entity_id>:<spur-uuid>
```

[`edge-desired.schema.json`](edge-desired.schema.json) kennt die `request_id` als die eine Korrelation je Aussendung (höchstens 128 Zeichen); jede Box behandelt sie als undurchsichtige Zeichenkette.
Der Rücknahme-Umschlag `{entity_id, withdraw:true}` trägt dieselbe Form zusätzlich als `request_id`; eine Box vor der Schaltspur überliest das Feld.

## Herzschlag der Box: `consumers.{id}.trace`

Eine Box ab dem Release mit Schaltspur meldet je Verbraucher die Spur seines JÜNGSTEN Handeingriffs, zehn Minuten lang (additiv, fehlt sonst):

| Feld | Bedeutung |
|---|---|
| `request_id` | die `request_id` des Umschlags |
| `received_at` | der Umschlag kam über die Cloud-Verbindung an |
| `admitted_at` | Schiedsrichter und Schutzregeln haben entschieden |
| `written_at` | die letzte Schaltanfrage ans Gerät kam zurück (Shelly) |
| `read_back_at` | die Rücklesung ist da |
| `outcome` | `written`, `unchanged` (der Stand lag schon an), `held` (eine Schutzregel hält den Wunsch), `failed`, `withdrawn` |
| `reason_code` | bei `held` der Grund aus dem §15-Vokabular, etwa `guard_min_on` |

Alle Zeitpunkte stehen in der Uhr der Box (RFC 3339, Millisekunden).
Ein fehlender Zeitpunkt heißt: dieser Schritt fand nicht statt (etwa bei `held` kein `written_at`), nie „sofort“.
Ein neuer Fortschritt der Spur verändert den Fingerabdruck des `consumers`-Blocks ([heizstab-shelly.md](heizstab-shelly.md)), ohne die Zeitpunkte selbst.

## Cloud: Tabelle `schaltspur`

Die API hält je Spur (V20261127120000, RLS + FORCE, Standortzaun):

- `api_eingang_at`, `gesendet_at` (PUBACK des Brokers) oder `zustellung` (warum nicht);
- je Herzschlag der Box nach dem Senden: `erste_meldung_at`, `gehalten_at` mit `grund`, `bestaetigt_at` - in der Uhr der API, beim Empfang;
- die `box_*`-Zeitpunkte und `box_urteil` aus `trace`, wenn die `request_id` passt;
- `portal_antwort_ms` und `portal_sichtbar_ms` aus der monotonen Uhr des Browsers.

„Bestätigt“ ([`SchaltSpurAbgleich`](../../../services/api/src/main/java/com/voltpilot/api/consumers/SchaltSpurAbgleich.java)) heißt: ein Herzschlag meldet den gewünschten Zustand als zurückgelesen.
Beim Heizstab über eine Ausgangsmenge sind das genau die gewünschten Ausgänge (bei „Aus“ keiner) und `running_manual`, sobald etwas an sein soll; bei jedem anderen Verbraucher `confirmed == true` und der passende Zustand.
So misst die Spur auch eine Box vor dem Release mit Schaltspur, nur ohne ihre inneren Zeitpunkte.
Dieselbe Regel misst das Portal (`consumers/schaltspur.ts`, `spurUrteil`); beide bestehen die gemeinsamen Vektoren [`schaltspur-abgleich-vectors.json`](schaltspur-abgleich-vectors.json).
Ein neuer Tipp ersetzt eine offene Spur desselben Verbrauchers (`ersetzt`); je Verbraucher bleiben die 20 jüngsten.

Lesen: `GET /api/v1/admin/sites/{siteId}/consumers/{id}/schaltspuren` (nur Plattform-Administration).
Portal-Zeiten: `POST /api/v1/sites/{siteId}/consumers/{id}/schaltspuren/{spur}/portal` mit `{antwortMs, sichtbarMs}` (Recht `handeingriff.setzen`, nur der erste Bericht zählt).
API und Box schreiben jeden Schritt zusätzlich ins Protokoll (`Schaltspur …`).

## Ablesen an einer Anlage (eine Minute)

Voraussetzung: die API mit Schaltspur ist ausgerollt; die eigenen Zeitpunkte der Box kommen erst mit einem Box-Release ab diesem Stand.

1. Als Plattform-Administration oben den Kunden suchen und „Wie der Kunde es sieht“ öffnen, dann Anlage › Aufbau › das Gerät (etwa der Heizstab).
2. Box-Software: „⋯“ › Technik & Diagnose › „Plattform-Sicht (Admin)“ › „In der Geräteakte öffnen“, Reiter „Software“.
   Vor `edge-light-2026.11.24` wartet jede Bestätigung auf den 15-s-Takt der Box; ab `edge-light-2026.11.24` kommt eine Bestätigung nach dem Schreiben sofort, eine gehaltene Antwort erst ab dem Release mit dieser Korrektur.
3. Zurück zum Gerät, einmal schalten (etwa L1 an oder aus) und warten, bis die Zeile umspringt.
4. „⋯“ › Technik & Diagnose › „Schaltspur (Admin)“: der oberste Eintrag ist dieser Tipp.

| Zeile | normal | wenn groß |
|---|---|---|
| Portal: Klick bis Antwort | unter 0,5 s | API oder Netz des Browsers langsam |
| API: Anfrage bis gesendet | unter 0,2 s | der Broker (EMQX) nimmt langsam an |
| Gesendet bis erster Herzschlag | unter 1 s mit neuer Box | bis 15 s: Box ohne sofortige Antwort (Software prüfen) |
| Box (eigene Uhr, ab Empfang) | entschieden und geschrieben in Millisekunden | „geschrieben“ groß: das Gerät im Heimnetz antwortet langsam; fehlt die Zeile, meldet die Box keine Zeitpunkte (ältere Software) |
| Gesendet bis gehalten | - | eine Schutzregel der Box hält den Wunsch (Mindestlauf/-pause): kein Fehler, das Gerät schaltet nach ihrem Ende |
| Gesendet bis bestätigt | unter 1 s | siehe die Zeilen darüber |
| Portal: Klick bis bestätigt sichtbar | unter 3 s | Abstand zu „Gesendet bis bestätigt“ ist der Takt, in dem das Portal nachfragt |

Die Uhren bleiben getrennt: die Box-Zeile rechnet nur ab ihrem eigenen Empfang, nie gegen die Uhr der API.
Im Protokoll der API steht jeder Abschnitt als `Schaltspur <id>: …`, im Protokoll der Box als `Schaltspur: …` mit derselben `request_id`.
