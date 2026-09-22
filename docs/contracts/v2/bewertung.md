# Energetische Bewertung und Messplanung (AP-16)

Vertrag 1.1 · 22.09.2026 · IP-2/IP-3/IP-4/IP-5/IP-8/IP-9/IP-10/IP-11 / NW-1/NW-2. Grundlage: das entschiedene AP-16-Konzept
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
die Routen stehen in §8. Die Portal-Fläche folgt in einem eigenen Paket.
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

Der Produktivleser ist `GET /api/v1/unternehmen/bewertung/messabdeckung?von=&bis=`.
Er projiziert das Ergebnis von `BewertungMengenLeser` — Nenner, Mengen und Rest werden
nicht erneut gebildet — und liest K8 aus der wirksamen Kriterien-Fassung. Die vollständige
Ahrenberg-Abnahme steht in [`messabdeckung.json`](messabdeckung.json) und läuft zusätzlich
durch Java-, TypeScript- und Python-Zwilling. `BewertungMessbedarfNaht` liest offene
Messbedarfe; Messstellen ohne Datenquelle erscheinen ebenfalls unter `geplant`, stets
ohne Menge.

### 4.1 Messbedarf (P1/P2, R5)

Ein Messbedarf gehört genau zu einem Energieeinsatz und hat ein stabiles Kennzeichen
`MB-…`, Wortlaut, optional Ort, Größe und Frist sowie Zustand `offen`, `eingeloest`
oder `verworfen`. Erfassen und Bearbeiten verwenden
`/api/v1/unternehmen/energieeinsaetze/{id}/messbedarf`; Einlösen und Verwerfen sind
eigene Unterrouten. Jede Änderung speichert Akteur, Zeitpunkt und Vorher-/Nachher-Stand.
Verworfen verlangt eine nicht leere Begründung und bleibt lesbar.

Einlösen ist ausschließlich mit einer eingerichteten Messstelle desselben Mandanten
und im Standort-Zaun möglich. Der Bedarf nennt danach die Messstelle; deren Registerzeile
nennt unter `geplant_fuer_einsaetze` den Einsatz, und `geplantFuerEinsatz=true` filtert
darauf. Eine Messstelle ohne Datenquelle meldet weiter `keine_datenquelle` und keinen
letzten Wert — niemals eine erfundene Null. Offene Bedarfe liefert
`BewertungMessbedarfNaht` an P3 als `geplant`, ebenfalls ohne Menge; eingelöste oder
verworfene Bedarfe erscheinen dort nicht zusätzlich.

Erfassen und Einlösen erzeugen atomar die Kundenereignisse `messbedarf_erfasst` und
`messbedarf_eingeloest`. Datenhaltung und Protokoll erzwingen RLS einschließlich
`FORCE ROW LEVEL SECURITY`; die Laufzeitrolle hat kein DELETE-Recht.

**P4:** `prozess_summe_passt` vergleicht die Quell-Messstellen der Terme jeder
zugeordneten berechneten Messstelle mit den direkt gemessenen Messstellen des
Prozesses. Jeder äußere Term liefert einen Hinweis mit Summe, Messstelle und optionaler
Verteilung. R16: MS-20 enthält MS-07 über 4100; MS-07 gehört nicht P-1 an.
Keine Summe bedeutet keine Hinweise. Ein Hinweis ist kein Fehler und verändert keine
Menge, Formel oder Kennzahl. Die Auflösung verschachtelter Formeln bleibt beim
bestehenden Formelleser; hier werden die zu prüfenden Quell-Terme übergeben.

Der Produktivleser ist `GET /api/v1/unternehmen/prozesse/{id}/messstellen?am=`. Er
liefert die am Tag zugeordneten Messstellen in `gemessen` und `berechnet` getrennt
und die P4-Befunde in `hinweise`. Ein Verteilungs-Term nennt ausdrücklich
`ueber_verteilung: true`, die Kostenstelle und, wenn am Tag vorhanden, ihren Anteil.
Die Bewertungsrangliste reicht dieselben Befunde je Energieeinsatz additiv als
`prozess_summe_hinweise` durch. Beide Wege sind reine Leser; KZ-0004 und alle
anderen Kennzahlen bleiben byte-gleich.

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
Zähler und vor Benutzer/Bezugsgröße/Prozess. Es gibt keinen Seed. Die Routen (§8) prüfen
zusätzlich den Standort-Zaun über Messstellen (R14), nicht über die verantwortliche
Person. `EnergieeinsatzDatenhaltungTest` prüft DB-Grenzen, Referenzwelt und Offboarding;
`UemsProduktionsreihenfolgeMigrationTest` prüft frische DB gegen den Out-of-order-Nachzug.

