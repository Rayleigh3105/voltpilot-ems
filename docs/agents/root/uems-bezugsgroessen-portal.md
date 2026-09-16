# Bezugsgrößen im Portal (AP-09 IP-9)

Die Unternehmenswelt `#/portfolio/bezugsgroessen` liest die vorhandene Liste einschließlich
`bezugsflaechen`. Flächen bleiben Zeilen ohne Bezugsgrößen-ID; der Weg führt zum bestehenden
Gebäude-/Bereichsbaum. Keine zusätzliche Flächenpflege oder CSV. Werteingabe und Ablesungen ergänzt
[IP-10](uems-werte-portal.md).

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

## Nachweise

`bezugsgroesseListe.test.ts`, `apiBezugsgroessen.test.ts`, `copy.test.ts`, Navigation-/Shell- und
Bestandsschutztests; `e2e/bezugsgroessen.spec.ts` bei 375/1440 px (Liste, Anlegen, Archivieren,
Fokus, Modal/Picker, Rechte, Fehler, O18). `BEZUGSGROESSEN_BILDER` schreibt Screenshots aus der
Ahrenberg-Bühne. `ansicht=bezugsgroessen-b` ist ausschließlich eine E2E-Ansicht der Alternative
„Reiter unter Messstellen“ für die Mitteilung an firstmate; kein Produktionspfad.
