# Energetische Bewertung und Messplanung (AP-16)

Vertrag 1.0 · 22.09.2026 · IP-2/IP-3 / NW-1. Grundlage: das entschiedene AP-16-Konzept
§4.2–4.8, §7 R1/R2/R4/R6/R9/R16; E2/E4/E10 = A und W4/W12.
**Zahlen schlagen vor, eine Person stuft ein, nichts verschwindet.**

[`bewertung-vectors.json`](bewertung-vectors.json) enthält die verbindlichen Eingänge und
Ergebnisse; [`bewertung.schema.json`](bewertung.schema.json) schließt unbekannte Felder aus.
Jeder Vektor läuft unverändert in Java (`uems/BewertungRegeln`), TypeScript
(`uemsBewertung.ts`) und Python (`voltpilot_optimization/bewertung.py`).
Die Python-Funktionen `menge`, `prozent` und `rangliste` sind aus `k_faelle.py` des Konzepts
überführt; Reportbau und Beispielkonstanten sind entfernt. Dessen Vergleich gerundeter
Prozente und dessen Epsilon-Rundung sind gemäß KR4 korrigiert. `fall` war ausschließlich
eine Report-Hülle; ihre Rolle übernehmen `name`, `quelle`, `eingang`, `erwartet` der Vektoren.

Die Rechenregeln erzeugen keine Einstufung. Die Datenhaltung des Energieeinsatzes steht in §7;
Routen und Portal-Fläche folgen in eigenen Paketen.
Noch kein Produktivaufrufer ist angebunden. Die Eingänge sind bereits gelesene Bilanz-
und Monatswerte derselben Periode und desselben Trägers. Verbrauchsbildung, Bilanz,
Kennzahlen und Prozess-Summen bleiben bei ihren bestehenden Verträgen (W4).
Zeitgültige Zuordnungen und deren Quellen liest der spätere Aufrufer am Stichtag.

## 1. Umfang und Nenner (U1/U2, N1/N2)

- **N1:** Der Stromeinsatz einer Anlage ist `Zufluss − Abgabe − Laden` ihrer
  [Bilanz](bilanz.md), also zugeordnet plus Rest. Zufluss umfasst Netzbezug, Erzeugung
  und Entladen. Ohne Hauptzähler Bezug oder ohne einen notwendigen Bilanzwert ist der
  Wert `null` (ohne Bilanz), niemals null Kilowattstunden.
- **N2:** Der Umfang summiert seine Anlagen und nennt immer `x von y Anlagen`.
  Fehlt eine Bilanz, ist der Nenner `null`, Zustand `unvollständig`; bekannte Anlagen
  bleiben einzeln sichtbar. Es wird kein kleinerer Nenner für Prozentanteile gebildet.
  Jeder betroffene Strom-Anteil trägt `unvollständig`. Ohne Anlage: `0 von 0`, Menge 0,
  kein Prozent. Auch ein vollständiger Nenner 0 erzeugt keinen Anteil.
- Ein Gebäude ist kein Nenner (N3). Nur Strom hat einen Nenner; Gas, Wärme, Kälte,
  Wasser und Druckluft bleiben im Umfang ohne Anteil, ohne Umrechnung (N4/E3).

R1: AN-1 `150400 − 3120 − 7900 = 139380`, AN-2 `36900`, AN-3 `9100`;
Nenner **185380 kWh**, 3 von 3. Zugeordnet **125740 kWh**, Rest **59640 kWh**,
Abdeckung **67,8 %**. Rest je Anlage: 54580 / 3860 / 1200 kWh.

## 2. Mengen (B3)

**B3:** Menge = Summe der direkt zugeordneten **gemessenen** Messstellen desselben
Trägers. Berechnete Messstellen, Verteilungs-Terme, indirekte Zuordnungen und archivierte
Messstellen zählen nicht. Eine doppelte Messstellenkennung im ausgewählten Eingang
wird als `messstelle_doppelt` zurückgewiesen. Der spätere Leser muss Messstellen eines
Trägers eindeutig einem Einsatz zuordnen; keine Kilowattstunde darf zweimal zählen.

Eine geplante Messstelle hat `wert: null`, nicht 0. Sind alle Werte unbekannt, bleibt die
Menge `null`; bei teilweise bekannten Werten bleibt die bekannte Menge mit Zustand
`unvollständig`. Ersatzmengen sind **Teil** der Menge und werden separat ausgewiesen,
nicht noch einmal addiert. Abgelesene Mengen zählen ebenfalls; ein Kanal ist keine
Voraussetzung. Die Einheit bleibt die des Trägers (hier Strom kWh, Gas m³).