## 8. Routen (IP-4, B1/B4/B5, R5/R14)

Unter `/api/v1/unternehmen/energieeinsaetze` gelten folgende Wege:

| Methode / Weg | Ergebnis |
|---|---|
| `GET` | `energieeinsaetze`: laufende zuerst, beendete danach; optional `?prozess=<UUID>` |
| `POST` | Prozess, Träger, Name, Wortlaut, Verbraucher-Wortlaut, Verantwortlicher und Einflussgrößen anlegen; `201` |
| `GET /vorschlaege` | Aktuelle Prozesse ohne laufenden Einsatz für Strom, mit demselben Sichtzaun |
| `GET /{id}` | Einsatz mit Kennzeichen, Prozess, Träger, Verantwortlichen-Schnappschuss und aktuellem Konto-Zustand |
| `PUT /{id}` | Name, Wortlaut und Verbraucher-Wortlaut; Protokoll `bearbeitet` |
| `POST /{id}/beenden` | Grund Pflicht, `gueltig_bis` letzter eingeschlossener Tag (Vorgabe heute); Protokoll `beendet` |
| `PUT /{id}/verantwortlicher` | `verantwortlich_sub` aus Benutzern dieses Kundenbereichs, `null` hebt auf; Protokoll `verantwortlicher` |
| `PUT /{id}/einflussgroessen` | Ganze Liste ersetzen, leer hebt alle auf; Protokoll `einflussgroessen` |
| `GET /{id}/protokoll` | Alt/Neu als JSON, Akteur und Zeitpunkt jeder Änderung |

Die Formen stehen vollständig in `openapi.yaml`. Unbekannte Felder (auch ein Mandant im
Anfragekörper) und ungültige Formen sind `400 anfrage_ungueltig`. Semantische Ablehnungen
sind `422 prozess_unbekannt`, `traeger_unbekannt`, `verantwortlicher_unbekannt`,
`einflussgroesse_ungueltig`, `name_fehlt`, `grund_fehlt`, `zeitraum_ungueltig`.
Der partielle Unique-Index liefert auch bei konkurrierenden Anfragen `409 einsatz_laeuft_bereits`.
Nach dem Beenden darf ein neuer Einsatz entstehen; Änderungen am beendeten Einsatz sind
`409 einsatz_beendet`. Anlegen und Einflussgrößen sowie alle anderen Änderungen und ihre
Protokolle sind jeweils eine Transaktion. Datumsvorgaben verwenden die Unternehmens-Zeitzone.

**Rechte und R14:** Schreiben trägt `@Recht("energieeinsatz.verwalten")` mit Geltung Unternehmen
(Kundenadministrator/Energiemanager). Lesen nennt `energieeinsatz.ansehen` im Routen-Kommentar;
GET trägt gemäß `RechtRoutenArchitekturTest` keine Schreibrecht-Annotation. Derselbe vorhandene
Lesezaun wie an Messstellen (`RechtPruefung`) gewährt Unternehmensrollen alle Einsätze,
Standortrollen nur Einsätze mit mindestens einer heute zugeordneten Messstelle im eigenen
Standort; Unterstützung braucht einen gültigen Auftrag. Listen und Vorschläge filtern,
Einzelobjekt und Protokoll antworten außerhalb wie unbekannt mit `404 nicht_gefunden`.
Die Messstellen-Zusammenfassung enthält nur lesbare Messstellen. Zuständigkeit erweitert
keine Berechtigung. Konto-Ende lässt Name/Konto als Schnappschuss stehen und ergänzt
`zustand: entfernt`, `ohne_konto_seit` aus dem bestehenden Zugriffsprotokoll.

