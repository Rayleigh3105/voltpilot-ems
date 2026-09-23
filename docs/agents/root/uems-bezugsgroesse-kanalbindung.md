# Bezugsgrößen aus Messkanälen (AP-09 IP-17/IP-18)

`KanalbindungService` bindet eine Bezugsgröße mit Periodenwerten an Komponente + Kanal:
`POST /api/v1/bezugsgroessen/{id}/kanalbindung` mit `entity_id`, `kanal`, `von` und bei
`state` mit `zustand`. `GET` derselben Route liest die Bindungen;
`POST …/kanalbindung/{bindung}/beenden` nimmt `bis` entgegen. Verwalten benutzt
`bezugsgroesse.verwalten`, Lesen `messwerte.ansehen`; fremde Objekte bleiben 404.

- Migration `V20260917100000`: `bezugsgroesse_kanalbindung`, RLS + FORCE, USING und
  WITH CHECK, zusammengesetzte Mandanten-FKs, Exklusion mit Mandant zuerst. Minuten,
  `[von,bis)`, nie überschreiben: nur einmal beenden. Urheber und Änderungsprotokoll
  in derselben Transaktion. Keine DELETE-Rechte für die Anwendung.
- K1/K2: nur aktive, liefernde `counter`-/`state`-Kanäle aus der Mess-Selektion mit
  Katalog-Wertart, Beginn frühestens am ersten gespeicherten Rohwert.
  Der Geltungsbereich des Quellstandorts wird zusätzlich zur Bezugsgröße geprüft. Zähler
  brauchen keine Messstelle und keine `quantity`; Einheitenumrechnung ausschließlich
  über `BezugsEinheit`. Zustand braucht eine gewählte Bezeichnung und Dauer-Einheit.
- M5/K6: Eingabe, Berichtigung, Freigabe und Import-Übernahme/-Freigabe prüfen die
  Zeitüberschneidung. `kanal_gebunden` ist 422. Zusätzlich verhindert ein DB-Trigger
  gemischte Quellen und das Binden über vorhandene Werte. Vor/nach der Bindung bleibt
  Eingabe erlaubt. Eine Bindung fixiert die Bedeutung bereits vor dem ersten Wert;
  statt Löschen bleibt Archivieren. Archivierte Bezugsgrößen bildet der Lauf nicht weiter.
- `KanalbindungLauf` läuft in `EndgueltigkeitLaeufer` nach den gemessenen und berechneten
  Messstellen, vor Kennzahlen/IP-14. Keine Änderung an den gemessenen Verdichtern.
  Ohne Bindung keine Schreibtransaktion. Je Bindung eigene Transaktion und Savepoint,
  Fang + Log + `voltpilot_bezugskanal_total{ergebnis="fehler"}`. Ein Zusatzfehler hält
  die anderen Schritte nicht auf. Der Lauf schreibt mit `voltpilot_admin`.
- Zähler rufen `VerbrauchRegeln.mengeZaehlerstand` einschließlich deklarierter Überläufe,
  Gerätegrenzen und Rücksetzungen auf. Zustände rufen `BezugsdatenRegeln.kanal` auf:
  letzter Wechsel vor Beginn, explizite Datenlücken und ungültige Messwerte zählen
  weder als gewählter Zustand noch als sein Gegenteil. Bei Lücken zählt die letzte
  Ereignisfassung; offene Lücken reichen bis zum Periodenende.
- `bezugsgroesse_wert` bleibt append-only. Herkunft `messkanal`, Urheber „Ableitung“;
  `kanal_herkunft` trägt Bindung, Komponente, Kanal, Regel, Zustand, Abdeckung und
  Endgültigkeitsfrist. Der Werte-Leser gibt dies nur bei Kanalwerten als `fassung.kanal`
  hinzu; bisherige Antworten behalten ihre Felder. Kein Wert bleibt NULL, nie 0.
  Der Repository-Leser nutzt `to_jsonb(w)` für die additive Spalte, damit Tests gegen
  frühere Migrationsstände weiter lesbar bleiben.
- Abgeschlossene Kalenderperioden entstehen in der Zone der Bezugsgröße; das Nachholen
  ist auf 32 Perioden je Bindung/Takt begrenzt. Der dauerhafte Zeiger liegt in
  `bezugsgroesse_kanallauf`. Vorläufige Perioden werden neu gebildet, unveränderte
  Ergebnisse schreiben nichts. Mehrere Bindungen innerhalb einer Periode werden über ihre
  disjunkten Zeitabschnitte zusammengeführt, mit allen Quellen in der Herkunft. Nach Ende + sieben Tagen bleiben Fassungen unverändert;
  verspätete Rohwerte gehen über `SpaetankunftMelder` an den AP-08-Korrekturvorschlag,
  nie automatisch in einen endgültigen Wert. Der Eingangszeiger wird atomar gespeichert.
