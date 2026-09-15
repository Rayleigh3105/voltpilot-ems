# UEMS-Lese-Modell: Werte je Messstelle (AP-08 IP-9)

`GET /api/v1/messstellen/{kennzeichen}/werte?raster=viertelstunde|stunde|tag|monat|jahr&von&bis[&version]`
— die erste Fläche, an der ein Kunde seine Verbrauchszahlen abholt. **Eine Menge verlässt die Route nie
ohne Zustand, Abdeckung und Kennzeichen.** Keine Migration, keine Rechenregel: gelesen und AUFGERUFEN.

| Teil | Datei |
|---|---|
| Regeln (rein): Anfrage, Schritte, Deckung | `services/api/.../uems/MessstelleWerteRegeln.java` · `MessstelleWerteRegelnTest` |
| Dienst | `uems/MessstelleWerteService.java` |
| Route | `web/MessstelleWerteController.java`, `web/dto/MessstelleWerteDto.java` |
| Lesepfad (erweitert) | `measurement/SpeicherklasseHistorie.java`: `perioden`, `ereignisVerweise`, `mitDaten` |
| Schnittstelle | `docs/contracts/openapi.yaml` (`MessstelleWerte*`), Rechte-Nachtrag AP-08 §4.8 |
| Abnahme (Testcontainers) | `uems/MessstelleWerteApiTest` — F8/F13 Erwartung für Erwartung über die Route, echte Läufe |

## Die vier Fallen

1. **Eine Lücke hat keine Zeile.** Eine Viertelstunde ohne Rohwert steht nicht in
   `messreihe_viertelstunde` — sie darf weder fehlen noch 0 sein: jeder Schritt des Rasters steht in
   der Antwort, ohne Zeile als `zustand` „keine Werte“ mit `erhalten` 0 von `erwartet` aus der
   Kadenz-Kette zum Beginn (`MesskanalService.kadenz` → `KadenzRegeln`; F8 14:15: 0 von 15). Liegen
   darunter aber schon Rohwerte (Nicht-Spiegel) oder Viertelstunden, ist die Periode nur **noch nicht
   gebildet** (`grund` `noch_nicht_gebildet`, kein Zustand) — der nächste Lauf kommt.
2. **Tag, Monat, Jahr kommen aus den Periodenständen**, nie als Summe: Tag aus `messreihe_tag`, Monat
   und Jahr aus `messreihe_periode`. Gegenprobe im Test: F8 Tag 2 304 kWh, die Summe der Viertelstunden
   derselben Route 1 966,4. Die STUNDE ist keine Speicherklasse: Menge/Zustand/Kennzeichen je Schritt
   aus `ZeitraumMenge.raster` (über den Lesepfad), ⚠ die Abdeckung ebenso — der Lesepfad bildet sie im
   groben Raster aus Zeitraum und Kadenz zur Messzeit (eine fehlende Viertelstunde zählt mit ihren
   erwarteten Werten — F8 17:00: 29 von 60), die Route rechnet sie nicht nach; vorläufig/endgültig über
   `TagRegeln.zustand` mit der Frist des Stunden-Endes (`gebildet_aus` `zeitraum`).
3. **`zustand` ist NICHT `fassung`.** Die Antwort nennt das Wort des Ergebnis-Zustands-Vertrags
   (Spalte `menge_zustand`) `zustand` und vorläufig/endgültig (Spalte `zustand`!) `fassung` — genau
   umgekehrt wie die Spalten. Beide stehen immer da; ein Schritt ohne `zustand` nennt immer `grund`.
4. **Ein Umstellungstag hat 23 oder 25 Stunden.** Schritte in der Zone des Standorts (Kette wie die
   Tagesklasse: Standort der Anlage der Reihe → Unternehmen → Vorgabe); `stunden` aus `TagRegeln.stunden`
   bzw. `VerbrauchRegeln.stunden`, `tagesdauer` und `beschriftung` („02:00–03:00 MESZ“) aus
   `ErgebnisZustand` — die Route spricht keinen Satz selbst. 25.10.2026: 100 Viertelstunden, 25 Stunden.

