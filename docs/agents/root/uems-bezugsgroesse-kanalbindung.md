# Bezugsgrößen aus Messkanälen (AP-09 IP-17)

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
