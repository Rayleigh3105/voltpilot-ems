# Werkstatt: Ansicht des Werkstatt-Dienstes (v1)

Was der [Werkstatt-Dienst](../../services/werkstatt-dienst/README.md) gerade sieht und tut, für die Werkstatt-Bildschirme im Portal (Entscheid WI-8 A). Der Dienst meldet sie jeden Takt mit `PUT /api/v1/werkstatt-dienst/ansicht` (Rolle `werkstatt-dienst`); das Portal liest sie mit `GET /api/v1/admin/werkstatt/dienst` (nur `platform-admin`). Es ist dieselbe Ansicht wie die eigene Anzeige des Dienstes (`/zustand.json`).

Vektor: [`werkstatt-ansicht-v1.example.json`](werkstatt-ansicht-v1.example.json). Ihn erzeugt `TestAnsichtVektor` (`services/werkstatt-dienst/internal/dienst`) Byte für Byte aus den echten Strukturen; `WerkstattAnsichtVertragTest` (API) und der Test der Werkstatt-Bildschirme im Portal lesen ihn. Go-Struktur, Formprüfung der API, Typen des Portals und Vektor ändern sich nur gemeinsam. Dazu erzeugt `TestAnsichtZustaende` [`werkstatt-ansicht-v1.zustaende.json`](werkstatt-ansicht-v1.zustaende.json): die Ansicht in jedem Zustand eines Laufs (Brücke ohne/mit Kabel, jeder Schritt laufend, „Dein Schritt“, angehalten, Startlader, fertig), aus dem Dienst mit Attrappe der Brücke und der Schrittfolge des echten Laufs; der Test der Werkstatt-Bildschirme zeichnet jeden davon.

## Felder

| Feld | Bedeutung |
|---|---|
| `schema` | `vp-werkstatt-ansicht.v1` |
| `zeit` | wann der Dienst die Ansicht bildete (RFC 3339) |
| `werkbank` | die Brücke: `adresse`, `bereit`, `grund` (wenn nicht bereit), `fassung_soll`, `host_schluessel`, `status` (wie `vp-werkbank-status.v1`: `werkstatt.kabel` = Kabel am Werkstatt-Anschluss, `antworten` = wer an den Box-Adressen antwortet), `status_zeit`, `einrichten` |
| `freigabe` | `laufend`, `grund` (wenn keine läuft), `freigabe` (Schema `vp-werkstatt-freigabe.v1`), `boxen` (wie viele unter ihr eingerichtet) |
| `anschluss` | in Alltagsworten, was am Werkstatt-Anschluss steckt |
| `lauf` | der laufende oder zuletzt beendete Lauf: `kennung`, `freigabe`, `box_art`, `box` (Kennung der Box, sobald sie feststeht), `beginn`, `ende`, `zustand` (`laeuft`, `wartet`, `fertig`, `angehalten`), `schritt`, `titel`, `erledigt` (Kennungen der erledigten Schritte; immer eine Liste, `[]` solange nichts erledigt ist), `grund`, `handgriff`, `wartet_auf`, `hinweis` |

Fehlt `lauf`, gab es seit dem Start des Dienstes keinen.

## Regeln

- **Anzeige, kein Beweis.** Belege und das verschlüsselte Passwort stehen an der Abnahme, nie in der Ansicht. Die API weist eine Ansicht mit Schlüsselmaterial (`PRIVATE KEY`, age) ab, ebenso eine über 64 KB.
- **Alter zeigen.** Das Portal zeigt, wie alt die letzte Meldung ist; älter als 60 s heißt „der Dienst meldet sich nicht“, nie stillschweigend der alte Stand als aktuell.
- Ein Fehler beim Melden hält im Dienst nichts an; er steht einmal im Log, nicht je Takt.
- **`erledigt` ist nie `null`.** Der Dienst bis 724ebdde9 meldete einen Lauf ohne erledigten Schritt mit `null` (eine nil-Liste in Go); solche Stände hält die API je Lauf fest. Das Portal liest `null` darum als leer (`liesDienst`), die Werkbank fiel sonst in die Fehlergrenze (04.11.2026).
