# Energetische Bewertung (AP-16): Wegweiser und Abschluss

Einstieg in alle 28 Pakete von AP-16 (Konzept `vp-uems-ap16-bewertung`, entschieden 22.09.2026). Grundgedanke §3.1:
Zahlen schlagen vor, eine Person stuft ein, nichts verschwindet. Kundenwörter nach SP1–SP3: nie „SEU“,
„ISO-wesentlich“, „automatisch eingestuft“ (Wächter `copy.test.ts`, IP-7). Meilensteine M1–M4 erreicht mit IP-27.

## Einstieg je Paket

| Pakete | Schicht | Wegweiser |
|---|---|---|
| IP-1, IP-2 | Referenzunternehmen 1.6, Vertrag `bewertung-vectors.json`, Zwillinge Java/TS/Python | `uems-bewertung-vertrag.md` |
| IP-3, IP-4 | Energieeinsatz: Tabellen, Protokoll, Routen, Standort-Zaun | `uems-energieeinsatz.md` |
| IP-5 | Betrachtungsumfang mit Fassungen | `uems-bewertung-umfang.md` |
| IP-6, IP-12, IP-18, IP-20, IP-25 | Portal: Welt, Rangliste/Einstufung, Abdeckung/Messmittel, Messplanung, Bewertungsstand | `uems-bewertung-portal.md` |
| IP-7 | Sprach-Wächter und Kundenwörter | `frontend/portal/src/copy.test.ts`, `glossar.ts` |
| IP-8, IP-9, IP-10, IP-14 | Kriterien-Fassungen, Mengen/Nenner/Rangliste, Urteil, Prozess-Summe | unten auf dieser Seite |
| IP-11, IP-28 | Einstufungs-Fassungen, Vier-Augen · Plan-Abnahme (`UemsEinstufungAbnahmeTest`) | `uems-bewertung-einstufung.md` |
| IP-13 | Messabdeckung | `uems-messabdeckung.md` |
| IP-15, IP-16, IP-17 | Messmittel am Einbau, Genauigkeit laut Hersteller, Toleranz je Vergleichsquelle | `uems-messmittel.md`, `uems-katalog-genauigkeit.md`, `uems-vergleich-toleranz.md` |
| IP-19 | Messbedarf | `uems-messbedarf.md` |
| IP-21, IP-22, IP-24 | Bewertung als Bericht, PDF/CSV, Frist beim Abruf | `uems-bewertungsbericht.md` |
| IP-23 | Kaskade und Anstoß (Pfad 1/2) | `uems-bewertung-anstoss.md` |
| IP-26 | Betriebszeit aus Leistung | `uems-betriebszeit-aus-leistung.md` |
| IP-27 | Bestandsschutz, Flag, dieser Wegweiser | unten |

## Bestandsschutz und Flag (IP-27, NW-5, R11)

- **`UemsBewertungBestandsschutzTest`** (Docker, ohne Spring): Ahrenberg aus `infra/local/seed/ahrenberg.sql` auf der
  Fassung VOR `V20260922210000`, dazu MS-12 mit P-1, eine rückwirkende `prozesse_zugeordnet`-Zeile, eine Ortskorrektur und
  ein Monatsbericht. Danach alle späteren Migrationen (auch AP-07 `V20260922236000`). Jede Bestandstabelle ist
  byte-gleich (`Bestandsschutz.fingerabdruck`), einzige benannte Ausnahme `bericht.wiedervorlage_monate`
  (`NOT NULL DEFAULT 12`, `Bestandsschutz.inhaltOhne`; gelesen und ausgegeben nur für `energetische_bewertung`).
  Die 15 neuen Tabellen sind leer; die neue Vorlage ist eine Funktion, keine Zeile.
- **Kein Läufer schreibt für die Bewertung:** der Struktur-Läufer liest nach dem Rollout nur die AP-12-Ortskorrektur;
  `prozesse_zugeordnet` wird erst Kandidat, wenn eine Bewertung besteht. Zweiter Takt und Flag aus schreiben nichts.
  Die Frist hat keinen Läufer (IP-24).
- **Flag `voltpilot.uems.bewertung.enabled`** (`VOLTPILOT_UEMS_BEWERTUNG_ENABLED`, Vorgabe AN, `application.yml`,
  surefire setzt nichts): gelesen nur in `BerichtKaskade` und `StrukturAenderungLaeufer` — Wächter
  `UemsBewertungFlagArchitekturTest`. Aus: Pfad 1 lässt Bewertungsstände aus, Pfad 2 liest keine Bewertungs-Protokolle
  (`UemsStrukturAenderungTest`). Routen, Portal, Freigabe, PDF/CSV und Frist haben keinen Schalter — die Bewertung lässt
  sich nicht dunkel ausliefern; unsichtbar bleibt sie, bis ein Standort misst (Regel der Berichte).
