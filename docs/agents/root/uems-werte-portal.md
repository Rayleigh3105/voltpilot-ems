# Werte und Ablesungen im Portal (AP-09 IP-10)

Die Unternehmenswelt „Bezugsgrößen“ öffnet je Periodenwert „Werte und Fassungen“.
`BezugswertListe` liest alle Fassungen, `BezugswertDialog` schreibt über die vorhandenen
IP-7-Routen. Die letzte abgeschlossene Periode ohne Wert ist vorbelegt. Bereits belegte
Perioden führen zur Berichtigung mit Begründung (10–500 Zeichen). Ein Vorschlag ist keine
wirksame Fassung; die Antwort und das Lesemodell bestimmen die Anzeige. Die Freigabe bleibt
im bestehenden Prüfungsweg. Archivierte Bezugsgrößen bleiben lesbar.

`MessstelleSeite` zeigt `Ablesungen` nur für gemessene Zählerstände ohne führende Kanalquelle.
Die erfolgreiche Quellenantwort ist Voraussetzung; eine fehlgeschlagene Abfrage öffnet keinen
Eingabeweg. Auch beendete Kanalquellen sperren entsprechend `AblesungService.hatKanal`.
IP-8 liefert die Ablesungsfassungen getrennt von komponentengebundenen Quellen.
`AblesungDialog` verwendet die IP-8-Routen einschließlich ihrer bestehenden Korrekturstrecke.

## Eingabe und Zeit

- `zahl.ts` ist die gemeinsame Eingabestelle für `anlageFlow`, `geraetEinstellungen`,
  `moduleSurface` und `zaehlerwechsel`. `parseDecimal` behält ihre bisherige Deutung;
  `ablesestandWert` erhält die bisherige Kombination aus Gruppierung und Dezimalpunkt.
  Die neuen deutschen Felder verwenden `zahlText`: Tausenderpunkte, Dezimalkomma und
  Gruppierungsleerzeichen; zur API geht gruppierter Dezimaltext ohne Gleitkommarundung.
  Das umgeht die bekannte Beschränkung der API-Zahlregel auf dreistellige Gruppen,
  ohne den Vertrag oder den Backend-Parser zu ändern.
- `picker/zeitpunkt.ts` ruft den Zeitzonen-Vertragszwilling `bezugsPeriode` auf.
  `VpZeitpunktPicker` kombiniert die bestehenden Datum-/Uhrzeit-Picker und zeigt die Zone.
  Bei doppelter Stunde muss ein zur Ortszeit passender Versatz gewählt werden; eine
  fehlende Stunde wird nicht verschoben. Der Picker prüft den sichtbaren Uhrzeittext,
  weil `VpTimePicker` bei unlesbarem Text seinen letzten gültigen Wert behält.
- Z6/E5: Monatsanteile und Vorgabe ausschließlich aus `bezugsdaten.zuordnung`.
  Bei mehr als zwei berührten Monaten ist die ausdrückliche Monatswahl oder „keinem Monat
  zuordnen“ nötig. Es gibt keine Mengenrechnung in der Fläche; Mengen der gespeicherten
  Ablesezeiträume kommen aus der API-Antwort. Q5 überwacht beide neuen reinen Module.
- Schreibhebel und Submit verwenden `rollen.ts`: `bezugsgroesse.eingeben` am aufgelösten
  Geltungsstandort bzw. `ablesung.erfassen` im Messstellen-Kontext. Unbekannte Ortszuordnung
  öffnet kein Bezugsgrößen-Schreibrecht. Neue Hebel sind in `migration.test.ts` additiv belegt.

## Grenzen der vorhandenen API

Keine gespeicherte Art wird geraten. Die Schreibrouten nehmen weder Bemerkung noch
Foto-Hinweis an; deshalb erscheinen dafür keine scheinbar speicherbaren Felder. Ein „EMS seit“
für die Liste fehlender Perioden und ein Vorschau-Endpunkt für Plausibilität werden nicht
mitgeliefert: keine erfundene Periodenreihe und keine eigene 50-%-Rechnung. Die Eingabe erlaubt
jede abgeschlossene Periode und zeigt die vom Server gelieferten Hinweise.
Die Ablesungs-Leseroute liefert Herkunft und Korrekturkennung, aber keine Begründung oder
Freigeberdaten der Korrektur. Die Fassungsanzeige behauptet diese Angaben deshalb nicht.

## Nachweise

`zahl.test.ts`, `picker/zeitpunkt.test.ts`, `werteEingabe.test.ts`,
`components/WerteEingabe.test.tsx`, `apiBezugsgroessen.test.ts` und die vier Parser-Aufrufer;
`copy.test.ts`, `migration.test.ts`, `uemsKeineRechnung.test.ts`.
`e2e/werte-eingabe.spec.ts` verwendet die echte Bezugsgrößen- und Messstellen-Seite, prüft
375/1440 px, Fokus, Fehler, Herkunft, Vier-Augen, Rechte, doppelte/fehlende Stunden und Z6.
`WERTE_BILDER` legt echte Screenshots der Ahrenberg-Prüfbühne ab.
