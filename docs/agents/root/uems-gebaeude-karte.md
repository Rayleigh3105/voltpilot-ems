# UEMS — die Gebäude-Karte auf „Standort › Gebäude“ (AP-13 IP-10 = AP-10 IP-17, Portal-Teil)

Konzept: AP-13 §4.4 (Ü6), §5.2, Kasten E4 = A, Regel B4, Referenzfall O4
(`frontend/portal/src/test/oberflaechenFaelle.json`); die Hülle kommt aus IP-2 (`uems-oberflaechen-ebenen.md`), die
Gebäude-Zeilen der Übersicht aus IP-7 (`uems-uebersicht-bausteine.md`), die Bilanz je Anlage aus IP-8
(`uems-bilanz-flaeche.md`), die Kennzahl-Welt aus AP-11 (`uems-kennzahlen-portal.md`).

## Was wo steht

| Was | Wo |
|---|---|
| Ort | `#/standort/{id}/gebaeude` — der Ortsbaum (AP-02 IP-7) mit „Stand am …“; je Gebäude klappt die Karte auf |
| Rein | `frontend/portal/src/gebaeudeKarte.ts` — `energieBlock`, `messstellenBlock`, `kennzahlenDesGebaeudes`, `kennzahlVorschlag`, `darfKennzahlAnlegen`, `registerZiel` |
| Render + Laden | `components/GebaeudeKarte.tsx` (+ `.css`): `useGebaeudeKarten` (EINMAL je Seite), `GebaeudeZeitLeiste`, `GebaeudeKarte` |
| Hülle | `components/Ortsbaum.tsx`, Prop `gebaeudeKarte` (IP-2) und neu `onAntwort` — der Baum meldet die gelesene Antwort, statt dass die Seite dieselbe zweimal holt |
| Wirt | `pages/StandortGebaeudePage.tsx` mit `onNavigate` + `springe`; ohne beide bleibt die Hülle leer (kein Aufklapper ohne Ziel) |
| Gelesen | `api.anlageBilanz` je Anlage des Standorts, `api.messstellenRegister({ort})` heute (Datenlage) und `{ort, stichtag}` am letzten Tag des Zeitraums (wer im Gebäude misst), `api.kennzahlen`, `api.selbstauskunft` |
| Tests | `gebaeudeKarte.test.ts` (O4, B4, Rechte, Versorgungs-Fall), `components/GebaeudeKarte.test.tsx` (gerenderte Fläche), `copy.test.ts` (Welt Oberflächen), `e2e/gebaeude-karte.spec.ts` (`GEBAEUDE_BILDER=<Ordner>`) |
| Bühne | `e2e/startansicht.html?bild=unternehmen&ansicht=werk-gebaeude&person=IK` (Energiemanager) · `&person=CB` (Leser, ohne Recht) · `&ansicht=lindach-gebaeude&orte=leer` (Z4) |

## Die Regel dieser Fläche: ein Gebäude ist eine Sicht, keine Bilanzgrenze

Die Karte zeigt **nie** eine Gebäude-Summe. `uemsBilanz.gebaeude` liefert `gebaeudeverbrauch: null` (§4.8), und der
Block „Energie“ steht **je System** (je Anlage), weil die Sicht je System gilt:

- „Gemessen im Gebäude 32.000 kWh (3 Messstellen)“ — die zugeordneten Messstellen DIESES Systems, die im Gebäude messen,
  darunter ihre Posten mit Namen und Menge;
- „Außerhalb des Gebäudes, im selben System: Ladepunkt Parkplatz Halle 2 1.100 kWh“ — die übrigen zugeordneten;
- „Rest des Systems Werk Ahrenberg – Halle 2: 3.800 kWh nicht verortet“ — der Rest gehört der Anlage (AP-10 E9) und
  springt in ihren Reiter Verlauf › Energiebilanz.

32.000 + 1.100 + 3.800 = 36.900 kWh ist die Zahl der **Anlage**; sie steht an der Anlage, nie in dieser Karte. Der Test
prüft das ausdrücklich.

## Die Fallen

- ⚠ **Die Datenlage sagt „5 von 5“, nicht „3 von 3“.** Der Block „Messstellen“ spricht das Aggregat des gefilterten
  Registers WÖRTLICH — und seit E13 (IP-7) zählen berechnete und archivierte mit. In Halle 2 stehen neben MS-11/12/13
  auch MS-10 (Hauptzähler) und MS-15 („Halle 2 nicht zugeordnet“). Der Referenzfall O4 stammt aus der Zeit vor E13; wie
  bei O3 (Werk Lindach) ist das ein **Befund am Referenzfall**, keine zweite Zählung in der Fläche.