**Messstellen und R5:** Direkte, am heutigen Tag gültige Prozess-Zuordnungen liefern Ort und
Lebenszyklus aus dem Register. `letzter_monat` liest den letzten vollen Monat über den
bestehenden Messwerte-Dienst mit Zustand und Einheit; berechnete Messstellen tragen keine
Werteübersicht. `keine_werte` ist wahr, wenn keine direkte gemessene Messstelle dieses Trägers
im letzten vollen Monat eine Menge hat. Es entsteht keine Nullmenge, keine Einsatz-Summe und
keine Einstufung. Unternehmensrollen dürfen auch Prozesse ohne Messstelle verwenden.

**Bezugsgrößen-Löschen:** Der bestehende `DELETE /api/v1/bezugsgroessen/{id}` liefert bei
Verweisen `409 bezugsgroesse_in_verwendung`, `energieeinsaetze: ["EE-…"]` statt eines
Datenbankfehlers. Auch aufgehobene Einflussgrößen und beendete Einsätze behalten ihre
Verweise (RESTRICT aus IP-3); die Bezugsgröße kann archiviert werden. Die Zeilensperre der
Bezugsgröße und die Lesesperre beim Verweisen verhindern ein Rennen mit dem Löschen.

Nachweise: `EnergieeinsatzApiTest`, `EnergieeinsatzSchnittstelleVertragTest`,
`EnergieeinsatzDatenhaltungTest`, `RechtMatrixApiTest`, `RechteKennungenDerRoutenTest`,
`RechtRoutenArchitekturTest`, `BezugsgroesseApiTest`. Keine Migration, keine Bestandsbefüllung;
Lesen vor dem ersten Einsatz verändert nichts (R11).


## 9. Umfang (IP-5, U1/U2/N4, R1/R12)

`GET /api/v1/unternehmen/bewertung/umfang?am=YYYY-MM-DD` liest die gültige
Fassung zum Tag (Vorgabe: heute in der Unternehmenszeitzone). Ohne Fassung antwortet
es mit `200`, `fassung: null`, allen sichtbaren Standorten und Träger Strom als
**ungespeichertem Vorschlag**. Lesen legt weder Umfang noch Energieeinsatz an (R11).

`PUT /api/v1/unternehmen/bewertung/umfang` nimmt `gueltig_ab`, `standort_ids`,
`traeger`, `ausschluesse` und optional `begruendung` an. Der Mandant und der Akteur
kommen ausschließlich aus der Sitzung. Speichern legt Fassung 1 an; Änderungen
legen n+1 an und markieren n mit `aufgehoben_am`. Die alten Inhalte bleiben erhalten.
Identischer Inhalt einschließlich Gültigkeitsbeginn und Begründung ist idempotent;
Standort-/Trägerreihenfolge und doppelte Listeneinträge ändern den Inhalt nicht.
Fassung und `bewertung_aenderung` werden unter derselben Unternehmenssperre geschrieben.

Der Gültigkeitsbeginn darf nicht vor dem Beginn der letzten Fassung liegen
(`422 gueltig_ab_ungueltig`); eine Änderung am selben Tag ersetzt ab diesem Tag.
Am früheren Stichtag gilt weiterhin die damalige Fassung, auch wenn sie inzwischen
als abgelöst markiert ist. Eine zukünftige Fassung verändert den heutigen Umfang
noch nicht. `GET …/umfang/fassungen` liefert alle lesbaren Fassungen, jüngste zuerst,
mit Akteur, Anlagezeit und Ablösezeit; die Anlagen darin werden jeweils am Beginn
der Fassung gelesen. Der Anlagenbestand ist keine eingefrorene Kopie.

**Anlagen und Ausschlüsse:** Die Bilanzgrenze bleibt die Anlage. `standorte[]`
nennt die gewählten Standorte mit Namen, je Standort `anlagen_im_umfang[]` und
`anzahl_anlagen_im_umfang`; dieselben beiden Felder stehen für den ganzen Umfang.
Es zählen die nicht aufgehobenen Bindungen aus `anlage_standort`, deren
`tagesgenaues [gueltig_ab, gueltig_bis]` den Stichtag enthält (letzter Tag inklusive).
Ein Ausschluss nennt `art: standort|anlage|prozess`, `verweis` und eine nicht leere
`begruendung`; sonst `422 begruendung_fehlt` („Bitte begründen Sie jeden Ausschluss.“).
Standort-/Anlagenausschlüsse entfernen die betreffenden Bilanzgrenzen; ein
Prozessausschluss entfernt keine Anlage aus dem Nenner (U2).