R4: EE-1 = MS-06 + MS-11 = **77500 kWh**, EE-3 = MS-07 = **15900 kWh**.
MS-20 = 88630 kWh einschließlich 11130 kWh Druckluft über Verteilung 4100 ist eine
Prozess-Summe und wird niemals zur Menge von EE-1. KZ-0004 bleibt unverändert.

## 3. Kriterien, Urteil, Vorschlag und Rangfolge (KR2/KR3/KR4)

Fassung 1 verwendet diese Startwerte (Quelle: `kriterien.json`, im Referenzunternehmen
1.6 unter `bewertung_kriterien`). Eine spätere Fassung wird als vollständiger
Parametersatz übergeben; alte Stände behalten ihren Satz.

| Kriterium | Kundenwort | Startwert / Regel |
|---|---|---|
| K1 | Anteil am Stromeinsatz | Menge / Nenner ≥ 10 % |
| K2 | Im 80-%-Block | Nach Menge absteigend bis kumuliert 80 % der zugeordneten Menge |
| K3 | Jahresmenge | ≥ 100000 kWh bei genau zwölf vollen Monaten; keine Hochrechnung |
| K4 | Begründete Einschätzung | Wortlaut der Person, ohne Rechenurteil und ohne Schwelle |
| K5 | Datenlage | ≥ 90 % der Tage mit allen Messstellen vollständig |
| K6 | Ersatzwert-Anteil | ≤ 5 % der Menge aus Ersatzwerten |
| K7 | Zeitraum der Datengrundlage | zwölf volle Monate; unter drei Monaten vorläufig |
| K8 | Messabdeckung | zugeordnete Menge / Nenner ≥ 80 % |

Weitere Startparameter: letzte zwölf volle Monate, mindestens drei volle Monate,
Wiedervorlage zwölf Monate, Toleranz je Vergleichsquelle 2 % pro Monat.
K5/K6 bekommen ungerundete Anteile aus den vorhandenen Monatswerten; unbekannte
Qualität (`null`) erfüllt kein Kriterium und trägt den jeweiligen Vorbehalt.

- **KR2:** Geschlossene Urteile K1–K3/K8: `ueber_schwelle`, `unter_schwelle`,
  `nicht_anwendbar`, `nicht_belastbar`. K1 ohne Nenner und K3 außerhalb genau zwölf
  voller Monate sind nicht anwendbar. Für Träger ohne Nenner sind K1–K3 und K8 nicht
  anwendbar. K2 ist bei Strom nur belastbar, wenn K8 die Schwelle erfüllt; bei leerer
  oder vollständig mengenloser Gruppe ist es nicht anwendbar.
  K5: `erfuellt` / `vorbehalt_datenlage`; K6: `erfuellt` / `vorbehalt_ersatzwerte`;
  K7: `erfuellt` / `unter_zwoelf` / `vorlaeufig`. K7 bezeichnet den Zeitraum des
  Berichts; fehlende Daten innerhalb zwölf Monaten kennzeichnet K5, nicht K7.
- **KR3:** `vorschlag = ueber_schwelle` genau dann, wenn K1, K2 oder K3 so urteilt;
  sonst `unter_schwelle`. K4 bleibt Wortlaut. Kein Ergebnis dieses Moduls ist eine
  Einstufung; die menschlichen Zustände sind `wesentlich`, `nicht_wesentlich`, `offen`.
- **KR4:** Absteigend nach ungerundeter Menge, bei Gleichstand aufsteigend nach
  Kennzeichen (zeichenweise, ohne Sprachsortierung). Mengenlose Zeilen stehen zuletzt,
  ohne Rang. Weitere Träger bekommen keinen Strom-Rang. Kumuliert wird ausschließlich
  die zugeordnete Menge dieses Trägers. Die Zeile, die 80 % erstmals erreicht oder
  überschreitet, gehört noch zum Block; die nächste nicht mehr. Entscheidend ist also
  der kumulierte Anteil **vor** der Zeile.
- Prozentwerte werden **nur zur Anzeige** kaufmännisch auf eine Nachkommastelle
  gerundet (`HALF_UP`). Vergleiche verwenden ungerundete Werte, umgesetzt als exakte
  Kreuzprodukte. **Nie auf eine Schwelle aufgerundet:** 9,95 % wird als 10,0 % angezeigt,
  bleibt für K1 aber `unter_schwelle`. Entsprechend bleibt 79,95 % für K8 unter 80 %;
  nach 79,95 % gehört die nächste Zeile noch zum K2-Block.