Und die fünfte, die das Paket definiert: **nur die Rolle `fuehrend` der Hauptgröße** liefert — eine
Vergleichsquelle nie, auch nicht, wo die führende schweigt (Test: MS-10 am 25.10.).

## Welche Reihe einen Schritt beantwortet (`MessstelleWerteRegeln.deckung`)

Die Reihe ist Komponente + Messkanal (AP-07 E2). Ein Schritt gehört der Messstelle nur, wenn ihre
führenden Bindungen DERSELBEN Reihe ihn ganz decken — ein Zählerwechsel an derselben Komponente
(Z-5a → Z-5b) bleibt eine Reihe. Sonst eine Zahl-lose Antwort mit `grund`: `keine_quelle` (dann
„keine Werte“), `quelle_teilweise` (Bindung beginnt/endet im Schritt oder zwei Reihen),
`anteil_nicht_gespeichert` (⚠ Befund: die Speicherklassen tragen den GANZEN Wert der Reihe; MS-01/MS-02
mit Vorzeichen-Kanal haben hier noch keine Menge), `berechnet` (seit AP-10 IP-10 nur noch Stunde und Formel mit Momentanwert — Viertelstunde/Tag/Monat/Jahr liest eine berechnete Messstelle aus ihrer Spur, `uems-berechnete-periodenwerte.md`), `ohne_menge_gespeichert`
(endgültiger Tag von vor IP-5), `version_nicht_gespeichert` (`?version=n` fehlt an diesem Schritt; seit IP-18 zeigt
die Route ohne Angabe die neueste Version, `version_nicht_gebildet` an der Stunde — `uems-versionen-lesen.md`).

## Anfrage

`von`/`bis` als Tag (JJJJ-MM-TT; `bis` = letzter Tag EINSCHLIESSLICH) oder Zeitpunkt mit Versatz (`bis`
ausschließlich), beide auf Raster-Grenzen der Standort-Zone — nie gerundet. Ablehnung 400
`anfrage_ungueltig` mit `feld` und `grund` (`fehlt` · `raster_unbekannt` · `form` · `nicht_im_raster` ·
`von_nicht_vor_bis` · `ausserhalb` · `zu_viele_schritte` · `version_ungueltig`); höchstens 2 200 Schritte,
Stunde 550 (sie liest ihre Viertelstunden im selben Zug). Fremde Messstelle 404, nie 403; das Kennzeichen
ist das HEUTE getragene.

## Ereignis-Verweise

`ereignisse[]` = `{id, art, von, bis}` der Arten des Verlaufs (dieselben Fallen wie die Marken: ohne
`aus_bestand`, Fortschreibung = ein Ereignis, Rücksetzung eines Überlaufs = der Überlauf, Übergabe über
die Datenquelle). Zeitraum-Ereignis: Überschneidung mit `[von, bis)`; Zeitpunkt: in `(von, bis]` wie die
Regel der Viertelstunde.

## Rechte und Grenzen

`messwerte.ansehen` als Route-Kommentar und Nachtrag AP-08 §4.8 in `rechte-matrix.json` (zugeordnet),
KEINE Durchsetzung (AP-03). Keine Portal-Fläche (IP-10/11), keine Ersatzwerte (IP-13), keine Korrekturen
(IP-12 ff.), nur die Hauptgröße. Die Stunde liest ihre Viertelstunden nur noch für „noch nicht gebildet",
Version und vorläufig/endgültig, NICHT für die Abdeckung (der Umweg aus PR 725 ist entfallen). Befund: das
Mittel im groben Raster bleibt das des Lesepfads (gewichtetes Mittel gespeicherter Mittel).

Seit AP-12 IP-16 ruft der Controller `werteDerRoute`: EINE Periode (Monat/Jahr) in Version 1 jenseits der Aufbewahrung ohne
Zeile ist 404 `wert_nicht_mehr_gespeichert` — nur an der Route, die Leser im Haus lesen `werte(…)` weiter ohne Frist
(`uems-bericht-nach-den-fristen.md`).
