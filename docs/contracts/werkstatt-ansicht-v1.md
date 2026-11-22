# Werkstatt: Ansicht des Werkstatt-Dienstes (v1)

Was der [Werkstatt-Dienst](../../services/werkstatt-dienst/README.md) gerade sieht und tut, für die Werkstatt-Bildschirme im Portal (Entscheid WI-8 A). Der Dienst meldet sie jeden Takt mit `PUT /api/v1/werkstatt-dienst/ansicht` (Rolle `werkstatt-dienst`); das Portal liest sie mit `GET /api/v1/admin/werkstatt/dienst` (nur `platform-admin`). Es ist dieselbe Ansicht wie die eigene Anzeige des Dienstes (`/zustand.json`).

Vektor: [`werkstatt-ansicht-v1.example.json`](werkstatt-ansicht-v1.example.json). Ihn erzeugt `TestAnsichtVektor` (`services/werkstatt-dienst/internal/dienst`) Byte für Byte aus den echten Strukturen; `WerkstattAnsichtVertragTest` (API) und der Test der Werkstatt-Bildschirme im Portal lesen ihn. Go-Struktur, Formprüfung der API, Typen des Portals und Vektor ändern sich nur gemeinsam. Dazu erzeugt `TestAnsichtZustaende` [`werkstatt-ansicht-v1.zustaende.json`](werkstatt-ansicht-v1.zustaende.json): die Ansicht in jedem Zustand eines Laufs (Brücke ohne/mit Kabel, jeder Schritt laufend, „Dein Schritt“, angehalten, Startlader, fertig), aus dem Dienst mit Attrappe der Brücke und der Schrittfolge des echten Laufs; der Test der Werkstatt-Bildschirme zeichnet jeden davon. Dasselbe für einen Lauf am WAGO PFC200 erzeugt `TestAnsichtZustaendePFC200` in [`werkstatt-ansicht-v1.zustaende-pfc200.json`](werkstatt-ansicht-v1.zustaende-pfc200.json): der Anschluss ohne Antwort (mit dem Handgriff „feste Adresse“), jeder Schritt laufend, die zwei Handgriffe, auf die ein Lauf wartet, jeder Fall, mit dem er anhält, und fertig.

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
| `lauf.schritt_seit`, `lauf.schritt_frist_s` | seit wann der laufende Schritt läuft und seine Frist in Sekunden (nur solange er läuft) |
| `lauf.belege` | je erledigtem Schritt `schritt`, `dauer_s` und `zeile`: eine Zeile Beleg aus einer festen Liste je Schritt (`internal/lauf/zeile.go`), nie ein Geheimnis, nie rohe Ausgabe; mit Schlüsselmaterial darin steht nur „belegt“. Der ganze Beleg bleibt im Protokoll und an der Abnahme |
| `lauf.vorher` | was vor dem Lauf auf der Box war (aus `erkennen`, auch einem gescheiterten): `system`, `edge_light`, `ersetzt` (eine halb eingerichtete Box dieser Werkstatt: ihre alte Referenz geht nach dem Reset nicht weiter) |
| `lauf.nochmal_moeglich` | der angehaltene Lauf darf aus dem Portal neu angestoßen werden („Nochmal versuchen“): nur Fälle ohne Handgriff an der Box (`faelle.Nochmal`) |
| `lauf.nochmal_seit` | seit wann der Dienst den Auftrag „nochmal“ ausführt (er hat die Sperre der Box freigegeben) |
| `werkbank.status.strom` | Versorgung der Brücke (`vp-werkbank-status.v1`, additiv): `unterspannung_jetzt`, `unterspannung_seit_start` (fehlen, wenn der Pi es nicht meldet), `quelle` (`vcgencmd` oder `keine`) |
| `gehaeuse` | additiv (vp-mango-3mf-pro-box, automatisch nachholen): Liste der Box-Druckdateien, die im Portal noch nicht liegen - `referenz`, `zustand` (`wartet`, `baut`, `fertig`, `fehler`), `grund` (nur bei `fehler`), `bestellt` (Zeit). Fehlt ohne Gehäuse-Bau; leer, solange jede offene Box fertig und hochgeladen ist. Grundlage für die Werkstatt-Box-Seite: „Druckdatei wird erstellt …“ bzw. bei `fehler` ein ruhiger Satz mit „Erneut erstellen“ (`POST …/admin/werkstatt/boxen/{ref}/gehaeuse/neu`) |
| `fernlauf` | additiv ([Fernlauf](werkstatt-fernlauf-v1.md), vp-update-vor-zuordnung S1): `bereit` (der Dienst kann Fernläufe durch den Wartungstunnel: API, Techniker-Zugang, Portal für das Vertrauens-Set), sonst `grund`; `wartend` (Aufträge in seiner Schlange), `aktiv` (`auftrag`, `box`, `schritt`, `seit`) und `letzter` (`auftrag`, `box`, `ergebnis`, `ende`). Fehlt ohne API. Die API bietet den Knopf nur, wenn ein frischer Stand `bereit` meldet; fehlt das Feld, ist der Dienst älter als der Fernlauf |
| `freigabe_pfc200` | additiv (PFC200 Stufe 3): die Freigabe für den WAGO PFC200, Form wie `freigabe`; in ihr `freigabe.box_art` = `pfc200` und `freigabe.edge_industrie` (`fassung`, `quelle`, `programm_sha256`, `skripte_sha256`, `wartung_sha256`) statt `openwrt` und `edge_light`. Fehlt, solange der Dienst keine PFC200 einrichtet. `freigabe` bleibt die der Mango |
| `anschluss_geraet` | additiv: `mango` oder `pfc200`, sobald der Dienst das Gerät am Anschluss an seiner Adresse erkennt (192.168.1.17 ist der PFC200 nach dem Handgriff „feste Adresse“); fehlt, solange niemand antwortet. `anschluss_loesung` nennt dann dieses Gerät |
| `lauf.box_art` | `mango` oder, additiv, `pfc200`. Die Schritte eines Laufs am PFC200: `erkennen`, `fassungen`, `internet`, `zugaenge`, `notfall`, `programm`, `tunnel_schluessel`, `einloesen` (ohne API `tunnel_adresse`), `tunnel`, `netze`, `neustart`, `probe`, `internet_weg`, `uebergabe`. Einen Schritt für SPS oder Firmware gibt es nicht |
| `lauf.fall` bei `wartet` | additiv: Wartet ein Lauf auf einen Handgriff am Gerät, nach dem er von selbst weitermacht, stehen `fall` und `loesung` schon bei `zustand` = `wartet` da (`wartet_auf` nennt, worauf: `schalter_run`, `kabel_x2`). Eine Eingabe gibt es dafür nicht; der Dienst sieht selbst nach. Danach sind `fall` und `loesung` wieder leer |

