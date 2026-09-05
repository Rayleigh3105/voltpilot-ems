# Eigene Auswertung: der Kunde baut seine KENNZAHL (Anwendungs-Programm Stufe 5)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 121).


Die Stufe B der Cockpit-Freiheit (Scout `data/vp-portal-zielbild-anwendungen` §3.6 / §5 Stufe 5;
Captain-Entscheide §7: **kein Teilen, kein Export, nur der Anlagen-Scope**). Der Kunde macht sich
aus einem Messwert seiner Anlage eine eigene Kachel oder einen eigenen Verlauf. **Ohne einen
einzigen Eintrag verhält sich jede Anlage zeichengleich wie vor dieser Stufe** — gepinnt rein
(`migration.test.ts` „Stufe 5: OHNE eigene Auswertungen ist alles Zeichen für Zeichen wie vorher")
UND am DOM (`AnlagenPage.test.tsx`).

- **KEINE Migration, KEIN neuer Speicher.** Die Definitionen wohnen in
  `cockpit_layout.document.custom[]` — die Spalte ist `jsonb`, das Feld also rein additiv. Die
  WERTE kommen aus `EntityHistoryRepository`, demselben Pfad, aus dem der Messwerte-Explorer seine
  Kurven zieht (samt der MIG-B2-Naht, die einer migrierten Anlage ihre v1-Historie erhält). Eine
  zweite Messwert-Quelle wäre eine zweite Wahrheit über dieselbe Zahl.
- **⚠ DIE EHRLICHKEITSREGEL, und sie ist ein ZWILLING mit geteilten Vektoren**
  (`docs/contracts/v2/eigene-auswertung-vectors.json`; Java `cockpit/EigeneAuswertung` ⟷ TS
  `frontend/portal/src/eigeneAuswertung.ts` — **beide Seiten und die Vektor-Datei zusammen
  ändern**). Der SERVER entscheidet (400 mit deutschem Grund), die Fläche spiegelt die Regel nur,
  um dem Kunden den Klick zu sparen — dem Client zu glauben wäre keine Prüfung.

  | Kanalart | erkannt an | jetzt | tagessumme | tagesmax | tagesmittel |
  |---|---|---|---|---|---|
  | `energie` | `*_kwh`, `*_wh`, `*energy*` | ja | **ja** | nein | nein |
  | `leistung` | `*_kw`, `*_w`, `*power*` | ja | nein | ja | ja |
  | `anteil` | `*_pct` | ja | nein | ja | ja |
  | `messwert` | alles Übrige | ja | nein | ja | ja |

  **⚠ Die REIHENFOLGE der Erkennung ist selbst eine Regel:** `_pct` wird ZUERST geprüft (ein
  Prozentsuffix ist die eindeutigste Aussage, die ein Kanalname machen kann — stünde es hinter der
  Energie, bekäme ein `energy_pct` die Tagessumme eines Zählerstands, also eine Summe über
  Prozentwerte), danach Energie VOR Leistung (`_kwh` endet nicht auf `_kw`).

  **Beide Verbote hängen an DERSELBEN Tatsache: ein kWh-Kanal meldet in diesem Haus einen
  ZÄHLERSTAND** (die Hausregel steht in `ConsumerRequirementStateRepository.energyOverPeriod` — die
  Energie einer Periode ist `max − min`, der ZUWACHS). Eine Tagessumme über Leistung oder
  Temperatur addiert Momentanwerte; Höchstwert und Mittel eines Zählerstands sind keine Aussage
  (der Höchststand IST der Endstand). Die **Kanalart kommt aus dem NAMEN**, nicht aus der
  gemeldeten Einheit — das Kanal-Vokabular ist offen (ein Selbstbau-Gerät benennt seine Kanäle
  selbst) und die Einheit optional; ein unbekannter Kanal ist `messwert`, die Art, die am
  wenigsten behauptet.
- **⚠ Die Tagessumme ist der ZUWACHS (`max − min`), nie die Summe der Messwerte** — sie zu addieren
  ergäbe das Vielfache des Zählerstands (im Testcontainers-Beweis mit der falschen Zahl daneben
  festgehalten).
- **⚠ Und sie gilt NUR auf einer MONOTON steigenden Reihe — die Prüfung auf ein negatives
  Vorzeichen wäre wirkungslos.** `max − min` ist per Konstruktion nie negativ: bei einem Zähler,
  der mittags von 950 auf 5 springt, kämen 945 kWh heraus statt der wirklichen ~57, und der
  `signum() < 0`-Schutz (den auch `energyOverPeriod` trägt) griffe nie. Der Server prüft deshalb
  die REIHE: fällt sie irgendwo, gibt es KEINE Zahl. Dieselbe Regel fängt eine zweite Lage mit —
  einen Kanal, der gar keinen Zählerstand meldet, sondern die Energie JE INTERVALL; dort wäre
  `max − min` die Differenz zweier Intervallwerte und bedeutete nichts. **Der Schutz war zuerst
  als Vorzeichen-Prüfung gebaut und fiel im Testcontainers-Lauf als tote Bedingung auf.**
- **Alle vier Kennzahlen rechnet `cockpit/EigeneAuswertungService` aus den Tages-Eimern.**
  `tagesmittel` ist STICHPROBEN-GEWICHTET
  (`Σ avg·n / Σ n`) wie `verlaufStats` im Portal, und `jetzt` ist der `last` des jüngsten belegten
  Eimers — aus DERSELBEN Reihe, die das Chart zeichnet, damit Kachel und Kurve nie Verschiedenes
  behaupten können.
- **Katalog:** `eigene-auswertung` ist von `reserviert` auf die Klasse **`regel`** gehoben (Schalter
  = reine ABSICHT: kein Gate, kein Starter) und steht in **keinem Preset** auf `an`. **⚠ Ihr
  `leer_zustand` bleibt bewusst NULL:** der Server kann die Leere nicht belegen (sein Beleg
  `hasCustomerRule` zählt aktive Flows, nicht Kacheln), und was er nicht belegen kann, behauptet er
  nicht — der Leer-Hinweis lebt im Cockpit, wo der Knopf steht. Die zwei ARTEN stehen als
  **`baustein_vorlagen`** im selben Katalog (nicht unter `bausteine`): eine Vorlage ist NICHT
  renderbar, erst ihre Instanz `eigen:<id>` ist es, und die kanonischen Listen dürfen keinen
  Schlüssel führen, den niemand rendert. `nach` sagt, hinter welchem Baustein eine Instanz
  kanonisch einsortiert wird (heute: hinter den Kennzahlen).
- **⚠ Ein `eigen:`-Schlüssel ist nur bekannt, weil DASSELBE Dokument ihn definiert.**
  `CockpitLayoutService.validate` nimmt ihn in `order`/`hidden` an, wenn `custom` ihn trägt, und
  lehnt ihn sonst ab — eine Reihenfolge, die eine Kachel nennt, die es nicht gibt, wäre ein
  Schlüssel, den niemand rendern kann. Zusätzlich geprüft wird, was die reine Klasse nicht wissen
  kann: dass die Komponente zu DIESER Anlage gehört (RLS — eine fremde ist über `entityForSite`
  schlicht nicht auffindbar) und dass sie diesen Messwert überhaupt meldet.
- **Nur die ANLAGEN-Fläche trägt sie.** Das Portfolio hängt am KUNDEN und hat keine einzelne
  Komponente, gegen die ein Kanal zu prüfen wäre; eine Kachel dort wäre eine Zusage über Messwerte,
  die je Anlage verschieden sind (400 mit Grund).
- **Lesepfad `GET /api/v1/sites/{siteId}/eigene-auswertung?at=`** (`SiteEigeneAuswertungController`,
  RLS-gefenced wie jede `/sites/**`-Route — kein `@PreAuthorize`, fremde Anlage 404; in
  `openapi.yaml`). EINE Route für ALLE eigenen Bausteine: das Cockpit rendert sie gemeinsam, und
  mehrere Kacheln auf derselben Komponente teilen sich server-seitig eine Abfrage. Sie nimmt
  **keine Definition entgegen** — was auf dem Cockpit steht, entscheidet das Layout-Dokument; eine
  Route, die eine mitgeschickte Definition beantwortet, wäre ein zweiter Weg an der Prüfung des
  Schreibpfads vorbei. `wert` ist `null`, wo es keinen gibt — **nie eine 0**.
- **⚠ Jede fehlende Zahl nennt IHREN Grund** (die Disziplin der gesperrten Wahl im Dialog, auf
  Werte angewandt). Serverseitig gibt es genau zwei Lagen: der Kanal hat heute nichts gemeldet,
  oder die Reihe eines Zählerstands ist gefallen („Dieser Zählerstand ist heute nicht durchgehend
  gestiegen"). Eine dritte lebt in der FLÄCHE: eine im Anpassen-Modus frisch angelegte Kachel
  kennt der Server noch nicht — sie sagt „noch nicht gespeichert", nie „keine Messwerte" (das wäre
  die gefährlichere der beiden Auskünfte, der Kunde suchte einen Datenfehler).
- **⚠ Die Sichtbarkeit hängt an der ANWENDUNG, die DEFINITIONEN überleben sie.** Ist „Eigene
  Auswertung" ausgeschaltet, rendert keine Kachel und es wird nicht einmal gefragt — aber ein
  Speichern trägt die Definitionen trotzdem mit (`useCockpitLayout` trennt `alleEigene` von den
  sichtbaren). Ohne diese Trennung löschte ein Speichern bei abgeschalteter Anwendung genau das,
  was ein Wiedereinschalten zurückbringen soll (die tragende Regel der Stufe 3). **Im DOM-Test
  aufgefallen, nicht im Unit-Test.**
- **⚠ Die Quelle für „ist sie an?" ist das REGAL, nicht `modes`.** `eigene-auswertung` wird NIE
  abgeleitet (wie `ueberschuss`), taucht also in der M0-Projektion gar nicht auf; `active` der
  Regal-Karte (`SiteProfilesDto`) ist der EFFEKTIVE Zustand nach dem Willens-Overlay und die
  einzige Stelle, die die Frage beantworten kann.
- **Beweise:** rein `EigeneAuswertungTest` (die geteilten Vektoren) + `eigeneAuswertung.test.ts`
  (69, dieselbe Datei) + `cockpitLayout.test.ts` (+9) + `migration.test.ts` (+2) · Testcontainers
  `CockpitLayoutApiTest.dieEigeneAuswertungLebtImLayoutUndIhreKennzahlBleibtEhrlich` (echte DB +
  Keycloak: Kachel UND Chart angelegt, die vier Kennzahlen von Hand gerechnet — der Zuwachs 40,5
  gegen die falsche Summe 480,75 —, ein Tag ohne Messwerte behauptet keine 0, alle sieben
  Ablehnungen ohne einen Schreibvorgang, das Portfolio verweigert, RLS 404 + anonym 401, und der
  zurückgesetzte Zähler, dessen nackte Differenz −888 kWh wäre) · DOM `AnlagenPage.test.tsx` (+6)
  + `EigeneAuswertungDialog.test.tsx` (5).
- **Ops:** keine neue Pflicht-Variable, kein Flag, keine Migration.
- **NICHT in dieser Stufe** (Captain §7): Teilen zwischen Kunden · Export/PDF · der
  Portfolio-Scope · Zeiträume über den Tag hinaus (die vier Kennzahlen sind Tages-Größen, und der
  Verlauf ist der Tagesverlauf — der Messwerte-Explorer bleibt der Ort für Woche/Monat/Jahr).

