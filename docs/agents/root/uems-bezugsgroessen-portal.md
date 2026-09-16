# Bezugsgrößen, Import-Assistent und Import-Protokoll im Portal (AP-09 IP-9/IP-15/IP-16)

Die Unternehmenswelt `#/portfolio/bezugsgroessen` liest die vorhandene Liste einschließlich
`bezugsflaechen`. Flächen bleiben Zeilen ohne Bezugsgrößen-ID; der Weg führt zum bestehenden
Gebäude-/Bereichsbaum. Es gibt keine zusätzliche Flächenpflege. Werteingabe und Ablesungen ergänzt
[IP-10](uems-werte-portal.md); Dateiimporte laufen über den Vier-Schritt-Assistenten dieser Fläche.

## Navigation und Rechte

„Struktur“ aus dem AP-09-Konzept ist durch AP-01/AP-13 überholt. Firstmate-Entscheid 001 vom
16.09.2026: eigene Unternehmenswelt neben Messstellen, Kennzahlen und Berichten, sobald ein
lebender Standort misst. Anders als Kennzahlen braucht der Einstieg keine bestehende Bezugsgröße;
der Leerzustand ist damit erreichbar. Keine neue Standortseite; Standort und Prozess sind Filter.
`ebenenNav.ts`, `EBENEN_SEITEN`, `PortfolioTabs` und `App.tsx` tragen denselben Einstieg. Die
Direktadresse lädt für reine Betriebskunden keine Bezugsgrößen. Bei sechs Telefon-Kacheln dürfen
Beschriftungen umbrechen; die bestehenden Leisten mit höchstens fünf bleiben unverändert.

Alle Schreibknöpfe lesen `rollen.ts`: `bezugsgroesse.verwalten` für das Geltungsobjekt. Gebäude,
Bereiche und Messstellen bekommen ihren Standort aus den API-Zuordnungen; Unternehmen, Prozesse
und Kostenstellen gelten unternehmensweit. Eine unbekannte Ortszuordnung öffnet kein Recht.
Der Standortfilter zählt unternehmensweite Objekte keinem Standort zu und erklärt dies.

## Anlegen und Lesen

- `bezugsgroesseListe.ts`: reine Karten, Filter, Geltungsobjekte, Formular und Vertragssätze.
- `bezugsArtKatalog.json`: nur die neun Arten und ihre Vokabulare, ohne Referenzdaten. Der Test
  vergleicht den gesamten Inhalt mit `bezugsdaten-vectors.json`. Einschränkungen ruft das Modul
  bei `bezugsArt.ts` ab. Sieben Anlegearten; Fläche kommt aus AP-02, Ablesung bleibt IP-10.
- **Der API-Vertrag besitzt kein Feld `art`.** Die Art ist die Auswahlhilfe für Einheit, Wertart,
  Periode und Geltungsbereich; nur diese Vertragsfelder werden geschrieben. Aus gespeicherten
  Feldern wird keine Art geraten. Eine dauerhaft gespeicherte Art braucht ein eigenes API-Paket.
- Das Kennzeichen darf leer bleiben; ausschließlich der Server vergibt das nächste freie.
- Auch „Sonstige Menge“ bietet keine Flächeneinheit, da der Server jede zweite Flächenpflege sperrt.
- Zeitgültige Prozesse/Kostenstellen bleiben am letzten Tag wählbar. Aus dem Namen oder einer
  Messstellen-Mitgliedschaft wird keine Standortgeltung eines Prozesses abgeleitet.
- `hat_werte` unterscheidet „Werte vorhanden“ / „Noch keine Werte“. Keine Schätzung des letzten
  Werts, keine Energie- oder Flächenrechnung im Portal. Archivierte Werte bleiben in der Archivliste.
- Die Clientmethoden aus IP-5/IP-6 werden unverändert verwendet; `BezugsgroessenListe` benennt
  ihren Umschlag. Backend und Vertragsdateien werden hier nicht geändert.

## Dateiimport

- `BezugsdatenImportDialog.tsx` führt durch Datei, Spaltenzuordnung, Vorschau und bestätigte
  Übernahme. Die Tabelle scrollt in ihrem Rahmen; auf dem Telefon bleibt der Modal-Fuß erreichbar.
- `api.ts` sendet Vorschau und Übernahme als `FormData`: Datei plus genau eine selbst gepflegte
  Zuordnung oder `vorlage_id`; bei der Übernahme zusätzlich die Vorschau-Kennung und gegebenenfalls
  den wortgleichen Teilübernahme-Satz des Servers.
- Kodierung, Trennzeichen, Kopfzeile, Zähler, Urteile und Befund-Sätze kommen aus der Vorschauantwort.
  `bezugsdatenVorschau.ts` leitet nur Anzeigezahlen und Knopftext ab und formuliert keinen Befund neu.
- Vorlagen gehören dem Kundenbereich. Auswahl und Speichern verwenden die versionierten IP-14-Routen.
- IP-16 ergänzt den Doppelimport-Banner aus dem unveränderten `datei_bekannt`-Serversatz,
  Konfliktentscheidungen je Zeile (Vorgabe behalten), den Sammelhebel „alle ersetzen“ und genau eine
  Begründung. `bezugsdatenImportProtokoll.ts` hält ausschließlich reine Anzeigeableitungen.
- `GET /api/v1/bezugsdaten/importe` liest den Beleg je Kundenbereich, das Detail liefert Zeilen samt
  Befunden. `GET …/{kennung}/ruecknahme/vorschau` und die schreibende Rücknahme verwenden dieselbe
  Planung im Dienst; erst der bestätigte Dialog mit Begründung ruft den POST-Weg auf.

## Nachweise

`bezugsgroesseListe.test.ts`, `apiBezugsgroessen.test.ts`, `copy.test.ts`, Navigation-/Shell- und
Bestandsschutztests; `bezugsdatenVorschau.test.ts` prüft Zähler und Vertragssätze;
`e2e/bezugsgroessen.spec.ts` bei 375/1440 px (Liste, Anlegen, Archivieren, vier Importschritte, B2/B3/B14,
Fokus, Modal/Picker, Rechte, Fehler, O18). `BEZUGSGROESSEN_BILDER` und
`BEZUGSDATEN_IMPORT_BILDER` schreiben Screenshots aus der
Ahrenberg-Bühne. `ansicht=bezugsgroessen-b` ist ausschließlich eine E2E-Ansicht der Alternative
„Reiter unter Messstellen“ für die Mitteilung an firstmate; kein Produktionspfad.
