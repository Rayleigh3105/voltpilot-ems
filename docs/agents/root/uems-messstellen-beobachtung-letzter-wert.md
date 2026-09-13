# UEMS-Beobachtung je Messstelle: „liefert Daten“, letzter Wert und „x von y“

Neu am 12.09.2026 (AP-04 IP-15, Bericht `data/vp-uems-ap04-messstellen/report.md` §4.5/§5.13/§5.16).
`GET /api/v1/messstellen` füllt ab jetzt die zwei Spalten, die IP-4 als benannte Platzhalter
angelegt hatte: `beobachtung` und `letzter_wert` je Register-Zeile, dazu `nebengroessen` (dieselbe
Aussage je Nebengröße) und `aggregat` („x von y Messstellen liefern Daten“ je Standort und für das
Unternehmen). Arbeit: `uems/MessstelleBeobachtung` (sammelt die Eingänge),
`uems/MessstelleRegisterService` (Zeile, Zeitzone, Aggregat), `uems/MessstelleRegisterRepository`
(`werte`, der EINE zusätzliche Lesezug), Formen in `web/dto/MessstelleDto`
(`RegisterBeobachtung`, `RegisterWert`, `RegisterNebengroesse`, `RegisterAggregat`,
`RegisterAbdeckung`, `RegisterStandortAbdeckung`), Kadenz und Einheit aus
`measurement/MesskanalService` (`kadenzS`, `einheit`). Beweise: `MessstelleRegisterApiTest`
(15 Fälle) und `MessstelleSchnittstelleVertragTest` (Java-Formen ⟷ OpenAPI, das
Zustands-Vokabular in seiner Reihenfolge).

**Dies ist der ERSTE Aufrufer des Zustandsvertrags aus AP-00 IP-3.** Welcher Zustand gilt,
entscheidet allein die reine `uems/ZustandAbleitung` (Vektoren
`docs/contracts/v2/uems-zustand-vectors.json`, Zwilling `frontend/portal/src/uemsZustand.ts`) —
IP-15 hat keine Zeile davon abgeschrieben und keine ergänzt.

## ⚠ Die Auflösung 3 × Kadenz / 2 × Kadenz

Der AP-04-Bericht nennt an drei Stellen (§4.5-Übergänge, §4.6, Abnahmezeile) „Toleranz 2 × Kadenz,
mindestens 5 Minuten, höchstens 1 Tag“. Das ist der **ältere** Wortlaut. Maßgeblich ist der
gebaute Vertrag (AP-07 E9 vom 10.09.2026, umgesetzt in PR 650):

- **Beobachtung „liefert Daten“:** Toleranz = `min( max( 3 × Kadenz , 300 s ) , 86 400 s )`, die
  Kante gehört zu „liefert“ (`<=`). Das baut IP-15.
- **2 × Kadenz ist die LÜCKE** — eine ANDERE Aussage: ohne Boden, ohne Deckel, sie zählt fehlende
  WERTE und zeigt kein Abzeichen (AP-07 IP-9). **Nicht in IP-15 gebaut.** Eine Reihe darf
  „Liefert Daten“ tragen und zugleich eine offene Lücke haben.

## Die Zeile und was sie sagt

- **`beobachtung`** (Hauptgröße) und je Eintrag in `nebengroessen`: `zustand` (eines der vier
  Wörter `liefert` · `liefert_nicht_seit` · `wartet_auf_erste_daten` · `keine_datenquelle`),
  `text` (der Kundensatz), `seit` (NUR bei `liefert_nicht_seit` — ein Satz ohne Zeitpunkt wäre eine
  halbe Aussage), `toleranz_s` und `kadenz_s` (beide `null` bei `keine_datenquelle`: ohne Kanal ist
  keine Kadenz bekannt, und eine Vorgabe wäre eine erfundene Zahl) und `geraet` (der Einbau der
  führenden Quelle).
- **`letzter_wert`**: `wert` ODER `text`, `einheit` (die des Messkanals, **nie umgerechnet**) und
  `zeitpunkt`. `null`, solange es keinen guten Wert gibt — nie eine 0.
- **`aggregat`**: `unternehmen` und `standorte[]` mit `erfuellt`/`gesamt`/`text` aus
  `ZustandAbleitung.aggregatLiefertDaten` (nur `liefert` zählt im Zähler).
- **`teilansicht`** bleibt `false` bis AP-03 — IP-15 erfindet keine Rechte-Logik.

## ⚠ Die Fallen

- **Ein Wert gehört zu SEINER Bindung, nicht zur Komponente.** Der Schlüssel der Werte ist
  (Komponente, Kanal, **Beginn der Bindung**). Ein Zählerwechsel tauscht das Gerät, aber weder
  Komponente noch Kanal — die Werte von Z-5a und Z-5b liegen unter derselben (Box, Kanal). Ohne
  den Beginn hielte der alte Zähler die neue Bindung am Leben, statt „Wartet auf erste Daten von
  Z-5b“ zu sagen (§5.13, Regel 4). MS-06: 10:40 Wechsel → bis 10:47 wartet sie, danach liefert sie.