- Offboarding: Laufzeiger → Bindungen → Wertfassungen → Bezugsgröße; vorhandene
  Löschwege für Komponenten dürfen die referenzierte Historie nicht kaskadieren; der FK wird
  an der API als 409 `kanalbindung_vorhanden` benannt.

Abnahme: `KanalbindungApiTest` (B7 4,9667 h / unvollständig / 95,8 %, 422, Vor/Nach,
404, Zähler/Nachlieferung, NULL, Wiederholung, Savepoint, RLS/Rechte, Bestand),
`BezugsdatenVectorsTest` (unveränderte gemeinsame Vektoren),
`EndgueltigkeitLaeuferReihenfolgeTest` und die sechs AP-08-Migrations-Nachbarn.

## Temperatur und Portal (IP-18)

- `V20260917103000` erweitert nur die vorhandene Bindung um `gauge` und zwei numerische
  Parameter; CHECKs für Zähler/Zustand bleiben zulässig. Keine neue Maschine oder Sperre.
- `KanalbindungService` akzeptiert Temperatur (`quantity=temperature`, °C) nur für Kd,
  Standortgeltung und eine passende Anlagen-Zuordnung am Bindungsbeginn. Vorgabe 20/15,
  Raumtemperatur muss über der Heizgrenze liegen. Der Kunde wählt den Außentemperaturkanal;
  der Katalog beschreibt die Temperaturgröße, nicht den Montageort des Fühlers.
- `GradtagRegeln` bildet aus Tagesmitteln Gradtage; Qualität nach AP-08 M1–M6, aber die
  Heizgrenze prüft das ungerundete Mittel (14,96 °C darf nicht zu 15 °C werden). Erst die
  Periodensumme wird vor Vergleich/Schreiben auf NUMERIC(18,6) gerundet; periodische Brüche
  dürfen keinen neuen Wert bei jedem Takt auslösen. Kein Tagesmittel = NULL; fehlende
  oder unvollständige Tage kennzeichnen die Summe. Angeschnittene Kalendertage werden nicht
  zu ganzen Gradtagen hochgerechnet. Herkunft nennt jede Bindungsregel, auch bei Wechseln.
- AP-17 E9 = C (IP-12a): dritte Herkunft `bezogen` — Tagesmittel aus dem Wetter-Archiv
  (`bezugsdaten.md` §„Wetter-Archiv“). `WetterArchivRegeln` ⟷ `wetterArchiv.ts`: nur Tage vor
  dem Abruftag (Ortszone), Kennzeichen `temperatur_bezogen` (Quelle, Abrufzeit) an jeder Zahl,
  geerbt; Ausfall = Tag fehlt, Monat „x von y Tagen“; ohne Koordinaten `variable_fehlt` mit
  `UEMS_KOORDINATEN_FEHLEN_SATZ`. Client, Migration und Portal-Zeile folgen (IP-12b/c);
  `vokabulare.herkunft_art`/`arten` spiegeln bis dahin die Datenbank ohne `bezogen`.
- `GET …/kanalbindung/kanaele` liefert passende Katalogkanäle mit erstem Messwert,
  aktuellem Lieferzustand und gemessenen Zustandsbezeichnungen, nur aus sichtbaren Anlagen.
  Das Recht ist `bezugsgroesse.verwalten`; historische Bindungen bleiben über GET lesbar.
- Portal: `BezugsKanalbindung` verwendet Modal, VpPicker und VpZeitpunktPicker. Auswahl nach
  Wertart/Einheit, Zustandswahl, Temperaturgrenzen, Beginnen/Beenden; fehlende Daten haben
  einen benannten Hinweis. `BezugswertListe` zeigt Regel, Zustand und Abdeckung am Wert.
  `bezugsKanal.periodeGebunden` sperrt die gewählte Kalenderperiode im Eingabedialog;
  die Server-/DB-Sperre bleibt maßgeblich. Alle neuen Hebel verwenden `rollen.ts`.
- Vertrag und alle Leser: `rg -l 'bezugsdaten-vectors.json|bezugsdaten.schema.json' services frontend`.
  B7 enthält ausdrücklich konstruierte Tagesmittel; kein Temperaturmesswert wird Ahrenberg
  zugeschrieben. `KanalbindungApiTest` prüft Tages-/Monatsbildung im echten Job, fehlende Tage,
  Parameterspeicherung, Standortgrenze und unverändert die Zähler-/Zustandsabnahmen.
- Browser: `e2e/kanalbindung.spec.ts`, zusätzlich `werte-eingabe.spec.ts` und
  `bezugsgroessen.spec.ts`; Aufnahme nur auf der echten Prüfbühne, bei 375/1440 Pixeln.
