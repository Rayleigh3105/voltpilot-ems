# Mengen und Nenner der energetischen Bewertung (AP-16 IP-9)

`BewertungRanglisteController` liest `GET /api/v1/unternehmen/bewertung/rangliste?von=&bis=`.
`BewertungMengenLeser` ist rein; `BewertungRanglisteService` verbindet Monatswerte,
Bilanz und den heutigen Betrachtungsumfang. Die Datengrundlage besteht aus ganzen
Kalendermonaten, Anlagen-/Prozessbindungen werden am letzten Tag gelesen.
Die Rangliste zeigt laufende Einsätze; beendete bleiben über die IP-4-Leser und ihr
Protokoll erreichbar und zählen nicht nochmals neben einem Nachfolger.

- N1/N2: Stromnenner nur aus den Bilanzen, mit `x von y`. Ohne Hauptzähler „ohne Bilanz“;
  fehlt eine notwendige Bilanz, kein kleinerer Nenner. Bekannte Mengen bleiben sichtbar.
- Standort-Zaun wie IP-4/IP-5: `teilansicht` benennt den sichtbaren Teilumfang.
  Nenner, Anlagenzahl und Prozessmengen beziehen sich ausschließlich darauf.
  Prozessausschlüsse gelten auch dann, wenn IP-5 sie in einer Teilansicht nicht benennt.
- B3: direkte gemessene Messstellen, keine berechneten Prozesssummen/Verteilungen.
  Mengenlose Einsätze bleiben „keine Werte“. Die Monatswerte mit Herkunft und Version
  bleiben an der Messstellenzeile; Gas wird nicht umgerechnet und hat keinen Stromanteil.
- Ersatzmengen kommen aus den gebildeten Viertelstundenanteilen zum Stand der gelesenen
  Monatsversion. Fehlt dieser Beleg, bleibt die Quote null; kein Anteil wird geraten.
- `BilanzRichtungswerte` liest Laden/Entladen aus den gespeicherten Richtungsanteilen
  statt zweimal die Nettomenge einzusetzen. Fehlende Paare und korrigierte Versionen
  ohne eigenes Richtungspaar bleiben unbekannt. Der bestehende Bilanzweg nutzt denselben Leser.
- Der Rest der Bewertung ist je Anlage Nenner minus den dort gezählten Einsätzen;
  ein ausgeschlossener Prozess verschwindet nicht aus dem Anlagenverbrauch.
  Eine direkte Messung ohne Anlagenstellung bleibt eine Menge; ihre Verteilung auf
  Anlagen wird nicht geraten. Dann sind die Anlagenreste null und das Ergebnis unvollständig.

Nachweise: `BewertungRanglisteApiTest`, `BewertungMengenLeserTest`,
`BewertungVectorsTest` (unveränderte NW-1-Vektoren, TS-/Python-Zwillinge),
`BewertungRanglisteSchnittstelleVertragTest`, `BilanzApiTest` und Rechte-/Architekturwächter.
Keine Migration, kein Läufer und kein Kriterien-Urteil.
