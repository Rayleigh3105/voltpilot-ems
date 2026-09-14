# UEMS: Versionen lesen — wer, wann, warum, und was vorher dastand (AP-08 IP-18)

Neu angelegt am 14.09.2026. Baut auf dem Lese-Modell (`uems-werte-je-messstelle.md`, IP-9), dem Ersatzwert-Lauf
(`uems-ersatzwert-methoden.md`, IP-13) und der Kaskade (`uems-korrektur-kaskade.md`, IP-17) auf. Keine Migration.

**Der Satz, der das Paket definiert: eine Korrektur ist erst dann nachvollziehbar, wenn man den alten Wert noch sieht.**

| Teil | Stelle |
|---|---|
| `?version=` | `GET /api/v1/messstellen/{kennzeichen}/werte?…&version=n` — `uems/MessstelleWerteService#werte` |
| Historie | `GET /api/v1/messstellen/{kennzeichen}/werte/versionen?raster=&von=&bis=` (genau EIN Schritt) — `#historie` |
| Regeln (rein) | `uems/WertVersionenRegeln` (Wahl, Entscheidungen, „warum“) · `WertVersionenRegelnTest` |
| Leser (RLS) | `uems/WertVersionenLeser`: `messreihe_viertelstunde_version`, `messreihe_periode_version`, Fassungen von `messreihe_ersatzwert`/`messreihe_korrektur` |
| Schnittstelle | `openapi.yaml`: `MessstelleWerteWert.versionen`, `MessstelleWerteHistorie` ff., `MessstelleWerteVersionGibtEsNicht` |
| Abnahme | `uems/MessstelleWerteVersionenApiTest` — F21 mit Version 1/2/3 über die Route, echte Läufe |

## Die Regeln

1. **Ohne Angabe die NEUESTE Version** (die wirksame) — vor IP-18 zeigte das Lese-Modell immer Version 1. Wer
   ausdrücklich Version 1 braucht, fragt `"1"`: `KostenstelleEnergieService` (überlagert seine Versionen selbst) und
   `BerechnetePeriodenLauf.lies` (Version 1 der Eingänge; spätere überlagert allein die Kaskade). `BilanzService` liest
   ohne Angabe und zeigt damit die neueste Version seiner Terme.
2. **`version=n` zeigt genau Version n** — die damalige Zahl aus der gespeicherten Zeile, nie die heutige mit Etikett.
   Version 1 = die Zeile der Verdichtung; in einer Lücke gar keine Zeile, dann „keine Werte“ mit 0 von erwartet.
   Eine Viertelstunde des Ersatzwert-Laufs (`korrekturen` NULL) hat die Rohwert-Fakten von Version 1.
3. **Eine Version, die es nicht gibt, ist nie leer und nie die höchste.** An KEINEM Schritt der Anfrage → 404
   `version_gibt_es_nicht` mit `version` und `hoechste_version`; nur an einzelnen Schritten eines Zeitraums → der
   Schritt ohne Zahl mit `grund` `version_nicht_gespeichert` und seiner neuesten in `versionen`.
4. **Die Stunde hat keine eigenen Versionen** (keine Speicherklasse). Trägt eine ihrer Viertelstunden eine spätere
   Version: `grund` `version_nicht_gebildet`, `versionen` null; mit `version=1` die damalige Stunde. Die Historie
   lehnt `raster=stunde` ab (400 `raster_ohne_versionen`). ⚠ Befund: der Vertrag rechnet die Stunde ab Version 2
   (F11 „Stunde 04.11. 09:00–10:00 (Version 2)“ = 96,0) — dafür müsste der Lesepfad die Stunde aus der neuesten
   Viertelstunden-Fassung bilden (`KaskadeStufen.teile` für eine Stunde); nicht gebaut.
5. **Die Entscheidungen einer Version** (`WertVersionenRegeln.entscheidungen`): was in n wirkt und in n − 1 nicht (seine
   wirkende Fassung: Ersatzwert `wirksam`, Korrektur `freigegeben`), was nicht mehr wirkt (seine Fassung
   `zurueckgenommen`), und immer der Anlass. Nur Fassungen bis zum Bilden der Version. F21: Widerruf + bessere Methode
   vor demselben Lauf = EINE Version mit ZWEI Entscheidungen, auch wenn der Anlass nur eine nennt.
6. **Das „warum“ ist der Text des Menschen zu DIESER Fassung** — anlegende Fassung: `begruendung`, jede weitere: `grund`.
   Fehlt er (eine Freigabe verlangt keinen): `warum` null, `fehlt` `["warum"]` — nie Art, Methode oder Status als Ersatz.
   Die anlegende Fassung steht an einer späteren unter `angelegt` mit IHREM Urheber (ein System-Vorschlag: VoltPilot,
   `art` `voltpilot`).

## Die Naht fürs Portal (leer)

`versionen` an jedem Wert von `…/werte` ist die Naht der Fläche „Versionen“ am Wert: ab 2 gibt es eine Historie. Die
Fläche braucht: `api.ts` um `versionen`, `herkunft` und das Wort `version_nicht_gebildet` ergänzen, einen Aufruf
`…/werte/versionen` mit `von`/`bis` des Schritts, je Version `wert_alt` → `wert_neu` über `uemsErgebnis.menge`/`teile`
(Zahl nie selbst formatieren), `entscheidungen[]` mit `wer.name`, `wann` (Standort-Zone), `warum` — und bei `fehlt`
„warum“ einen ehrlichen Satz statt eines Grundes; `angelegt` als „vorgeschlagen von …“. Kein Portal-Code in IP-18.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='WertVersionenRegelnTest,MessstelleWerteRegelnTest,RechteKennungenDerRoutenTest')
(cd services/api && ./mvnw test -Dtest='MessstelleWerteVersionenApiTest,MessstelleWerteApiTest')   # Testcontainers
(cd services/api && ./mvnw test -Dtest='KostenstelleEnergieApiTest,UemsKorrekturKaskadeTest,BilanzApiTest')
```