Fehlt `lauf`, gab es seit dem Start des Dienstes keinen.

Die Felder `schritt_seit` bis `nochmal_seit` kamen mit der Lauf-Seite dazu (additiv). Ein Dienst ohne sie: Die Seite
zeigt keine Belegzeilen und kein „Nochmal versuchen“ und liest den Fall wie bisher.

**Aufträge.** Mit `PUT …/ansicht?auftraege=1` antwortet die API 200 mit `{"auftraege":[{"id","art","lauf"}]}` (Art
`nochmal`, jeder Auftrag genau einmal); ohne den Parameter 204 wie bisher. Was der Dienst daraus macht, steht danach in
`lauf.nochmal_seit`.
Dazu Aufträge der Art `aufspielen` ([Fernlauf](werkstatt-fernlauf-v1.md)): `id` ist der Auftrag, `lauf` die Referenz der Box.
Sie stehen in jeder Antwort, bis der Dienst einen mit `POST …/fernlaeufe/{id}/beginnen` annimmt oder die Abholfrist endet.

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
| `gl_passwort` | 192.168.8.1 verlangt ein Passwort, oder ihre Web-Schnittstelle meldet „schon eingerichtet“ und SSH ist zu (GL-Firmware schon eingerichtet, gebraucht gekauft) | Reset-Knopf 10 s | ja | nein |
| `halb_eigene` | Passwort, und ein Lauf dieser Werkstatt setzte es und übergab die Box nicht; derselbe Host-Schlüssel; im Portal nicht abgenommen, nicht gekoppelt | Reset-Knopf 10 s | ja | nein |
| `passwort_fremd` | Passwort unter 192.168.1.1, das kein Lauf dieser Werkstatt gesetzt hat | – | nein | ja |
| `box_in_gebrauch` | eigene Box, aber übergeben, abgenommen oder gekoppelt | – | nein | ja |
| `nicht_nachweisbar` | anderer Host-Schlüssel, Portal stumm, kein Portal, kein Stand eines Laufs dieser Werkstatt | – | nein | ja |
| `ssh_zu` | die Werksfirmware nimmt kein SSH an, und der Dienst kann sie nicht selbst einrichten: keine Web-Schnittstelle `/rpc` (GL 4.x), kein Modell, `ui.init` scheitert, oder SSH kommt auch danach nicht (Prüfstein PS-1) | Startlader (M4) | ja | nein |
| `abbild_abgelehnt` | `sysupgrade -T` der Werksfirmware scheitert | Startlader (M4) | ja | nein |
| `falsches_geraet` | kein GL-MT300N-V2 oder keine GL-Firmware unter 192.168.8.1 | – | nein | ja |
| `schon_edge_light` | Edge Light ohne Stand eines Laufs dieser Werkstatt | – | nein | ja |
| `openwrt_fassung` | frisches OpenWrt in einer anderen Fassung als die Freigabe, oder GL-Firmware unter 192.168.1.1 | Startlader (M4) | ja | nein |
| `kein_internet` | kein Internet über die Brücke (PS-12) | WLAN prüfen, Kabel kurz ab | ja | nein |
| `fassung_nicht_bereit` | Dateien der Freigabe nicht ladbar oder nicht passend | – | nein | ja |
| `uebertragung` | Prüfsumme des Abbilds auf der Box weicht ab | Kabel kurz ab | ja | nein |
| `bruecke_weg` | die Brücke war im Lauf nicht erreichbar | Pi prüfen, Kabel kurz ab | ja | nein |
| `box_weg` | die Box antwortete im Lauf nicht mehr | Strom/Kabel prüfen | ja | nein |
| `zwei_geraete` | mitten im Lauf antworten mehrere Geräte am orangen Kabel | nur eine Mango ans Kabel | ja | nein |
| `einloesen_abgewiesen` | das Portal nahm die Einlösung nicht an | – | nein | ja |
| `nicht_update_bereit` | Entscheid 5c: keine Abnahme | – | nein | ja |
| `dienst_neu_gestartet` | der Dienst startete mitten im Lauf neu (nur im Protokoll, `SchliesseOffene`) | Kabel kurz ab | ja | nein |
| `schritt_gescheitert` | jeder andere Fehler | Kabel kurz ab, beim zweiten Mal zur Seite | ja | nein |