Ein Standort ohne Anlage bleibt in der Liste mit leeren Anlagen und Anzahl `0`:
„0 von 0 Anlagen“. Die Zahl sonst ist ausschließlich **y = Anlagen im Umfang**;
IP-5 liefert kein `x`, keine Hauptzählerprüfung und keine kWh. Der Bilanzanteil
und „x von y Anlagen“ folgen mit IP-9. Ein fehlender Bilanznachweis ist keine Null.
Die Träger kommen aus dem Medium-Vokabular. Die Antwort ergänzt `mit_anteil: true`
ausschließlich für Strom; Gas, Wärme, Kälte, Wasser und Druckluft sind
„im Umfang, ohne Anteil“. Ohne Strom ist `nenner_traeger: null`; mit Strom lautet
das Feld `Strom`, noch ohne berechneten Nenner. Keine Umrechnung zwischen Trägern.

**Rechte:** Schreiben verwendet `energieeinsatz.verwalten` (KA U · EM U), Lesen
`energieeinsatz.ansehen`. Die vorhandene Kennung trägt auch den Umfang;
`bewertung.kriterien` und `bewertung.abrufen` bleiben für spätere Pakete reserviert.
GET trägt keine `@Recht`-Annotation. Standortrollen BE/LE lesen ihre Standorte und
Anlagen unter dem bestehenden aktuellen Standort-Zaun, auch in der Historie;
`teilansicht: true` kennzeichnet, dass die Anzahl nur für diese Ansicht gilt.
Fremde Ausschlüsse und unternehmensweite Prozess-Ausschlüsse werden darin nicht
preisgegeben; ein nicht sichtbarer Umfang antwortet wie unbekannt mit `404`.

**Datenhaltung und Löschwege:** `bewertung_umfang`, `bewertung_umfang_standort`,
`bewertung_umfang_ausschluss`, `bewertung_aenderung` haben RLS + FORCE; die App darf
kein DELETE und nur `aufgehoben_am` ändern. Ausschlussverweise werden beim
Einfügen mandantengebunden geprüft und als historische Referenz erhalten.
Insbesondere sperrt ein Anlagen-Ausschluss nicht den bestehenden Anlagen-Löschweg.
Offboarding entfernt Protokoll und Kinder vor Fassung, Standort und Unternehmen;
Existenzproben erhalten ältere Migrations-Teststände. Es gibt keine Bestandsbefüllung.

Nachweise: `BewertungUmfangApiTest`, `BewertungUmfangSchnittstelleVertragTest`,
die sechs Mengen-Migrationsnachbarn, `UemsProduktionsreihenfolgeMigrationTest`,
`UemsZugriffMigrationTest` und die API-Wächter.

## 10. Kriterien-Urteil, Vorschlag und Herkunftsentwurf (IP-10)

`GET /api/v1/unternehmen/bewertung/rangliste` ergänzt die IP-9-Mengen um die
wirksame Kriterien-Fassung und das reine Ergebnis von `BewertungRegeln.urteil`.
Der Stand trägt K7/K8; jeder Einsatz trägt K1–K3 und K5/K6 sowie den Vorschlag
nach KR3. K4 bleibt das Wort einer Person und wird hier nicht erfunden. Der
Vorschlag ist ausdrücklich keine Einstufung; ohne den Schreibweg aus IP-11 bleibt
der Einsatz offen.

Der Herkunftsentwurf je Einsatz enthält Zeitraum, Kriterien-Fassung, Urteil,
Vorschlag und jede gelesene Monatszahl mit Zustand und Version. Bei Strom nennt
er außerdem jeden Bilanzwert des Nenners mit Version und seinen Eingängen. Bei
Trägern ohne Anteil ist `nenner` null und K1–K3 sind `nicht_anwendbar`. Die
Kundenroute liefert keine Annahme-Zahlen aus R6; R6 bleibt ein Vertragsvektor.

