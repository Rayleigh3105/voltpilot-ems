# Messen: die Seite einer Messstelle

Stand: Messen-Bau m2, PR2 (Konzept `data/vp-messen-konzept-m1` §6.4/§6.5, Captain-Freigabe 05.10.2026).

## Aufbau (`#/portfolio/messstellen/{id}`, `#/standort/{sid}/messstellen/{id}`)

- Die reine Ableitung steht in `src/messstelleSeite.ts` (Rolle, Kopf, Zustandszeile, Kacheln, Balken, Ablesungen, Herkunft, Protokoll-Verweis, Fuß); `MessstelleSeite.tsx` rendert nur.
- Die Rolle folgt der Richtung der Hauptgröße: Bezug ist Verbrauch (`load`), Erzeugung ist PV (`pv`), Abgabe ist Einspeisung (`grid`), sonst steht die Größe selbst (neutral).
- Die Werte heißen nach der Rolle („Verbrauch je Monat“, „… am Tag“, „… in der Woche“) und starten beim letzten vollständigen Monat (`werteStart`).
- Eine eben eingerichtete Messstelle (erste führende Quelle erst im laufenden Monat) öffnet im laufenden Monat, mit Gerät am heutigen Tag; eine Periode in der Adresse geht immer vor.
- Monat und Jahr stehen als zwölf Balken (`MonatsBalken`, EINE Anfrage im Raster Monat für das Fenster) mit der Zeile des Monats (`WerteZusammenfassung`).
- Der Verlauf (`MessstellenVerlauf`) erscheint im Monat und im Jahr nur mit gewähltem Vergleich, weil erst er die zweite Reihe zeichnet; der Vergleich selbst ist zugeklappt, bis jemand vergleichen will.
- Am Tag und in der Woche stehen Zeile und Verlauf; die Liste der Schritte liegt unter „Alle Werte des Zeitraums“ (zu).
- Ein Ablesezähler kennt nur Monat und Jahr; eine Woche oder ein Tag der Adresse öffnet dann ihren Monat (`isoMonat` des Montags).
- Aus „Stand an einem Tag ansehen“ geöffnet (`?periode=T&stand=T`, `parseMessstelleWerte().stand`) liest die Seite das Register an diesem Tag, die Leitkachel nennt den letzten vollen Monat davor, und es gibt keinen Schreibweg (kein Schritt, kein „Ändern“, keine Formel, kein Berichtigen, Menü nur Protokoll); Marke „Stand … · Nur lesen“ mit „Zurück zu heute“.
- Die Zeitzone steht einmal am Fuß (`werte-zone`, `fussSatz`), nicht im Werte-Abschnitt; am Uhrzeitfeld eines Dialogs steht nur ihr Kürzel (`VpZeitpunktPicker` mit `kopf`).

## Ablesen

- Den Schritt „Ablesung eintragen“ im Kopf gibt es nur bei Herkunft „ablesung“; ohne Quelle stehen „Zähler verbinden“ und „Ablesung eintragen“ gleichwertig in „Woher die Werte kommen“.
- Ziel der Wiedervorlage (`data-entscheid="zaehlerablesung"`) ist der Kopf-Knopf erst, wenn die Ablesungen geladen sind; der Dialog braucht sie zum Vergleich (Konzept Wiedervorlage w1, Entscheid 7).
- „Nächste Ablesung“ kommt aus `quelle.ablesung.faellig_ab` des Registers (API: `AblesungRegeln.ueberfaelligAb(zuletzt)`), nie aus einer Rechnung im Portal; die Zustandszeile spricht nur den Satz des Servers.
- Die Ablesungen stehen neueste zuerst, drei sichtbar, „Alle n ›“; Berichtigen und Fassungen liegen im Menü der Zeile, den Dialog hält die Seite.
- Liegt der Zeitraum seit der letzten Ablesung in EINEM Monat, sagt der Dialog nur „Zählt zum …“ (`zaehltSatz`); die Monatswahl steht erst, wenn er mehr als einen Monat berührt.

## Kacheln

