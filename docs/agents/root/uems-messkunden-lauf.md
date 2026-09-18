# Der durchgehende Messkunden-Lauf: NW-4 (AP-14 IP-7)

Die zweite Hälfte der Abnahme des Programms „Erste Produktfreigabe": ein NEUER reiner
Messkunde geht in EINEM Lauf von der Datenquelle bis zum freigegebenen Bericht.
Referenzfall U5 („Werk Lindach"), Nachweis NW-4, er trägt das Tor G1.

Die Klasse ist `services/api/src/test/java/com/voltpilot/api/uems/UemsMesskundenLaufAbnahmeTest.java`.
Sie schließt den Befund, den AP-07 IP-21 ausdrücklich offen gelassen hat
([Messdatenstrecke](uems-abnahme-messdatenstrecke.md)): „kein einziger Lauf trägt heute von
der Box bis in den freigegebenen Bericht durch".

## Was der Lauf fährt

| # | Schritt (U5) | Wie |
|---|---|---|
| 1 | Kundenbereich nach der Registrierung | Mandant, Unternehmen, Anleger = Kundenadministrator |
| 2 | Standort anlegen | `POST /api/v1/standorte` |
| 3 | Anlage „nur messen" | `POST /api/v1/sites` |
| 4 | Box anmelden | `POST /api/v1/devices/claim` (die Box ist vorab angelegt — die eine Hand des Betreibers) |
| 5 | „Messen & Auswerten" einrichten | `PUT /api/v1/standorte/{id}/funktionen/messen` |
| 6 | Datenquelle aus Katalogvorlage | `POST /api/v1/sites/{id}/data-sources`, SunSpec-Zähler (`sunspec.model_203.totwhimp`) |
| 7 | Messstelle anlegen und binden | `POST /api/v1/messstellen`, `PUT …/ort`, `POST …/quellen` |
| 8 | Werte | Rohzeilen → Viertelstunde → Tag → Periode, endgültig über „Intervallende + 7 Tage" |
| 9 | Kennzahl aus Vorlage | Bezugsfläche von Hand (`PUT …/flaeche`), `POST /api/v1/kennzahlen` |
| 10 | Bericht | Entwurf (Peter) → Freigabe (Anna) → PDF und CSV |

**Die Schritte 2 bis 7 und 9 und 10 gehen über die ECHTEN Routen mit den Rechten des Kunden.**
Kein `INSERT` legt Standort, Anlage, Box, Datenquelle, Messstelle oder Bindung an — das ist der
Unterschied zu NW-2, wo der Kundenweg nicht Teil des Nachweises ist.

## Die eine benannte Naht

Broker → ingest → Writer laufen in diesem Lauf NICHT als Prozess: sie stehen in
`services/ingest` und `services/timescale-writer` und sind aus dem api-Modul nicht startbar.
Mit echtem Redpanda und echtem Writer belegt sie `UemsStreckeAbnahmeTest` (AP-07 IP-21).
Dieser Lauf setzt an deren Ausgang an und schreibt die Rohzeilen in der Form, die der Writer
schreibt. **Die Naht ist eine benannte Stelle, keine stille Annahme.**

## Was der Lauf zusichert

- Der Bericht nennt **endgültige** Zahlen: `fassung = endgültig`, `qualitaet.vorlaeufig = 0`,
  `zusammenfassung.davon_endgueltig = 1`.
- Die Zahl im Bericht ist **nachgerechnet** — letzter minus erster gesendeter Zählerstand,
  nicht die Formel des Produkts. Dafür trägt das Drehbuch den Stand AN der Periodengrenze;
  fehlt er, sagt der Bericht zu Recht „Ende nicht gemessen".
- Die **bewusste Lücke** bleibt sichtbar: keine erfundene Viertelstunde, Abdeckung unter 100 %,
  und der Bericht nennt die Lücke bei den Kennzeichen des Werts.
- Der reine Messkunde liest auf seinem ganzen Weg **kein Wort von Geld, Steuerung oder Fahrplan**.
  `eur`/`euro` taugen nicht als Probe (sie stecken in „Europe/Berlin"), das blosse `steuer`
  auch nicht (`steuerquelle` einer Datenquelle sagt gerade, dass sie NICHT steuert).

## Zwei Befunde, die der Lauf festhält

Beide stehen als Zusicherung IM Lauf: wer sie behebt, macht ihn rot und muss die Zeile
bewusst streichen.

- **B1 — die Anlage-Antwort spricht von Geld und Steuern.** `POST /api/v1/sites` trägt auch
  für eine Anlage „nur messen" die Wörter der steuernden Welt (`marktpraemie…`, `steuer…`).
  Sie ist die einzige Antwort des Kundenwegs, die das tut.
- **B2 — der neue Messkunde fehlt in der Betreiber-Metrik.** Obwohl er einen freigegebenen
  Bericht aus gemessenen Werten hat, taucht er in
  `voltpilot_uems_kundenbereich_letzter_messwert_age_seconds` nicht auf: die Abfrage
  `MESSKUNDEN` (`UemsMetricsRepository`) verlangt `funktion.zustand = 'aktiv'`, und der
  Kundenweg des Referenzfalls richtet „Messen & Auswerten" in Schritt 5 ein — vor Datenquelle
  und Messstelle. Der Betreiber sähe diesen Messkunden also nicht.

Die dreizehn Läufer und ihr Melder stehen in [Betriebsüberwachung](uems-betriebsueberwachung.md).
