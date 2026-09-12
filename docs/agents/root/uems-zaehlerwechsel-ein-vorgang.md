# UEMS-Zählerwechsel: EIN Vorgang, zwei Einstiege — alles oder nichts

Neu am 12.09.2026 (AP-04 IP-17). Routen `POST /api/v1/messstellen/{id}/quellen/wechsel`
(in `web/MessstelleController`) und `POST /api/v1/geraete/{id}/austausch` (in
`web/GeraetWechselController`), Arbeit in `uems/ZaehlerwechselService`, Marke in
`uems/ZaehlerwechselMarke`, Formen in `web/dto/ZaehlerwechselDto`. Regeln NUR aus
`uems/MessstelleRegeln` (NEU `wechselPruefen` ⟷ TS `uemsMessstelle.ts`, Familie `wechsel` in
`docs/contracts/v2/messstelle-vectors.json`) plus `beendenPruefen`, `bindungPruefen` mit dem
Vorgang `wechsel` und `QuelleEinstellungRegeln`. Migration `V20260912120000` weitet NUR zwei
Vokabulare (`messstelle_aenderung.art` um `zaehler_gewechselt`,
`component_change_event.event_type` um `device_replaced`) — der Vorgang braucht keine neue Tabelle.
Beweis: `uems/ZaehlerwechselApiTest` (MS-06-Zeitstrahl A1/A2/A16, Oktober-Rollup byte-gleich, jede
Ablehnung, alles-oder-nichts, Zaun, OpenAPI), `MessstelleRegelnVectorsTest`,
`MessstelleSchnittstelleVertragTest`, `uemsMessstelle.test.ts`.

## Was der Vorgang in EINER Transaktion tut

Altes Gerät `ausgebaut_am` · neues Gerät (dasselbe `kennzeichen` GR-4, neues
`einbau_kennzeichen`) · jede laufende Speisung wandert (`geraet_komponente`) · jede laufende
Bindung endet GENAU zum Wechselzeitpunkt und beginnt dort neu am neuen Einbau
(`messstelle_quelle`) · Ablesestände als Endstand des Vorgängers und Anfangsstand des Nachfolgers ·
Einstellungs-Fassungen übernommen (`quelle_einstellung`) · je betroffener Messstelle EIN
Protokolleintrag `zaehler_gewechselt` mit Urheber und Rückwirkend-Marker · Komponenten-Fassung NUR
bei wirklich neuer Verbindung · Marke `device_replaced` im Komponenten-Verlauf.

## ⚠ Die Fallen

- **Alles wird geprüft, BEVOR die erste Zeile geschrieben wird.** Genau darum gibt es diesen
  Dienst: bis hierher musste ein Wechsel aus Einzelaufrufen zusammengestückelt werden, von denen
  jeder für sich gelingen konnte. Wer eine Prüfung NACH den Schreibschritten einhängt, hat die
  Eigenschaft abgeschafft, die das Paket liefert (Test
  `einFehlerImLetztenSchrittLaesstKeineHalbeWirkungZurueck`, Testhaken
  `ZaehlerwechselService.letzterSchritt`).
- **Die Regeln liegen in `MessstelleRegeln`, nicht im Dienst.** `wechselPruefen` sagt NUR, ob der
  Zeitpunkt im laufenden Einbau des Vorgängers liegt: nach seinem Einbau (genau auf ihm zählt als
  davor — ein Einbau von null Minuten ist keiner → 422 `zeitpunkt_vor_vorgaenger`, A15 und seine
  Kante) und vor seinem Ausbau (ein ausgebauter Einbau steckt nicht mehr → 422
  `kein_geraet_zum_zeitpunkt` mit `ausgebaut_am`). Was mit den Quellen geschieht, urteilen
  `beendenPruefen` und `bindungPruefen` (Vorgang `wechsel`) — die es beide schon vor IP-17 gab.