- **Release-Notiz:** Zeile „Unter „Bewertung“ …“ in `docs/rollout/release-notiz-vorlage.md` (Entwurf; Freigabe und
  Versand sind die Hand des Betreibers). Kein Edge-Release, kein gitops-Wert, kein Optimierer.

**Benannte Grenzen (§8.5):** andere Träger nur „im Umfang, ohne Anteil“; Messmittel „nicht erhoben“, bis eine Person
einträgt; Zahlen ab November 2026 sind Annahmen; Schwellen und Fristen sind Startwerte; K2 bleibt `nicht_belastbar`,
bis Halle 1 gemessen ist. Die fünf Glossar-Begriffe aus §6.5 (Energieeinsatz, Einstufung, Messbedarf, Messmittel-Angabe,
Betrachtungsumfang) sind noch nicht im generierten Glossar; `build_fachmodell.py --check` meldet `glossar.md` schon auf
der Basis als VERALTET (Handänderungen aus #855, #909, #1106).

## Mengen, Nenner und Rangliste (IP-9)

`BewertungRanglisteController` liest `GET /api/v1/unternehmen/bewertung/rangliste?von=&bis=`.
`BewertungMengenLeser` liest die Zahlen; `BewertungRanglisteService` verbindet Monatswerte,
Bilanz, wirksame Kriterien-Fassung und den heutigen Betrachtungsumfang. Die Datengrundlage besteht aus ganzen
Kalendermonaten, Anlagen-/Prozessbindungen werden am letzten Tag gelesen.
Die Rangliste zeigt laufende Einsätze; beendete bleiben über die IP-4-Leser und ihr
Protokoll erreichbar und zählen nicht nochmals neben einem Nachfolger.

- N1/N2: Stromnenner nur aus den Bilanzen, mit `x von y`. Ohne Hauptzähler „ohne Bilanz“;
  fehlt eine notwendige Bilanz, kein kleinerer Nenner. Bekannte Mengen bleiben sichtbar.
- Standort-Zaun wie IP-4/IP-5: `teilansicht` benennt den sichtbaren Teilumfang.
  Nenner, Anlagenzahl und Prozessmengen beziehen sich ausschließlich darauf.
  Prozessausschlüsse gelten auch dann, wenn IP-5 sie in einer Teilansicht nicht benennt.
- B3: direkte gemessene Messstellen, keine berechneten Prozesssummen/Verteilungen.
  Mengenlose Einsätze bleiben „keine Werte“. Die Monatswerte mit Herkunft und Version
  bleiben an der Messstellenzeile; Gas wird nicht umgerechnet und hat keinen Stromanteil.
- Ersatzmengen kommen aus den gebildeten Viertelstundenanteilen zum Stand der gelesenen
  Monatsversion. Fehlt dieser Beleg, bleibt die Quote null; kein Anteil wird geraten.
- `BilanzRichtungswerte` liest Laden/Entladen aus den gespeicherten Richtungsanteilen
  statt zweimal die Nettomenge einzusetzen — das Paar der GELESENEN Version: Version 1 aus
  `messreihe_tag`/`messreihe_periode`, eine korrigierte aus `messreihe_periode_version`
  (`V20260923231500`, gebildet von der Kaskade, [Korrektur-Kaskade](uems-korrektur-kaskade.md)).
  Fehlende Paare bleiben unbekannt: Nettomengen-Berichtigung (`wert_berichtigt`), Ersatzwert,
  Versionen von vor der Migration. Der bestehende Bilanzweg nutzt denselben Leser.
- Der Rest der Bewertung ist je Anlage Nenner minus den dort gezählten Einsätzen;
  ein ausgeschlossener Prozess verschwindet nicht aus dem Anlagenverbrauch.
  Eine direkte Messung ohne Anlagenstellung bleibt eine Menge; ihre Verteilung auf
  Anlagen wird nicht geraten. Dann sind die Anlagenreste null und das Ergebnis unvollständig.

Nachweise: `BewertungRanglisteApiTest`, `BewertungMengenLeserTest`,
`BewertungVectorsTest` (NW-1-Vektoren, TS-/Python-Zwillinge),
`BewertungRanglisteSchnittstelleVertragTest`, `BilanzApiTest` und Rechte-/Architekturwächter.
IP-9/IP-10 bringen keine Migration und keinen Läufer.

## Prozess-Messstellen und Prozess-Summe (IP-14, P4/W12)

- `GET /api/v1/unternehmen/prozesse/{id}/messstellen?am=` liest die am Stichtag
  zugeordneten Messstellen und trennt `gemessen` von `berechnet`. Die Route ist ein
  reiner Leser ohne `@Recht`; Unternehmenssicht oder der Standort-Zaun aus IP-4
  bestimmen den sichtbaren Ausschnitt.
- `ProzessMessstellenService` prüft mit `BewertungRegeln.prozessSummePasst`, ob jeder
  Term einer berechneten Prozess-Messstelle eine gemessene Messstelle desselben
  Prozesses ist. Fremde Terme erzeugen nur `prozess_summe_passt`-Hinweise. Bei
  Verteilungen enthalten sie Kostenstelle und Tagesanteil als „über Verteilung“.
- Der Hinweis erscheint additiv in der Ranglisten-Antwort sowie im Portal an
  Prozess-Karte und Rangliste. Er ändert weder Messwerte noch Kennzahlen; insbesondere
  bleibt KZ-0004 bytegleich.
- Nachweis: R16 in `BewertungRanglisteApiTest` (MS-20/P-1 nennt MS-07/P-3),
  `KostenstelleProzessSchnittstelleVertragTest`,
  `BewertungRanglisteSchnittstelleVertragTest` und die Portal-Tests.

## Urteil und Herkunftsentwurf (IP-10, KR2–KR4)

- `BewertungRegeln.urteil` ist in Java, TypeScript und Python rein und rechnet die
  Vektoroperationen `rangliste` und `urteil`. Schwellen vergleichen ungerundete
  Größen; erst Anzeigen erhalten eine Nachkommastelle. K2 wird bei Strom erst mit
  erfülltem K8 belastbar. K7/K8 stehen am Stand, K1–K3/K5–K6 am Einsatz.
- Die Ranglistenroute ergänzt die Zahlen um `kriterien` (Fassung + Werte), `urteil`
  und `vorschlag`. Das ist niemals eine Einstufung; diese setzt erst IP-11 durch
  eine Person mit Begründung. K4 bleibt deshalb hier unbesetzt.
- `herkunft` ist der Entwurf für IP-11: Zeitraum, Kriterien-Fassung, Urteil,
  Vorschlag, jede Einsatz-Monatszahl mit Version/Zustand und bei Strom jeder
  Bilanzwert des Nenners samt Eingangs-Versionen. Weitere Träger haben `nenner: null`.
- K5 gewichtet die Zustände der gelesenen Monatswerte mit deren Kalendertagen;
  K6 verwendet den ungerundeten Ersatzanteil. Der Standort-Zaun wird vor
  beiden Rechnungen angewandt, deshalb verrät auch die Herkunft keine fremden IDs.

## Kriterien-Fassungen (IP-8, KR1, R15/R17)

- `BewertungKriterienController` liest/ändert `GET/PUT /api/v1/unternehmen/bewertung/kriterien`,
  Historie unter `/fassungen`, Entscheidung mit `POST /{nummer}/freigeben|ablehnen`.
  `bewertung.kriterien` schreibt nur KA/EM; GET trägt `energieeinsatz.ansehen` und den Standort-Zaun.
- `BewertungKriterienVertrag` lädt die **verpackten** `bewertung-vectors.json#/startwerte`.
  Die ungespeicherte Fassung 1 heißt „Vorgabe“; GET schreibt nichts. Der erste PUT sichert sie
  und legt Fassung 2 an. `werte` erhält Typen und Feldreihenfolge des Vertrags; `kriterien`
  hält Einheiten/Vergleiche einschließlich K4 ohne Zahl je gespeicherter Fassung fest.
  Die Startwerte werden nicht dupliziert.
- `BewertungKriterienService`: Begründung Pflicht, monotone Nummer unter Unternehmenssperre,
  höchstens ein offener Antrag. Vier-Augen wird beim Antrag eingefroren; nur eine zweite
  Person gibt frei/lehnt ab. Wirksam erst am Bestätigungstag in Unternehmenszeitzone;
  Ablehnungen und abgelöste Fassungen bleiben lesbar. Anstoß auf Berichte erst IP-23.
- `V20260922230000`: RLS + FORCE, nur Freigabe-/Ablösungsspalten änderbar, kein App-DELETE,
  zweiter Akteur auch per CHECK. `bewertung_aenderung` atomar für Anlage/Änderung/Entscheidung.
  `TenantRepository.offboard` entfernt Fassungen vor Unternehmen; keine Fremd-Bestandszeile.
  Die späte-Ankunft-Probe in `UemsZugriffMigrationTest` führt IP-8 unter den IP-5-Nachfolgern.
- Nachweis: `BewertungKriterienApiTest` (Vertragsbytes, R15/R17, Historie, Rechte, RLS,
  Offboarding, Parallelität); `BewertungKriterienSchnittstelleVertragTest` hält die API-Formen fest.
