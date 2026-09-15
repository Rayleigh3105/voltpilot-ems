# Geräteseiten Stufe 0: EIN Rückweg, und der Katalog gehört dem GERÄT

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 9).


Zwei gemeldete Defekte, ein PR (Konzept `data/vp-geraeteseite-rahmen-r2` §2.1/§2.3
+ Stufe 0 in §8; Captain-Entscheide D1a/D5a vom 27.08.2026). Beide sind reine
Portal-Arbeit — kein Endpunkt, keine Migration, kein Feld auf dem Draht.

### Der Rückweg steht GENAU EINMAL

Über einer Geräte- oder Box-Seite standen DREI Elemente übereinander, die alle
„zurück" bedeuten: der Knopf „Anlage {Name}" (`vp-fleet-back`), die
Reiter-Leiste ihres Bereichs — in der die Seite gar nicht vorkommt, also war
**kein Reiter aktiv** — und der Link „Zurück zu den Komponenten".

- **`ebenenNav.OHNE_BEREICHS_REITER`** ist die Regel: `tabsFor` schweigt für
  `geraet`/`box`. Sie wohnen im Bereich „Anlage" (`SUB_BEREICH`, damit die
  Seitenleiste ihren Wirt hervorhebt), stehen aber eine Ebene DARUNTER — sie
  zeigen EIN Gerät. `activeAreaKey` ist unberührt.
- **`components/GeraetBrotkrume.tsx`** ist der eine Rückweg. Sie ist keine neue
  Form: die `DeviceBreadcrumb` der Ladesäulen-Seite ist dorthin gezogen, damit
  alle Geräteseiten dieselbe zeigen. **⚠ Ihre mittlere Stufe heisst
  „Komponenten", nicht „Geräte"** — wie die Seite, auf die sie zeigt (Steuerung
  Stufe 8 benannte den Bereich um); zwei Wörter für dasselbe Ziel wären eine
  zweite Wahrheit.
- Auf dem Ladepunkt-Pfad rendert `OcppWallboxPage` sie selbst, deshalb lässt
  `GeraetSeiteSection` sie dort weg — nie zwei übereinander.

### Die Messbibliothek zeigt den Katalog DIESES Geräts

Sie fragte mit der Geräte-UUID der BOX „welche Punkte kann die Box lesen", und
das ist server-seitig die Familien-VEREINIGUNG aller komponierten Punkte dieser
Box — praktisch die Familie des primären Wechselrichters, auf JEDER Geräteseite.
Die Wallbox zeigte damit `hybrid_3p`-Register.

- **`src/registerFamilie.ts` ist der Client-Zwilling von
  `MeasurementCatalogFamilies.expand`** (Java): SOLL (`SiteComponentRow.family`)
  vor IST (`localSetup.family`), ein Ladepunkt spricht per Konstruktion OCPP.
  Der Transport bleibt die Box — nur die ANZEIGE wird geschnitten
  (`?family=…` statt `availableOnly`).
- **⚠ `KATALOG_FAMILIEN` ist eine KOPIE des kanonischen Messpunkt-Katalogs.**
  Der Endpunkt liefert seine Familien-Liste nicht mit, ein Client kann sie also
  nicht erfragen — und ohne sie griffe der abschliessende Schnitt nicht, eine
  Anbindung ohne Registerliste käme als nicht-leere Menge zurück und der Kunde
  bekäme einen LEEREN Kasten statt gar keinen. `registerFamilie.test.ts` liest
  deshalb die kanonische Datei UND die Java-Quelle PER PFAD: ein neuer
  SunSpec-Modellsatz oder ein neuer `else if`-Zweig drüben macht den Testlauf
  rot. Mit Stufe 3b (der Server nimmt die Komponente entgegen) entfällt sie.
- **Drei Ehrlichkeitsregeln:** ohne Katalog-Familie entsteht GAR KEINE Sektion —
  und es wird auch nichts abgefragt; hinter der Box steht `BEOBACHTEN_HINWEIS`
  (die Box liest beobachtete Punkte heute nur über den primären Wechselrichter,
  §2.3 Schicht 3); und der Fehlerfall spricht über das GERÄT statt über die Box.
- **⚠ Eigene Register (`custom`) tragen keine Katalog-Familie** und lassen sich
  nicht schneiden. Sie werden gegen den primären Wechselrichter gelesen, also
  entscheidet der Wirt über `eigeneErlaubt` — auf einer Wallbox wären sie eine
  Zusage gegen die falsche Adresse.
- **⚠ Kennt niemand die Familie des PRIMÄREN Wechselrichters, fällt die Fläche
  dort auf die Box-Semantik zurück** (`familien === null`) statt die Sektion zu
  verstecken: die Vereinigung der Box IST auf dieser einen Seite die richtige
  Antwort — genau deshalb sah der Fehler dort ja korrekt aus.