Mengen und Prozentanzeigen sind Dezimaltexte, niemals binäre Gleitkommazahlen.
Mengen werden ohne unnötige Nachkommastellen ausgegeben; Prozentanzeigen haben genau
eine Stelle. Wiederkehrende Quotienten werden nicht als gerundete Zwischenwerte
zurück in eine Rechnung gespeist. Alle drei Tests vergleichen die vollständige Ausgabe
exakt, einschließlich `null`, Zuständen, Reihenfolge und Wortlaut.

R2: 77500 / 15900 / 9640 / 8700 / 7800 / 6200 kWh in dieser Rangfolge.
K2 ist durchgehend nicht belastbar, K3 nicht anwendbar, K7 vorläufig.
R6 (**Annahme**, keine Messwerte 2027): Nenner 2200000, zugeordnet 1804000, 82,0 %;
EE-1 → EE-8 → EE-3 → EE-2 bilden den Block (83,8 %), EE-6 liegt dahinter und
überschreitet K3. EE-8 trägt K5-Datenvorbehalt (66,7 %). Diese Vorschläge ändern keine
Einstufung und keinen alten Stand.

## 4. Messabdeckung und Prozess-Summe (P3/P4)

**P3:** Dasselbe reine `abdeckung` läuft je Einsatz, je Ort/Anlage und für den Umfang.
Die Eingänge sind jeweils ausgewählte Messstellen, offene Bedarfe und Bilanzreste.
Die Ausgabe nennt `gemessen`, `geplant`, `ersatz_messstellen` und `ungemessen`:

- Gemessen: direkte gemessene Messstellen mit Werten; Ersatz ist eine gekennzeichnete
  Teilmenge dieser Mengen.
- Geplant: offene Bedarfe oder Messstellen ohne Werte/Quelle. Ein eingelöster Bedarf
  steht nicht zusätzlich zu seiner Messstelle in der Liste.
- Ungemessen: übergebener Rest der Bilanz, nie aus einer Prozess-Summe gerechnet.
  Ohne zugehörige Bilanz steht `null`. Der Hinweis auf Rest AN-1 bei EE-8 ist ein
  Verweis auf dieselbe Restzeile; für den Umfang werden ausschließlich die Reste der
  Anlagen einmal summiert, niemals die Einsatz-Abdeckungszeilen zusammengezählt.

R1/§5.3: 125740 gemessen/zugeordnet, MS-23 geplant, Ersatz 0, ungemessen 59640;
K8 unter Schwelle. MS-23 macht den vorhandenen Mengenanteil nicht null und erhält
selbst keine Menge. Archivierte und berechnete Messstellen sind nie gemessen.

**P4:** `prozess_summe_passt` vergleicht die Quell-Messstellen der Terme jeder
zugeordneten berechneten Messstelle mit den direkt gemessenen Messstellen des
Prozesses. Jeder äußere Term liefert einen Hinweis mit Summe, Messstelle und optionaler
Verteilung. R16: MS-20 enthält MS-07 über 4100; MS-07 gehört nicht P-1 an.
Keine Summe bedeutet keine Hinweise. Ein Hinweis ist kein Fehler und verändert keine
Menge, Formel oder Kennzahl. Die Auflösung verschachtelter Formeln bleibt beim
bestehenden Formelleser; hier werden die zu prüfenden Quell-Terme übergeben.

## 5. Vergleichsquelle (G5)

**G5:** Die Toleranz gehört als Fassung an die Vergleichsquelle, Startwert **2 %** je
Monat. Abweichung = `abs(führend − Vergleich) / führend × 100`. Ein Befund entsteht
bei **streng größerer**, ungerundeter Abweichung. Genau 2 % erzeugt keinen Befund;
2,01 % erzeugt einen, auch wenn die Anzeige 2,0 % lautet. Ohne führenden Wert, ohne
Vergleich oder bei führend ≤ 0 ist die Prüfung unbekannt (`befund: null`), niemals
„passt“. Keine Ursache, kein Ersatzwert, keine Änderung der Eingangswerte.

R9 (**Annahme**): 131200 zu 129700 → **1,1 %**, kein Befund;
131200 zu 126700 → **3,4 %**, Befund ohne Ursache.