- **Die Marke ist ein isolierter Zusatz.** `ZaehlerwechselMarke` ist ein EIGENES Bean mit
  `@Transactional(NESTED)`: ein Selbstaufruf im selben Bean ginge am Proxy vorbei, und ohne
  Savepoint hätte jede Ausnahme die gemeinsame Transaktion rollback-only gemacht. Scheitert sie,
  zählt `voltpilot_zaehlerwechsel_marke_total{ergebnis="fehler"}` — der Wechsel steht trotzdem, und
  `marken` in der Antwort sagt ehrlich, wie viele Verläufe die Marke tragen.
- **Der Controllerwechsel ist NICHT dieser Vorgang.** Ein Einbau mit Energiekarten
  (`geraet_teil` zum Zeitpunkt) wird mit 409 `zustand_passt_nicht` abgelehnt: ob die Karten
  übernommen werden oder ebenfalls neu sind, entscheidet IP-19 (`karten_uebernommen[]`, je Karte
  ein Endstand). Dieser Schnitt nimmt die Entscheidung nicht vorweg.
- **Der Ablesestand gehört zu GENAU EINER führenden Zählerstand-Bindung.** Eine Vergleichsquelle
  liest denselben Zähler ein zweites Mal — der abgelesene Stand gehört der führenden. Betrifft der
  Wechsel mehrere führende Zählerstände (MS-01 Bezug + MS-02 Abgabe an GR-2), ist 400 die ehrliche
  Antwort: Ablesestände je Messwert kommen mit IP-19.
- **Eine angekündigte Bindung am alten Einbau blockiert den Wechsel** (409): sie begänne nach dem
  Wechsel an einem Gerät, das dort nicht mehr steckt. Erst zurücknehmen (bzw. später wechseln).
- **Vom Einstieg Messstelle aus wird das Gerät NACHGESCHLAGEN**, nie gewählt: es ist das, aus dem
  sie zum Wechselzeitpunkt liest. Keine laufende Quelle → 409 („erst eine Quelle binden"); mehrere
  Geräte → 409 („auf der Geräteseite wechseln").
- **Die Verbindung des Wechsels ist die des GERÄTS** (`geraet.data_source_id`, `geraet.geraete_id`).
  Eine geänderte Geräte-ID schreibt sie zusätzlich in die Verbindung der Komponente — unter dem
  Schlüssel, den auch die Geräte-Ableitung liest (`mb_slave_id` bei `solarman_v5`, sonst `unit_id`)
  — als neue Komponenten-Fassung samt `component_activation_outbox`. Die ADRESSE bleibt die der
  Komponente: sie gehört der Datenquelle (AP-06), nicht diesem Vorgang.
- **Übernommene Einstellungen tragen `herkunft = 'eintrag'`** mit der Begründung „Beim
  Zählerwechsel von Z-5a übernommen" — kein viertes Herkunfts-Wort, kein CHECK geweitet. Die
  Fassung am alten Einbau bleibt unangetastet.
- **Ohne gewähltes `einbau_kennzeichen` vergibt der Server `GR-4.2`, `GR-4.3` …** — die erste freie
  Nummer am Gerät. Ein belegtes Kennzeichen ist 409 `kennzeichen_belegt`, nie ein Überschreiben
  (`uq_geraet_einbau_kennzeichen`).
- **Die Beobachtung (IP-15) sagt von selbst „wartet auf erste Daten von Z-5b".** Der Wechsel rührt
  sie nicht an: weil der Wert-Schlüssel den BEGINN der Bindung enthält, wartet die Messstelle ab
  10:40 und liefert ab dem ersten Wert von Z-5b. Der Test weist das nach, statt es zu erzwingen.
- **Die Werte-Lücke bleibt.** Kein gespeicherter Messwert wird berührt (Oktober-Rollup byte-gleich);
  die sieben Minuten 10:40–10:47 des Referenzfalls bleiben leer und werden nie interpoliert und nie
  auf 0 gesetzt.

## Nicht dieses Paket

Controllerwechsel (IP-19), Portal-Dialog (IP-18), Rechte-Durchsetzung (AP-03),
Änderungsprotokoll-Routen (IP-21), das Zustellen angewendeter Einstellungen an die Box (AP-06).
