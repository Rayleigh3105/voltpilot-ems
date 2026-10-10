# Betriebszeit aus Leistung (AP-16 IP-26, E9 = A)

Vertrag: [`bezugsdaten.md`](../../contracts/v2/bezugsdaten.md#betriebszeit-aus-leistung-ap-16-e9--a).
`BetriebszeitRegeln` und `betriebszeit.ts` prüfen dieselben E9-Prüfungen im B7-Block
von `bezugsdaten-vectors.json`: striktes `>`, 5/2 kW, Fassungswechsel im Monat, Lücken.

- Art `betriebszeit_aus_leistung`, Einheiten h/min; nur `messkanal`. AP-09 `betriebszeit`
  mit Statuskanal/Handeingabe bleibt unverändert. Keine Bestandszuordnung zur neuen Art.
- Die vorhandene POST-Kanalbindung nimmt `messstelle_id`, `schwelle_kw`, `begruendung`
  und `von` an. Quelle wird aus genau einer führenden Wirkleistungsquelle der Messstelle
  gelesen, Katalog `gauge` + `active_power` + W/kW. Keine Quelle aus einer fremden Anlage.
- `bezugsgroesse.verwalten` für jede Fassung, `messwerte.ansehen` für Lesen.
  `V20260922233000` ergänzt die unveränderliche Kanalbindung: Fassung, Vorgänger, Messstelle,
  Schwelle, Grund; vorhandene Akteurfelder und Protokoll. Die Vorgängerin wird nur beendet,
  nie inhaltlich geändert. Vorhandene Periodenwerte sperren rückwirkendes Neubinden wie bisher.
- Rohwerte gelten bis zur nächsten Messung, höchstens eine Kadenz. Explizite Lücken,
  schlechte Werte, ausgelaufene Kadenz und Zeiten ohne gültige Messstellenquelle sind unbekannt.
  W wird vor dem Vergleich zu kW. Kein Messwert = NULL; gemessener Stillstand = 0.
- `KanalbindungLauf` bildet disjunkte Abschnitte, speichert alle Annahmen am Ergebnis;
  endgültige Perioden bleiben wie bei anderen Kanalarten unverändert. Kein neuer Läufer.
- `KennzahlEingangLeser` übernimmt die Annahmen aller Teilperioden und die Qualität der
  neuen Art; `KennzahlRegeln`/`uemsKennzahl.ts` vererben sie auch in Zusammenfassungen
  und gröberen Perioden. Vokabular: `ergebnis-zustand-vectors.json/kennzahl_kennzeichen`.
- Portal liest die vorhandenen Kennzeichen auch neben der wirksamen Zahl und nennt die
  gespeicherte Regel an der Bindung. Konfiguration der neuen Art erfolgt in diesem Paket
  über die API; der unveränderte Anlegedialog bietet sie noch nicht an (kein Schwellenfeld).
- Offboarding löscht Laufzeiger und Bindungen vor Messstellen/Bezugsgrößen. Mandanten-FKs,
  RLS/FORCE und vorhandener fehlender App-DELETE gelten weiter; die neue Messstellen-FK
  schützt auch die wertlose Bindung. Keine Änderung an Box, Optimierer oder GitOps.

Nachweise: `KanalbindungApiTest` (echte Route → Lauf → Werte → Kennzahl-Eingangsleser →
Kennzahl), `BezugsdatenVectorsTest`, `KennzahlVectorsTest`, Portal-Vertragszwillinge,
alle Vertragsleser und Migrationsnachbarn. Quelle/Zustand/Handwerte bleiben in den
bestehenden Kanal-, Bezugsdaten- und Kennzahl-Bestandsschutztests abgedeckt.