## 6. Nachweis und Grenzen

62 Vektoren: N1 1, N2 5, B3 12, KR2 9, KR3 2, KR4 6, P3 15, P4 3, G5 9.
`BewertungVectorsTest`, `uemsBewertung.test.ts`, `tests/test_bewertung.py` fahren alle
gegen dieselbe Datei. Schema-Negativproben verwerfen zusätzliche Felder und Float-
Mengen. Der Python-Test verbindet die Oktoberzahlen und Startkriterien zusätzlich mit
`uems-referenzunternehmen.json` 1.6. Der Nenner-Nullfall, fehlende Anlagen, K5/K6-
Grenzen, geplante Messstellen und K2-Blockgrenzen sind eigene Vektoren.

Nicht Bestandteil dieses Nachweises: Datenbankleser, Fassungsverwaltung, Rechte,
Einstufungs-Schreibwege, Kaskaden und sichtbare Flächen; dafür folgen eigene Pakete.
Die Regeln erzeugen weder Box-Aufträge noch Optimiererpläne und benötigen kein Docker.

## 7. Datenhaltung (IP-3, B1/B4/B5)

`energieeinsatz` ist ein eigenes Objekt mit genau einem unveränderten Prozess und einem
Träger aus dem Medium-Vokabular (`Strom`, `Gas`, `Wärme`, `Kälte`, `Wasser`, `Druckluft`).
`energieeinsatz_kennzeichen_seq` zählt je Mandant atomar `EE-1`, `EE-2`, …; die Kennzeichen
bleiben nach dem Ende belegt. Der partielle Unique-Index `(tenant_id, prozess_id, traeger)
WHERE gueltig_bis IS NULL` verhindert einen zweiten laufenden Einsatz. Tage gelten
inklusive `gueltig_bis`; Beenden setzt zusätzlich Zeitpunkt und Grund. Name, Wortlaut und
Verbraucher-Wortlaut stehen am Einsatz. Relevante Unterprozesse bleiben Prozesse; die
Referenzwelt 1.6 benötigt keine zusätzliche Komponenten-Verknüpfung und kein Verbraucherobjekt.

`verantwortlich_sub` verweist mit `tenant_id` auf `benutzer`; Name und Konto werden beim
Setzen aus dem Benutzerspiegel kopiert. Ein Konto-Ende löscht den Spiegel nicht: der Leser
liefert dessen Zustand und bei Entfernung den Zeitpunkt aus `zugriff_protokoll` als
`ohneKontoSeit`, der Name bleibt als Schnappschuss. Verantwortung verleiht kein Recht.
`energieeinsatz_einflussgroesse` trägt geordnete Verweise auf Bezugsgrößen oder genau einen
Wortlaut; `art` ist geschlossen auf `produktion`, `betriebszeit`, `wetter`, `sonstige`.
Bei Referenzeinträgen ist deren `text` die Beschriftung der Bezugsgröße, kein zusätzlicher
Wortlaut. Ersetzen hebt Vorgänger auf und fügt neue Zeilen an; es wird nichts gerechnet.

`energieeinsatz_aenderung` hält `angelegt`, `bearbeitet`, `verantwortlicher`,
`einflussgroessen`, `beendet` mit Alt/Neu-JSON, Akteur und Zeitpunkt. Die mutierenden Methoden
von `EnergieeinsatzRepository` sperren den Einsatz und schreiben Änderung plus Protokoll in
einer Transaktion. Alle vier Tabellen haben RLS und FORCE mit USING/WITH CHECK sowie
gezielte App-Grants; das Protokoll ist für `voltpilot_app` nur lesbar und anfügbar, DELETE
bleibt überall entzogen. Zusammengesetzte Fremdschlüssel verhindern mandantenfremde Ziele;
eine referenzierte Bezugsgröße kann auch über ihren bestehenden Löschweg nicht verschwinden.
Nur `TenantRepository.offboard` löscht administrativ: Protokoll/Einflussgrößen vor Einsatz,
Zähler und vor Benutzer/Bezugsgröße/Prozess. Es gibt keinen Seed und keine Route. Die spätere
Route prüft zusätzlich den Standort-Zaun über Messstellen (R14), nicht über die verantwortliche
Person. `EnergieeinsatzDatenhaltungTest` prüft DB-Grenzen, Referenzwelt und Offboarding;
`UemsProduktionsreihenfolgeMigrationTest` prüft frische DB gegen den Out-of-order-Nachzug.
