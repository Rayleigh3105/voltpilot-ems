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
| `anschluss_fall` | Code des Zustands am Anschluss, solange kein Lauf arbeitet (Tabelle „Fälle am Anschluss“); fehlt, solange ein Lauf arbeitet |
| `anschluss_loesung` | die Lösung dazu, Form wie `lauf.loesung` |
| `lauf` | der laufende oder zuletzt beendete Lauf: `kennung`, `freigabe`, `box_art`, `box` (Kennung der Box, sobald sie feststeht), `beginn`, `ende`, `zustand` (`laeuft`, `wartet`, `fertig`, `angehalten`), `schritt`, `titel`, `erledigt` (Kennungen der erledigten Schritte; immer eine Liste, `[]` solange nichts erledigt ist), `grund`, `handgriff`, `wartet_auf`, `hinweis`, `fall` und `loesung` (nur bei `angehalten`) |
| `lauf.fall` | Code, warum der Lauf anhielt (Tabelle „Fälle eines Laufs“) |
| `lauf.loesung` | `titel` (ein Satz), `schritte` (Liste, je ein Handgriff in Alltagsworten), `selbst` (true: nach den Schritten macht der Dienst von selbst weiter, ohne Knopf), `zur_seite` (true: die Box kommt zur Seite, die Technik sieht sie an) |
| `werkbank.status.strom` | Versorgung der Brücke (`vp-werkbank-status.v1`, additiv): `unterspannung_jetzt`, `unterspannung_seit_start` (fehlen, wenn der Pi es nicht meldet), `quelle` (`vcgencmd` oder `keine`) |

Fehlt `lauf`, gab es seit dem Start des Dienstes keinen.

## Regeln

- **Anzeige, kein Beweis.** Belege und das verschlüsselte Passwort stehen an der Abnahme, nie in der Ansicht. Die API weist eine Ansicht mit Schlüsselmaterial (`PRIVATE KEY`, age) ab, ebenso eine über 64 KB.
- **Alter zeigen.** Das Portal zeigt, wie alt die letzte Meldung ist; älter als 60 s heißt „der Dienst meldet sich nicht“, nie stillschweigend der alte Stand als aktuell.
- Ein Fehler beim Melden hält im Dienst nichts an; er steht einmal im Log, nicht je Takt.
- **`erledigt` ist nie `null`.** Der Dienst bis 724ebdde9 meldete einen Lauf ohne erledigten Schritt mit `null` (eine nil-Liste in Go); solche Stände hält die API je Lauf fest. Das Portal liest `null` darum als leer (`liesDienst`), die Werkbank fiel sonst in die Fehlergrenze (04.11.2026).

## Fälle

Die Codes sind Vertrag: nie umbenennen, nur neue hinzufügen. Titel und Schritte stehen im Dienst
(`services/werkstatt-dienst/internal/faelle`, ein Test hält jeden Code hier fest); `grund` und `handgriff` bleiben die
Technik-Details. „selbst“: der Dienst macht nach dem Handgriff von selbst weiter; „zur Seite“: die Box geht an die
Technik.

**Fälle am Anschluss** (`anschluss_fall`, ohne Lauf):

| Code | wann | selbst |
|---|---|---|
| `bruecke_nicht_bereit` | Status der Brücke nicht lesbar oder ihre Prüfung scheitert | ja |
| `bruecke_unterspannung` | die Brücke meldet Unterspannung, während der Dienst auf eine Box wartet (Mango am USB des Pi) | ja |
| `kein_kabel` | kein Kabel am Werkstatt-Anschluss | ja |
| `keine_box` | Kabel steckt, niemand antwortet | ja |
| `nicht_freigegeben` | keine laufende Freigabe | ja |
| `zwei_geraete` | mehrere MACs an den Box-Adressen (auch als Fall eines Laufs) | ja |
| `startet` | die Box ist zum ersten Mal da oder nimmt noch kein SSH an (Preinit-Fenster 192.168.1.1, Dropbear nach dem Netz); höchstens `StartFrist` (5 min), dann beginnt der Lauf trotzdem | ja |
| `gesperrt` | die Box hatte ihren Lauf; neu erst, wenn ihre MAC einen Takt lang weg war | ja |
| `eingerichtet` | Box unter dem LAN-Netz ohne unfertigen Lauf dieser Werkstatt: nie angefasst | nein |

**Fälle eines Laufs** (`lauf.fall`):

| Code | wann | Handgriff | selbst | zur Seite |
|---|---|---|---|---|
| `gl_passwort` | 192.168.8.1 verlangt ein Passwort (GL-Firmware schon eingerichtet, gebraucht gekauft) | Reset-Knopf 10 s | ja | nein |
| `halb_eigene` | Passwort, und ein Lauf dieser Werkstatt setzte es und übergab die Box nicht; derselbe Host-Schlüssel; im Portal nicht abgenommen, nicht gekoppelt | Reset-Knopf 10 s | ja | nein |
| `passwort_fremd` | Passwort unter 192.168.1.1, das kein Lauf dieser Werkstatt gesetzt hat | – | nein | ja |
| `box_in_gebrauch` | eigene Box, aber übergeben, abgenommen oder gekoppelt | – | nein | ja |
| `nicht_nachweisbar` | anderer Host-Schlüssel, Portal stumm, kein Portal, kein Stand eines Laufs dieser Werkstatt | – | nein | ja |
| `ssh_zu` | die Werksfirmware nimmt nach der Startfrist kein SSH an (Prüfstein PS-1 hält nicht) | Startlader (M4) | ja | nein |
| `abbild_abgelehnt` | `sysupgrade -T` der Werksfirmware scheitert | Startlader (M4) | ja | nein |
| `falsches_geraet` | kein GL-MT300N-V2 oder keine GL-Firmware unter 192.168.8.1 | – | nein | ja |
| `schon_edge_light` | Edge Light ohne Stand eines Laufs dieser Werkstatt | – | nein | ja |
| `openwrt_fassung` | frisches OpenWrt in einer anderen Fassung als die Freigabe, oder GL-Firmware unter 192.168.1.1 | Startlader (M4) | ja | nein |
| `kein_internet` | kein Internet über die Brücke (PS-12) | WLAN prüfen, Kabel kurz ab | ja | nein |
| `fassung_nicht_bereit` | Dateien der Freigabe nicht ladbar oder nicht passend | – | nein | ja |
| `uebertragung` | Prüfsumme des Abbilds auf der Box weicht ab | Kabel kurz ab | ja | nein |
| `bruecke_weg` | die Brücke war im Lauf nicht erreichbar | Pi prüfen, Kabel kurz ab | ja | nein |
| `box_weg` | die Box antwortete im Lauf nicht mehr | Strom/Kabel prüfen | ja | nein |
| `einloesen_abgewiesen` | das Portal nahm die Einlösung nicht an | – | nein | ja |
| `nicht_update_bereit` | Entscheid 5c: keine Abnahme | – | nein | ja |
| `dienst_neu_gestartet` | der Dienst startete mitten im Lauf neu (nur im Protokoll, `SchliesseOffene`) | Kabel kurz ab | ja | nein |
| `schritt_gescheitert` | jeder andere Fehler | Kabel kurz ab, beim zweiten Mal zur Seite | ja | nein |
