# Ladequelle je Säule im Herzschlag

Der Status-Herzschlag der Box (`ems/{tenant_id}/{site_id}/{device_id}/status`, alle 15 s, nicht retained) trägt seit 23.10.2026 an jeder Säule des Blocks `chargers` drei additive Felder: welche Bahn die Box für diese Säule fährt.
Damit kann das Portal nach „So laden“ ehrlich sagen, ob die Box die Wahl übernommen hat (Konzept k1 „Gewählt ist nicht geladen“, Regel 4: gesendet › Box hat übernommen › Wirkung gemessen).
Fälle und Lesarten aller drei Seiten: [Vektoren](ladepunkt-quelle-echo-vectors.json).

```json
"chargers": [{"id": "CP-WERKSTATT", "source": "nur_sonne", "storage_release": true, "connectors": [...]}]
```

| Feld | Bedeutung |
|---|---|
| `source` | Die Bahn, die die Box fährt: `nur_sonne`, `sonne_zuerst` oder `schnell`. Die eigene Wahl der Säule, sonst die der Anlage; ein fehlendes oder unbekanntes Wort fährt die Box als `schnell` und meldet es auch so. |
| `storage_release` | „Sonne + Speicher“: darf die Box für diese Säule Speicherenergie freigeben? Reist mit `source` immer mit, ausdrücklich `false`; `true` nur neben `nur_sonne`. |
| `min_kw` | Eigene Mindestleistung der Säule, nur neben `sonne_zuerst` und nur, wenn eine gesetzt ist. |

Das Echo nennt die Säulen-Bahn, nicht die Ladekarte: ein Fahrzeug-Profil, das eine Sitzung umstellt, ändert die Bahn der Säule nicht.

## Leser

| Seite | Regel | Ort |
|---|---|---|
| Box (schreibt) | Bahn wie die Entscheidung aufgelöst (`SourceOrSite`, `NormalizePolicy`) | `edge-app/core/internal/agent/ocpp.go` (`ocppInfo`), `ocpp_heartbeat.go` |
| API (speichert, vergleicht) | Unbekanntes Wort wird verworfen. Spalten `applied_source`, `applied_min_kw`, `applied_storage_release` an `device_charge_point`. Der Vergleich mit der Wahl in `site_charge_point_allowlist` (die das retained Dokument trägt) ist `quelleUebernommen` an jeder Säule von `GET /api/v1/sites/{siteId}/chargers`: `true`, `false` oder `null` (ältere Box, keine Wahl je Säule) | `ChargerStatusListener`, `QuellenEcho`, Migration `V20261023180000` |
| Portal (zeigt) | „Box hat übernommen“ nur bei `true` aus einer Meldung, die jünger ist als das Senden; `false` erst nach zwei Minuten als Abweichung, vorher „noch nicht bestätigt“; `null` heißt „meldet die Übernahme noch nicht“ | `frontend/portal/src/steuerung/rueckmeldung.ts` |

„Günstig“ fährt seit #1569 die Bahn `nur_sonne`; das Preisfenster führt der Plan aus (`SteuerartProjektion.bahnAus`). Der Vergleich liest die gespeicherte Bahn, nicht die Ladequelle, und folgt damit jeder Änderung dieser Abbildung von selbst. Meldet eine „Günstig“-Säule ohne frischen Plan `kein_ueberschuss`, sagt das Portal „Wartet auf günstigen Preis“.

## Verträglichkeit

- Eine ältere Box schickt die Felder nicht. Die API speichert `null`, `quelleUebernommen` ist `null`, und das Portal sagt „noch nicht bestätigt“ statt einer erfundenen Bestätigung.
- Eine ältere API ignoriert die Felder; der Herzschlag bleibt sonst byte-gleich.
- Neue Bahn-Wörter sind ein Vertragswechsel: Box, API (`ChargerStatusListener.POLICIES`, CHECK der Spalte), Portal und die Vektoren ändern sich zusammen.