**Fälle eines Laufs am PFC200** (`lauf.fall`, additiv).
Die Codes oben gelten auch für den PFC200; ihre Lösung nennt dann den PFC200 statt der Mango (`faelle.ZuFuer`).
Dazu kommen:

| Code | wann | Handgriff | selbst | zur Seite |
|---|---|---|---|---|
| `pfc_schalter_stop` | der Betriebsartenschalter steht nicht auf RUN (nach dem Handgriff „feste Adresse“ steht er oft noch auf STOP); der Lauf wartet (`zustand` = `wartet`) | Schalter auf RUN | ja | nein |
| `pfc_kabel_x1` | das Kabel der Werkbank steckt nicht in der Buchse X2; nach dem Trennen der Buchsen wäre das Gerät sonst weg; der Lauf wartet | Kabel in X2 | ja | nein |
| `pfc_passwort` | das Werkspasswort wird abgewiesen, und ein Lauf dieser Werkstatt setzte die Zugänge und übergab das Gerät nicht; derselbe Host-Schlüssel; im Portal nicht abgenommen, nicht gekoppelt (dieselbe Sicherheitslinie wie `halb_eigene`) | Werksreset (Reset halten, Schalter auf RESET, bis SYS rot und grün blinkt), dann „feste Adresse“ | ja | nein |
| `pfc_docker_an` | auf dem Gerät läuft Docker; der Dienst beendet keine fremden Container | Docker in der Web-Oberfläche des Geräts ausschalten, Kabel kurz ab | ja | nein |
| `pfc_falsches_geraet` | kein Gerät von WAGO unter 192.168.1.17 oder nicht die Bestellnummer 750-8212 | – | nein | ja |
| `pfc_schon_eingerichtet` | auf dem Gerät liegt schon ein Dienst von VoltPilot, ohne Lauf dieser Werkstatt | – | nein | ja |
| `pfc_notfall_schluessel` | der Notfall-Schlüssel des Dienstes ist von einer Art, die der SSH-Dienst des PFC200 nicht annimmt (er nimmt nur RSA und ECDSA); am Gerät ist nichts geändert | – | nein | ja |

Am PFC200 heißt `passwort_fremd`: Das Werkspasswort wird abgewiesen oder ein Passwort ist nicht mehr das ab Werk, ohne Lauf dieser Werkstatt.
Den Werksreset nennt der Dienst dann nie: Er löscht das SPS-Programm auf dem Gerät.
Antwortet am Kabel niemand (`keine_box`) und richtet der Dienst auch PFC200 ein, nennt `anschluss_loesung` immer den Handgriff „feste Adresse“ (Betriebsartenschalter auf STOP, Reset-Taster länger als 8 s, Schalter zurück auf RUN): Ein PFC200 ab Werk hat ohne ihn keine Adresse.
