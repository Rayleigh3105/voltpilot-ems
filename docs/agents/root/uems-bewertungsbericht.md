# Energetische Bewertung als Bericht (AP-16 IP-21)

Die Bewertung ist die fünfte Vorlage der bestehenden Bericht-Maschine: `energetische_bewertung`, Geltung Unternehmen,
Zeitraum-Art `datengrundlage`. Ohne angegebenen Zeitraum setzt `BerichtService` die letzten zwölf vollen Monate; die
Wiedervorlage ist am Bericht gespeichert und startet bei zwölf Monaten. Sie leitet noch keine Fälligkeit ab.

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

## Zuständige Dateien und Grenzen

- Vertrag: `docs/contracts/v2/bericht.md`, `bericht-vorlagen.json`, `bericht-vectors.json`, `bericht.schema.json`.
- Migration: `V20260922251800__uems_energetische_bewertung.sql`.
- API-Nachweis: `BewertungRanglisteApiTest.ip21BewertungWirdBytegleichFreigegebenUndIhreBelegeBleibenGeschuetzt`.
- PDF/CSV der neuen Darstellung, automatischer Anstoß, Frist-Ableitung und Portalfläche gehören nicht zu IP-21.