- **Der Gerätename hängt am Satz, nicht an der Regel.** `ZustandAbleitung` sagt „Wartet auf erste
  Daten“; NUR dieser Satz bekommt in `MessstelleBeobachtung.satz` „ von <Einbau>“ angehängt — ein
  FAKT der führenden Bindung, keine zweite Fassung der Ableitung. Wer die Regel ändern will,
  ändert den Vertrag und beide Zwillinge, nie diese Stelle.
- **Werte finden ihre Box über die Mess-Selektion.** `device_measurement_sample` trägt heute keine
  `entity_id` (sie reist erst mit `measurement-samples` 2.1 und dem Writer, AP-07 IP-6/IP-7):
  gelesen wird über `device_measurement_selection (entity_id, point_key) → device_id`. Zwei
  Komponenten derselben Box unter demselben Kanal wären deshalb nicht unterscheidbar — die Tests
  geben jeder Messstelle ihre eigene Box.
- **Eine BERECHNETE Messstelle hat keine Beobachtung** (`null`, wie `quelle.stand = berechnet`):
  sie ist nicht ohne Quelle, sie wird gerechnet. Ihre Vollständigkeit („Vollständig“ /
  „Unvollständig seit … (fehlt: MS-12)“) steht seit AP-10 IP-9 in `berechnung`, und sie zählt im
  Aggregat MIT (vollständig = liefert; ohne Formel am Tag im Nenner wie „keine Datenquelle“) —
  Ahrenberg zählt 22, nicht mehr 17 gemessene (`uems-bilanz-lesemodell.md`).
- **Das Aggregat zählt GENAU die gezeigten Zeilen.** Ein Filter schneidet auch das Aggregat; eine
  Messstelle ohne Standort an dem Tag zählt nur beim Unternehmen, nie unter einem geratenen
  Standort.
- **Schweigen ist nie ein bewiesener Fehlschlag.** Es gibt keinen Fehler- und keinen
  Störungszustand und kein Abzeichen mit negativem Wort: eine Größe ohne Werte wartet, eine ohne
  Quelle hat keine — „keine Datenquelle“ schlägt jeden alten Wert, denn ein bekannter Grund ist
  nie eine Störung.
- **Die Uhrzeit gehört dem Standort.** `ZustandAbleitung.zeitpunktText` bekommt die Zeitzone aus
  `OrtsbaumAbleitung.zeitzoneVon` (seit IP-15 paket-sichtbar, keine zweite Fassung); ein Zeitpunkt
  trägt sein Datum, sobald er nicht mehr am heutigen Tag des Standorts liegt.
- **Die Eine-Abfrage-Zusage von IP-4 gilt weiter, präzisiert.** Die Messstellen-Daten kommen aus
  GENAU EINER Abfrage; die Werte aus GENAU EINEM weiteren Zug
  (`MessstelleRegisterRepository.WERTE`), der alle Messwerte als Feld bekommt (`unnest(uuid[],
  text[], timestamptz[])`) und **keine Messstellen-Tabelle anrührt** — deshalb zählt
  `MessstelleRegisterApiTest` weiterhin genau eine Abfrage mit „messstelle“ im Text. Gemessen:
  100 Messstellen = 10 Abfragen (dieselbe Zahl wie 1 Messstelle), 27 ms (< 300 ms).
- **Die Beobachtung gilt zum `zeitpunkt` der Antwort**, nicht „jetzt“: mit `?stichtag=` wandert
  auch das Werte-Fenster (`time <= zeitpunkt`) — so ist „Stand am“ eine Aussage über DIESEN
  Augenblick, keine Mischung aus altem Ort und heutigem Wert.

## Was IP-15 NICHT anfasst

Die heutigen Live-Flächen behalten ihr 5-Minuten-Fenster und ihre Wörter: `OverviewRepository`,
`AdminFleetRepository`, `api.ts ONLINE_WINDOW_MS`/`deviceLiveStatus`, `komponenten.ts
deviceState`. Cockpit, Erlöse, Fahrplan, Registry-Push und die Portal-Wörter bleiben
unverändert; IP-15 baut keine Portal-Fläche (IP-5/IP-8), keine Lücke (AP-07 IP-9), keine
Rechte-Durchsetzung (AP-03) und keine Formel (AP-10).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='MessstelleRegisterApiTest')          # 15 Fälle, Testcontainers
(cd services/api && ./mvnw test -Dtest='MessstelleSchnittstelleVertragTest') # 7 Fälle, ohne Docker
(cd services/api && ./mvnw test -Dtest='ZustandAbleitungVectorsTest')        # 59 Fälle, der Vertrag
```