- Die Leitkachel nennt den letzten vollständigen Monat; der Vorjahresvergleich geht über `uemsBericht.vergleich` (Zwilling) und wird mit `zahlMitStellen` des Ergebnis-Vertrags gesprochen, nie über eine eigene Prozentrechnung oder Rundung.
- Ein unvollständiger Monat darf eine Zahl tragen; dann steht die Marke „unvollständig“, und einen Vorjahrespfeil gibt es nur zwischen zwei ganzen Monaten (vollständig oder mit Ersatzwert).
- Ein negativer Monat (saldiert) bleibt negativ: im Verlauf mit seiner Zahl, als Balken mit Betrag und `negativ` (gestrichelt), nie als 0-Balken.
- Ein Monat ohne Wert ist „—“, nie 0; bei einem Ablesezähler nennt die Kachel die fehlende Ablesung mit dem Schritt.

## Zuordnung

- EINE Karte „Zuordnung“ aus `zuordnungZeilen` (`messstelleZuordnung.ts`), Zeilen `zuordnung-ort`, `-stellung`, `-prozesse`, `-verteilung`, je „Ändern“ (Name des Knopfs: „Ort ändern“ usw.).
- Jede Zeile nennt ihre Abschnitte „Historie (n)“, auch die Fassungen der Verteilung.
- Ohne Änderung steht im Dialog grau „Heute gilt: …“ (`zuordnung-gilt-schon`) und der Knopf wartet; ein roter Fehler erscheint erst beim Eintragen.
- Darf jemand die Aktion, aber nicht rückwirkend, nennt `rollen.rueckwirkendGrund()` den Satz `recht_rueckwirkend` aus `rechte-vectors.json` und die Kundenadministratoren aus `/me`.

## Berechnete Messstelle

- „Zusammengesetzt aus“ nennt die Terme von heute; ein Messwert heißt nach seiner Komponente im Aufbau der Anlage (`siteEntities`), nie nach ihrer Kennung.
- „Formel ändern“ öffnet den `SummenwertFormelDialog` (Recht `messstelle.formel`, rückwirkend zusätzlich `aenderung.rueckwirkend`), nicht den Messstellen-Dialog; er braucht die Anlage der elektrischen Stellung.
- Ein Ladefehler der Formel steht mit „Erneut versuchen“; liegen alle Terme außerhalb des Zugriffs, spricht der Hinweis des Servers statt „Noch keine Formel“.

## Wörter

- Ohne Quelle heißt es überall „Noch keine Quelle“ (Kopf statt des Server-Satzes „Keine Datenquelle“, Werte-Karte `ohneQuelle`, Herkunft, Liste).
- Die Zeile „Im Stromnetz“ ändert der Dialog „Stellung im Stromnetz ändern“ (Glossar: Fachwort elektrische Stellung).
- Verbotene Wörter prüft zusätzlich der gerenderte Text (`MessstelleSeite.test.tsx`, „Wörter, wie sie gerendert stehen“).

## Zahlen

- `werteEingabe.betrag` schreibt Tausenderpunkt, Komma und echtes Minus (AP-08 E11); der Q5-Wächter (`src/test/oberflaechenArithmetik.json`) führt das als Textformatierung und prüft auch `messstelleSeite.ts`.

## Prüfen

- Bühne `e2e/messstelle-seite.html`: MS-06 hat Werte erst seit der Einführung (01.10.2026), am Stichtag 20.10.2026 zeigt der letzte volle Monat (September) „—“; Tag-Ansichten öffnet man mit `?wirt=1#/portfolio/messstellen/{id}?periode=JJJJ-MM-TT`.
- Die Fenster der Balken stellen `monatsReihe()` in `messstelle-seite.spec.ts` und `monateDerBuehne()` in `e2e/startansicht.tsx`; ein nicht gestellter Monat bleibt 404.
- `summenwert*.spec.ts` schreiben bei jedem Lauf eingecheckte Bilder nach `e2e/shots/`; nach einem Gesamtlauf mit `git checkout -- frontend/portal/e2e/shots/` zurücksetzen.
- Demo: MS-03 liest automatisch vom Gerät (Messbox der Box Halle 1); Tag und Woche füllen sich erst ab der Bindung, eine rückwirkende Historie gibt es nicht.
