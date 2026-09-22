# Energetische Bewertung als Bericht (AP-16 IP-21)

Die Bewertung ist die fünfte Vorlage der bestehenden Bericht-Maschine: `energetische_bewertung`, Geltung Unternehmen,
Zeitraum-Art `datengrundlage`. Ohne angegebenen Zeitraum setzt `BerichtService` die letzten zwölf vollen Monate; die
Wiedervorlage ist am Bericht gespeichert und startet bei zwölf Monaten; die Fälligkeit leitet IP-24 beim Abruf ab.

## Abzug und Quellen

`BerichtUnternehmen.bewertung` verwendet die bestehenden Leser `BewertungRanglisteService` und
`BewertungMessabdeckungService`. Der Abzug enthält Umfang, Rangliste, menschliche Einstufungs-Fassungen samt eingefrorener
Herkunft, Messabdeckung, Messbedarf, Messmittel-Angaben, Qualität und Quellenverzeichnis. Zahlen aus Messwerten tragen ihre
Monatsversion, Regeln ihre Kriterien- oder Umfangs-Fassung. `umfang`, `energieeinsatz`, `messbedarf` und `messmittel` sind
additive Quellenarten; der Bildungszeitpunkt ist der Datenstand.

## Belegschutz

Ein freigegebener Stand schützt die von ihm zitierten Objekte über `BerichtsBelege.pruefeObjekt`: Änderungen am
Energieeinsatz, am Messbedarf und an der Messmittel-Angabe antworten vor dem Schreiben mit 409 `berichts_belege`. Eine neue
Einstufungs-Fassung bleibt der vorgesehene Fortschreibungsweg; alte Fassungen werden nicht überschrieben.

## Frist und Übersichts-Baustein (IP-24, S5/S6, R10)

- `BerichtService.uebersicht` hängt an JEDE Bewertung mit Stand `ueberpruefung` (Liste, Kopf, Anlegen, Wiedervorlage,
  Archivieren): reine Regel `BewertungFrist` (Freigabetag des jüngsten Stands in der Zone des Berichts + Monate,
  `plusMonths` fällt auf den Monatsletzten, am Frist-Tag seit 0 Tagen), „heute“ aus der injizierten Uhr
  (`uhrStellen`), Einsätze über `BerichtRepository.einsatzLage` (laufend am Abruftag, wirksame freigegebene Fassung,
  offene Messbedarfe). Nichts wird geschrieben — `BewertungRanglisteApiTest.r10…` zählt die Bericht-Tabellen vorher/nachher.
- ⚠ Die Wiedervorlage wirkt beim NÄCHSTEN Abruf, auch auf den gültigen Stand (S5-Formel); R10 Schritt 4 („gilt ab dem
  nächsten Stand“) ist so gelesen, dass die nächste Frist die neue Monatszahl trägt — ein Schnappschuss am Stand ist nicht gebaut.
- ⚠ Ablösung: eine nicht archivierte Bewertung desselben Unternehmens mit später freigegebenem Stand löst ab
  (`abgeloest_durch`, keine Frist). Archivierte Bewertungen haben keine `ueberpruefung`.
- Portal: rein `bewertungFrist.ts` (wählt die gültige Bewertung, Sätze aus `UEMS_BEWERTUNG_SAETZE`), Render
  `components/BewertungBaustein.tsx` (Grenz-Satz, in `copy.test.ts` `BEWERTUNG_FLAECHEN`), geladen in
  `useUebersichtBausteine` NUR am Unternehmen, mit messender Ebene und `darfAnsehen(selbst)`; Katalog-Baustein
  `bewertung` (beide `catalog.json`, Wächter `CANONICAL_PORTFOLIO` in `migration.test.ts` und
  `CockpitLayoutServiceTest`). Bühne `e2e/bewertung-baustein.html`, Spec `bewertung-baustein.spec.ts`.

## Zuständige Dateien und Grenzen

- Vertrag: `docs/contracts/v2/bericht.md`, `bericht-vorlagen.json`, `bericht-vectors.json`, `bericht.schema.json`.
- Migration: `V20260922251800__uems_energetische_bewertung.sql`.
- API-Nachweis: `BewertungRanglisteApiTest.ip21BewertungWirdBytegleichFreigegebenUndIhreBelegeBleibenGeschuetzt`.
- PDF/CSV der neuen Darstellung, automatischer Anstoß und die Bewertungs-Seite des Berichts gehören nicht zu IP-21/IP-24.
