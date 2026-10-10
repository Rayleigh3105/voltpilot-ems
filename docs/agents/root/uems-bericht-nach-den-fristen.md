# UEMS-Nachweis nach den Fristen: die Abnahme des Captains in Code (AP-12 IP-16)

Neu angelegt am 15.09.2026, Meilenstein 6 „Abnahme in Code“ (B1/B16, E1 = A). Keine Migration, keine Fläche. „Ein
freigegebener Bericht lässt sich trotz späterer Korrekturen und abgelaufener Rohdaten erklären“ — der Test fährt die ganze
Kette und löscht dann die Welt unter den Berichten. Vertrag: `docs/contracts/v2/bericht.md` S4, `bericht-vectors.json` B16.

| Was | Wo |
|---|---|
| Abnahme (Testcontainers, eine Geschichte) | `uems/UemsBerichtNachDenFristenTest`: Zählerstände MS-12 Oktober 2026 → Verdichtung → endgültig → Route anlegen + Nr. 1 → Nachlieferung 18.10. → Vorschlag → Freigabe → `KorrekturKaskade` mit der echten `BerichtKaskade` → Nr. 2 → PDF/CSV/Stand abholen → `DELETE` + Zählung → vergleichen |
| Route | `GET /api/v1/messstellen/{kennzeichen}/werte` → `MessstelleWerteService.werteDerRoute` → `pruefeAufbewahrung` → 404 im `MessstelleWerteController` |
| Regeln (rein) | `MessstelleWerteRegeln.AUFBEWAHRUNG_TAGE` (= Migrationen), `jenseitsDerAufbewahrung`, `WertNichtMehrGespeichert` (Code, Status, Satz aus `BerichtRegeln`) · `MessstelleWerteRegelnTest` |
| Vertrag | B16 (Familie `ablauf`): Prüfsumme Nr. 1 UND Nr. 2, Satz mit/ohne Stand, Schritt IP-16; `_abweichungen` B16; `openapi.yaml` `MessstelleWerteNichtMehrGespeichert` |

```bash
(cd services/api && ./mvnw test -Dtest='MessstelleWerteRegelnTest,BerichtVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsBerichtNachDenFristenTest')   # Testcontainers, sonst LAUT übersprungen
```

## Die Fallen

1. **Nur an der Route.** `werte(kennzeichen, …)` bleibt für die Leser im Haus (Kostenstellen, Kennzahlen, Bilanz, berechnete
   Perioden, Bildung) „keine Werte“ — eine alte Periode bricht dort nie einen Lauf ab. Nur `werteDerRoute` prüft die Frist.
2. **Die 404 braucht alles zugleich:** genau EINE Periode, Monat oder Jahr, gemessene Reihe (keine berechnete Spur), Version 1
   (angefragt oder als neueste), Beginn + 3 653 Tage ≤ jetzt, keine Zeile und keine Viertelstunden darunter. Innerhalb der
   Aufbewahrung ist eine fehlende Zeile weiter „keine Werte“; mit Zeile steht die Zahl da, gleich welches Datum.
3. **Version 2 lebt.** Ohne `version` zeigt die Route die neueste — nach einer Korrektur also Version 2 aus
   `messreihe_periode_version` (200), nicht „keine Werte“ wie im Konzept (`_abweichungen` B16). „heutigen Wert zeigen“ bekommt
   die 404 nur, wo es keine spätere Version gibt.
4. **Die Frist rechnet ab dem BEGINN der Periode** (Zeitspalte `tag`/`intervall_beginn` der Hypertable), nicht ab ihrem Ende —
   das Jahr 2026 kann im Januar 2036 weg sein.
5. **Der Stand im Satz** ist der früheste freigegebene, dessen Quelle GENAU diese Tage der Messstelle in Version 1 zitiert
   (unmittelbar oder Vergleich, nie mittelbar). Ein Jahresbericht belegt keinen Monat. Kein Rechte-Filter: der Satz nennt nur
   Nr. und Datum.
6. **Test: löschen heißt zählen.** `zaehleFristen` vorher > 0 je Tabelle, `DELETE` meldet dieselbe Zahl, nachher 0; die
   unbefristeten Tabellen zählen gleich. Den Stand-Text erst NACH dem Abholen von PDF/CSV festhalten, und die Gegenprobe
   (2036 ohne Löschen = die Zahl) VOR dem Löschen — sonst misst der Vergleich das Abruf-Protokoll oder die Uhr.
7. **Zwei Uhren:** `BerichtService.uhrStellen` (Anlegen, Freigabe) und `MessstelleWerteService.uhrStellen` (Frist). Die Läufe
   bekommen ihr `jetzt` als Argument; Zeilen tragen die echte DB-Zeit (vor jedem Datenstand, D2).
8. **Ohne Docker `DockerPflicht`** statt `disabledWithoutDocker = true`: der Test wird mit dem Satz „ÜBERSPRUNGEN … die Abnahme
   … ist NICHT gelaufen“ übersprungen — ein grüner Stapel ohne `Tests run: 1` für diese Klasse beweist nichts.

## Grenzen (benannt, nicht gebaut)

- Tag, Viertelstunde und Stunde der Werte-Route, `…/werte/versionen`, Kennzahl-Werte und Kostenstellen-Energie sagen nach den
  Fristen weiter still „keine Werte“; der Vertrag hat Sätze nur für Monat und Jahr (`vom_monat`/`vom_jahr`).
- Eine berechnete Messstelle (Spur `berechnet`, `bilanzwert_eingang` 3 653 Tage) prüft die Frist nicht.
