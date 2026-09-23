# Energetische Bewertung (AP-16 IP-8 bis IP-10 und IP-14)

`BewertungRanglisteController` liest `GET /api/v1/unternehmen/bewertung/rangliste?von=&bis=`.
`BewertungMengenLeser` liest die Zahlen; `BewertungRanglisteService` verbindet Monatswerte,
Bilanz, wirksame Kriterien-Fassung und den heutigen Betrachtungsumfang. Die Datengrundlage besteht aus ganzen
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
  statt zweimal die Nettomenge einzusetzen — das Paar der GELESENEN Version: Version 1 aus
  `messreihe_tag`/`messreihe_periode`, eine korrigierte aus `messreihe_periode_version`
  (`V20260923231500`, gebildet von der Kaskade, [Korrektur-Kaskade](uems-korrektur-kaskade.md)).
  Fehlende Paare bleiben unbekannt: Nettomengen-Berichtigung (`wert_berichtigt`), Ersatzwert,
  Versionen von vor der Migration. Der bestehende Bilanzweg nutzt denselben Leser.
- Der Rest der Bewertung ist je Anlage Nenner minus den dort gezählten Einsätzen;
  ein ausgeschlossener Prozess verschwindet nicht aus dem Anlagenverbrauch.
  Eine direkte Messung ohne Anlagenstellung bleibt eine Menge; ihre Verteilung auf
  Anlagen wird nicht geraten. Dann sind die Anlagenreste null und das Ergebnis unvollständig.

Nachweise: `BewertungRanglisteApiTest`, `BewertungMengenLeserTest`,
`BewertungVectorsTest` (NW-1-Vektoren, TS-/Python-Zwillinge),
`BewertungRanglisteSchnittstelleVertragTest`, `BilanzApiTest` und Rechte-/Architekturwächter.
IP-9/IP-10 bringen keine Migration und keinen Läufer.

## Prozess-Messstellen und Prozess-Summe (IP-14, P4/W12)

- `GET /api/v1/unternehmen/prozesse/{id}/messstellen?am=` liest die am Stichtag
  zugeordneten Messstellen und trennt `gemessen` von `berechnet`. Die Route ist ein
  reiner Leser ohne `@Recht`; Unternehmenssicht oder der Standort-Zaun aus IP-4
  bestimmen den sichtbaren Ausschnitt.
- `ProzessMessstellenService` prüft mit `BewertungRegeln.prozessSummePasst`, ob jeder
  Term einer berechneten Prozess-Messstelle eine gemessene Messstelle desselben
  Prozesses ist. Fremde Terme erzeugen nur `prozess_summe_passt`-Hinweise. Bei
  Verteilungen enthalten sie Kostenstelle und Tagesanteil als „über Verteilung“.
- Der Hinweis erscheint additiv in der Ranglisten-Antwort sowie im Portal an
  Prozess-Karte und Rangliste. Er ändert weder Messwerte noch Kennzahlen; insbesondere
  bleibt KZ-0004 bytegleich.
- Nachweis: R16 in `BewertungRanglisteApiTest` (MS-20/P-1 nennt MS-07/P-3),
  `KostenstelleProzessSchnittstelleVertragTest`,
  `BewertungRanglisteSchnittstelleVertragTest` und die Portal-Tests.

## Urteil und Herkunftsentwurf (IP-10, KR2–KR4)

- `BewertungRegeln.urteil` ist in Java, TypeScript und Python rein und rechnet die
  Vektoroperationen `rangliste` und `urteil`. Schwellen vergleichen ungerundete
  Größen; erst Anzeigen erhalten eine Nachkommastelle. K2 wird bei Strom erst mit
  erfülltem K8 belastbar. K7/K8 stehen am Stand, K1–K3/K5–K6 am Einsatz.
- Die Ranglistenroute ergänzt die Zahlen um `kriterien` (Fassung + Werte), `urteil`
  und `vorschlag`. Das ist niemals eine Einstufung; diese setzt erst IP-11 durch
  eine Person mit Begründung. K4 bleibt deshalb hier unbesetzt.
- `herkunft` ist der Entwurf für IP-11: Zeitraum, Kriterien-Fassung, Urteil,
  Vorschlag, jede Einsatz-Monatszahl mit Version/Zustand und bei Strom jeder
  Bilanzwert des Nenners samt Eingangs-Versionen. Weitere Träger haben `nenner: null`.
- K5 gewichtet die Zustände der gelesenen Monatswerte mit deren Kalendertagen;
  K6 verwendet den ungerundeten Ersatzanteil. Der Standort-Zaun wird vor
  beiden Rechnungen angewandt, deshalb verrät auch die Herkunft keine fremden IDs.

## Kriterien-Fassungen (IP-8, KR1, R15/R17)

- `BewertungKriterienController` liest/ändert `GET/PUT /api/v1/unternehmen/bewertung/kriterien`,
  Historie unter `/fassungen`, Entscheidung mit `POST /{nummer}/freigeben|ablehnen`.
  `bewertung.kriterien` schreibt nur KA/EM; GET trägt `energieeinsatz.ansehen` und den Standort-Zaun.
- `BewertungKriterienVertrag` lädt die **verpackten** `bewertung-vectors.json#/startwerte`.
  Die ungespeicherte Fassung 1 heißt „Vorgabe“; GET schreibt nichts. Der erste PUT sichert sie
  und legt Fassung 2 an. `werte` erhält Typen und Feldreihenfolge des Vertrags; `kriterien`
  hält Einheiten/Vergleiche einschließlich K4 ohne Zahl je gespeicherter Fassung fest.
  Die Startwerte werden nicht dupliziert.
- `BewertungKriterienService`: Begründung Pflicht, monotone Nummer unter Unternehmenssperre,
  höchstens ein offener Antrag. Vier-Augen wird beim Antrag eingefroren; nur eine zweite
  Person gibt frei/lehnt ab. Wirksam erst am Bestätigungstag in Unternehmenszeitzone;
  Ablehnungen und abgelöste Fassungen bleiben lesbar. Anstoß auf Berichte erst IP-23.
- `V20260922230000`: RLS + FORCE, nur Freigabe-/Ablösungsspalten änderbar, kein App-DELETE,
  zweiter Akteur auch per CHECK. `bewertung_aenderung` atomar für Anlage/Änderung/Entscheidung.
  `TenantRepository.offboard` entfernt Fassungen vor Unternehmen; keine Fremd-Bestandszeile.
  Die späte-Ankunft-Probe in `UemsZugriffMigrationTest` führt IP-8 unter den IP-5-Nachfolgern.
- Nachweis: `BewertungKriterienApiTest` (Vertragsbytes, R15/R17, Historie, Rechte, RLS,
  Offboarding, Parallelität); `BewertungKriterienSchnittstelleVertragTest` hält die API-Formen fest.