- ⚠ **„im Gebäude“ und „gemessen“ sind zwei Antworten.** Wer im Gebäude steht, sagt das Register am Stichtag; was
  gemessen wurde, sagt die Bilanz der Anlage. Fehlt eine von beiden, steht keine Zahl da (`anlagen === null` bzw.
  `imZeitraum === null` → Block ohne Zahl UND ohne Grund-Satz — der Grund wäre erfunden).
- ⚠ **Eine Anlage ohne abrufbare Bilanz wird GENANNT** (`offen`, `offenSatz`): sonst sähe die Karte vollständig aus,
  obwohl ein System fehlen könnte.
- ⚠ **„nicht messbar“ nur ohne Messstelle** (AP-10 F15). Hat das Gebäude Messstellen, aber keine davon ist einem
  Hauptzähler zugeordnet, gilt `OHNE_SYSTEM` — nicht `NICHT_MESSBAR`.
- ⚠ **Der Sprung ins Register trägt seinen Filter als KURZZEICHEN in der Adresse** (`…/messstellen?ort=G-2`, lesbar als
  Lesezeichen). `messstellen.ortAus` liest ihn, `messstellen.ortSchluessel` bringt ihn EINMAL auf die ID der
  Auswahlliste — sonst stünde die Filterleiste leer über einer gefilterten Tabelle. Die Route nimmt beides an
  (`MessstelleRegisterService.Auswahl`).
- ⚠ **Mit „Stand am …“ gibt es keinen Schreibweg** (AP-02 IP-13): dann fehlen „Kennzahl anlegen“ und
  „Messstelle anlegen“ ganz, nicht nur ihre Wirkung.
- ⚠ **„Kennzahl anlegen“ fragt das Recht** `kennzahl.standort_definieren` an DIESEM Standort (AP-11 E10: KA, EM,
  Bearbeiter am Standort — der Leser nie), über `api.selbstauskunft` (`useBerichtRechte` + `anlageEnergiebilanz.darf`).
  `undefined` = Antwort fehlt noch → kein Hebel; `null` = nicht zu haben → der Hebel steht, die Route entscheidet.
- ⚠ **Der Vorschlag der Menge wird AUSGESPROCHEN** (`kennzahlAnlegen.MengenVorschlag`, `mitVorschlag`): Schritt 2 trägt
  den Satz „Vorgeschlagen: die 3 Messstellen, die in Halle 2 messen (MS-11, MS-12, MS-13).“ Die Vorlage in Schritt 1
  wirft die Menge weg (§5.1) — der Vorschlag kommt danach mit, aber nur mit den Messstellen, die zur Erwartung der
  Vorlage passen. Wer selbst gewählt oder geleert hat, behält das.
- ⚠ **Der Vorschlag ist die Menge der KARTE**, nicht das Register des Gebäudes: kein Hauptzähler, kein berechneter Rest
  — sonst stünde im Assistenten eine andere Zahl als in der Karte.
- ⚠ **Die Kennzahlen des Gebäudes sind die mit Geltung Gebäude UND die seiner Bereiche.** Die §8-Zelle nennt nur
  „Geltung Gebäude“; eine Bereichs-Kennzahl liegt aber im Gebäude und stünde sonst auf keiner Gebäude-Fläche. Sie
  erscheint mit ihrem eigenen Geltungs-Wort.
- ⚠ **Die Bühnen-Fixtures haben zwei Ort-ID-Räume**: `ortsbaumFixtures.ORT_IDS` und
  `messstellenRegisterFixtures.REGISTER_ORT_IDS` sind verschieden. Deshalb filtert diese Fläche (wie IP-7) mit dem
  KURZZEICHEN; wer mit einer Ort-ID filtert, sieht auf der Bühne nichts.

## Die Zeile „Versorgung“ — benannt, nicht gebaut

B4 verlangt die Zeile „Versorgung“ („Halle 1 ← System Halle 1“) auf der Standort-Übersicht, **sobald**
`GET /api/v1/standorte/{id}/versorgung?stichtag=` (AP-10 IP-17) antwortet. Die Route gibt es heute nicht — weder im
`StandortController` noch als Aufrufer in `api.ts`. Der Zwilling `uemsBilanz.versorgung` steht bereit, ihm fehlen nur
die Verortungen je Tag samt Stellung, die keine gebaute Antwort liefert; eine Zeile daraus wäre eine Behauptung.

`gebaeudeKarte.ts` hält den Fall mit `VERSORGUNG_ROUTE` und `VERSORGUNG_MUSTER` fest,
`gebaeudeKarte.test.ts` prüft ihn als **benannten Test**: er wird rot, sobald die Route da ist — dann ist die Zeile zu
bauen.