K5 gewichtet die Zustände der gelesenen Monatswerte mit den Tagen ihres Monats;
ein vollständiger Monatswert gilt damit für alle seine Tage, ein fehlender nicht.
K6 vergleicht den ungerundeten Ersatzanteil. Anzeigeprozente haben eine
Nachkommastelle, aber K1, K2, K5, K6 und K8 vergleichen ungerundete Größen. Eine
Teilansicht berechnet Urteil, Nenner und Herkunft ausschließlich aus ihren
sichtbaren Anlagen, Einsätzen und Messstellen.

Die Vektoroperation `rangliste` bleibt aus Version 1.0 bestehen; `urteil` ist ihr
additiver Name seit IP-10. Java, TypeScript und Python führen beide über die reine
Funktion `urteil` aus. Damit bleiben vorhandene Leser kompatibel und R2/R6 beweisen
dieselbe Regel in allen drei Zwillingen.

## 11. Einstufungs-Fassungen (IP-11, F1–F5)

`PUT /api/v1/unternehmen/energieeinsaetze/{id}/einstufung` legt ausschließlich durch
eine Person eine Fassung an. Zulässig sind `wesentlich` und `nicht_wesentlich`; eine
nicht leere `begruendung`, `grund` aus K1–K4 und der vollständige `herkunft`-Satz aus
IP-10 sind Pflicht. Fehlt die Begründung, lautet das Urteil `422 begruendung_fehlt`;
eine unvollständige Herkunft ist `422 herkunft_unvollstaendig`. Bei Strom gehören der
Nenner, alle Bilanzwerte und deren Eingänge dazu; jede gespeicherte Zahl trägt ihre
Version und ihren Zustand. Ein anderer Wert als der Vorschlag ist ausdrücklich erlaubt:
beide bleiben in derselben Fassung lesbar. Das System erzeugt nie selbst eine Einstufung.

Eine Fassung hat eine je Einsatz steigende Nummer und gilt ab einem Tag. Die vorherige
wirksame Fassung endet am Vortag; `gueltig_bis` ist einschließlich. Ein früherer Beginn
trägt `rueckwirkend: true`. `GET …/{id}/einstufungen` liefert alle Fassungen, jüngste
zuerst, auch nach einer Rückstufung. Eine Rückstufung ist kein Löschen, sondern eine neue
Fassung mit Begründung und eigenem Herkunftssatz (R13).

Ist `unternehmen.vieraugen_freigabe` aus, wird die Fassung sofort wirksam. Ist sie an,
entsteht sie als `beantragt`, ohne `gueltig_ab`; bis dahin bleibt die bisherige Fassung
wirksam. `POST …/{id}/einstufung/bestaetigen` macht sie am Bestätigungstag wirksam. Der
Urheber darf nicht selbst bestätigen (`403 zweite_person_noetig`); nur eine zweite Person
mit `energieeinsatz.einstufen` darf dies tun. Schreiben verwenden diese Kennung, der
Historien-GET trägt nur den Pflichtkommentar `energieeinsatz.ansehen` und denselben
Prozess-/Messstellen-Zaun wie der Energieeinsatz.

Tabelle `energieeinsatz_einstufung` hat RLS + FORCE, keine App-DELETE-Rechte und nur die
für Gültigkeit und Bestätigung nötigen UPDATE-Spalten. Das Anlegen jeder Fassung protokolliert
`einstufung_gesetzt`, jede Bestätigung `einstufung_bestaetigt` in
`energieeinsatz_aenderung`. Sobald die Fassung wirksam ist, entsteht zusätzlich das
gleichnamige Ereignis `einstufung_gesetzt` mit Energieeinsatz, Fassung, Einstufung und
K1–K4-Gründen; eine beantragte Vier-Augen-Fassung meldet es erst bei der Bestätigung.
Offboarding entfernt die Fassungen vor dem Energieeinsatz.

Nachweise: `EnergieeinsatzEinstufungApiTest` (R3, R13, R17, Herkunft, Rechte und RLS),
`EnergieeinsatzSchnittstelleVertragTest`, `RechtMatrixApiTest`,
`RechteKennungenDerRoutenTest`, `RechtRoutenArchitekturTest` und die Migrationswächter.

## 12. Messmittel-Angaben am Einbau (IP-15, G1–G3, R8, E7 = A)

**G1:** Die Angaben hängen am EINBAU (`geraet`, `V20260922245000`):
`genauigkeitsklasse` (Freitext, höchstens 60 Zeichen), `pruefungsart`
(`eichung` · `mid_konformitaet` · `kalibrierung` · `werksbescheinigung` · `keine`,
das Vokabular von `uems-referenzunternehmen.schema.json`), `pruefung_am`,
`pruefung_gueltig_bis` (nicht vor `pruefung_am`). Alles nullable. Ein
Zählerwechsel legt einen neuen Einbau ohne Angaben an; Z-5a behält seine. Die
Wandler-Klasse steht an der Wandler-Fassung (`quelle_einstellung.klasse`, CHECK:
nur `wandler_strom`/`wandler_spannung`); sie ist eine Angabe, keine Wirkung, und
ändert weder Wert noch Gültigkeit der Fassung.

**G2:** Ein Beleg ist ein Verweis, keine Datei: Bezeichnung, Ablage beim Kunden,
SHA-256 (64 Hex-Zeichen, gespeichert klein; im Portal aus der gewählten Datei
gebildet, die Datei wird nie übertragen), Person (Akteur-Vokabular von AP-03) und
Zeitpunkt. Ganz oder gar nicht (`geraet_beleg_vollstaendig_chk`). Derselbe Verweis
behält beim erneuten Speichern Person und Zeitpunkt seines Eintragens.

**G3:** Ohne Angabe liefert die Route `pruefungsart: nicht_erhoben`,
`genauigkeitsklasse: null`, `zustand: nicht_erhoben`; eine Wandler-Fassung ohne
Klasse `zustand: nicht_erhoben`. Nichts wird vorbelegt, geschätzt oder zu einer
Genauigkeit der Messkette verrechnet. Die Katalog-Angabe „laut Hersteller“ (G4,
IP-16) steht getrennt und ersetzt die Einbau-Angabe nie.

**Routen:** `GET /api/v1/geraete/{id}/messmittel` (Recht `messwerte.ansehen`,
außerhalb des Zugriffs 404) und `PUT …/messmittel` (Recht `messmittel.angaben`:
KA U · EM U · BE S · US Ei, Standort-Zaun über die Anlage des Einbaus). Der PUT
trägt die ganze Angabe; was fehlt, ist nicht erhoben. `wandler[]` nennt nur
Fassungen, deren Klasse sich ändert. 422: `pruefsumme_ungueltig` (Beleg ohne
gültige SHA-256), `beleg_unvollstaendig`, `pruefungsart_unbekannt`,
`zeitraum_ungueltig`, `text_zu_lang`, `fassung_unbekannt`, `klasse_nur_am_wandler`;
400 `anfrage_ungueltig` bei unbekanntem Feld.

**Protokoll:** jede Änderung steht als `messmittel_angabe` mit `alt`/`neu` und
Akteur im eigenen Journal des Einbaus `geraet_aenderung` (RLS + FORCE, nur SELECT
und INSERT; ohne Fremdschlüssel auf `geraet`, damit das Löschen einer Anlage nicht
am Journal scheitert). Es erscheint im Protokoll des Geräts und des Unternehmens
(Sichtbarkeit über das Gerät). Ein unveränderter PUT schreibt nichts.

Nachweis: `MessmittelAngabenApiTest` (R8 GR-2/Z-5b/GR-5, 422, Wandler-Klasse,
Rechte je Rolle mit Zaun, RLS, Offboarding) und `MessmittelSchnittstelleVertragTest`
(DTO ⟷ OpenAPI ⟷ Migration ⟷ Referenz-Vokabular). Nicht hier: Katalog-Genauigkeit
(IP-16), Toleranz (IP-17), Messmittel-Blatt und Dialog im Portal (IP-18), die
Prüfaufgabe im Bewertungsstand (IP-21).
