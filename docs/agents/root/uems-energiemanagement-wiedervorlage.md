# UEMS-Energiemanagement: Wiedervorlage, Kalender-Abzug, Baustein (AP-19 IP-21)

Neu am 25.09.2026. Konzept: AP-19 §4.9 WV1–WV5, W9, E10 = A, R12, Anhang B.5 Z1 (`vp-uems-ap19-fundament/report.md`);
Vertrag: Operation `wiedervorlage` in [energiemanagement.md](../../contracts/v2/energiemanagement.md) §3. Kein Läufer,
kein Ereignis, keine Nachricht, keine Migration. Den Reiter „Wiedervorlage“ im Bereich baut IP-24 ([Portal](uems-energiemanagement-portal.md)).

| Stelle | Was |
|---|---|
| `EnergiemanagementWiedervorlageController` | `GET /api/v1/energiemanagement/wiedervorlage` (`?format=json\|ics`), Recht `energiemanagement.ansehen` als Kommentar (kein `@Recht`, Zaun je Quelle); `format=ics` = Kalender-Abzug, auch für „Einsicht“ (Z4), nicht protokolliert |
| `EnergiemanagementWiedervorlageService` | sammelt alle `WiedervorlageQuelle`n in `@Order`, ruft `EnergiemanagementRegeln.wiedervorlage` (Lage, Vorschau-Fenster aus `energiemanagement_einstellung.vorschau_tage`, Reihenfolge) und hängt den Sprung (`id`, `kennzahl_id`) wieder an; `ics(...)` = RFC 5545 (CRLF, Faltung nach 75 Oktetten, TEXT-Maskierung, ganztägig, `X-WR-CALDESC` + `DESCRIPTION` = §5.8 „Stand vom … aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.“); Uhr `uhrStellen` |
| Quellen (`WiedervorlageQuelle`) | `DokumentWiedervorlage` (10, DK5 über `dokumente()`), `AuditWiedervorlage` (20, IA4 `programm(abruf).naechstes`, Kennzeichen = das durchgeführte Audit), `FeststellungWiedervorlage` (30, FS1 `liste(abruf)`), `ManagementbewertungWiedervorlage` (40, MG7 seit IP-23: letzte Sitzung einer freigegebenen Managementbewertung + `managementbewertung_rhythmus_monate`, ohne Sprung; `naechste(abruf)` ist die EINE Rechnung — sie speist die Zeile und das additive Antwortfeld `naechste_managementbewertung` mit Herkunft, auch außerhalb des Fensters), `WiedervorlageBestand` (50: AP-16 S5 über `BerichtService.liste`, AP-12 E7 offene Anstöße über `detail`, Titel in Kundenwörtern „Leistungsvergleich <Geltung> Dezember 2027 — Revision angestoßen (K-…)“ (`berichtName`: Vorlagen-Name aus `BerichtPdf.VORLAGEN`, Zeitraum über `KennzahlRegeln.periodeText`), AP-17 F5 über die `frist` der Basis-Antwort, AP-18 `faellig[]` des Übersichts-Lesers + Vorschau aus den Registern, Messbedarf über `VerbesserungRegeln.frist`) |
| Portal | `wiedervorlage.ts` (Typen; Einträge, Bündel, Datumswörter, Status und „Zuletzt erledigt“ als reine Ableitungen, siehe unten), `entscheid.ts` + `useEntscheidFokus.ts` (Sprung mit offenem Entscheid), `components/EnergiemanagementBaustein.tsx` („Was steht an“), `components/EnergiemanagementWiedervorlage.tsx` (Arbeitsliste), `components/FristDatum.tsx` (Datumsblock, Bereich-Marke, Kennzeichen ohne Umbruch), `components/Wiedervorlage.css`; Baustein `energiemanagement` in beiden `anwendungen/catalog.json`, `portfolioCockpit.ts`, `uebersichtBausteine.ts`, `UebersichtBausteine.tsx` (nur am Unternehmen, nur mit einer Frist); Bühnen `e2e/energiemanagement-baustein.html`, `e2e/energiemanagement-wiedervorlage.html` |
| Nachweis | `EnergiemanagementWiedervorlageApiTest` (R12 über echte Routen, ICS, Einsicht), `EnergiemanagementWiedervorlageSchnittstelleVertragTest` (openapi ↔ DTO ↔ Vokabular, nur Dienste, keine Uhr, kein Läufer, ICS-Form), `wiedervorlage.test.ts`, `entscheid.test.ts`, `useEntscheidFokus.test.tsx`, `EnergiemanagementBaustein.test.tsx`, `EnergiemanagementWiedervorlage.test.tsx`, `DokumentSeite.test.tsx`, `e2e/energiemanagement-baustein.spec.ts`, `e2e/energiemanagement-wiedervorlage.spec.ts`, `e2e/energiemanagement-managementbewertung.spec.ts` (Schritt bis „Geprüft, bleibt“) |

⚠ **Die Wiedervorlage rechnet keine Frist (WV2).** Jede Quelle gibt `faellig_am` fertig aus der Regel ihres Objekts;
wer eine neue Frist-Art anhängt, liest sie über den Dienst ihres Pakets — der Vertragstest verbietet `JdbcTemplate`,
`SELECT`, `Repository`, `.now(` und `Clock` in den Quellen.
⚠ **AP-18 `faellig[]` nennt nur fällige Vorgänge.** Die Vorschau (M-2029-0001 in 16 Tagen) kommt aus dem Register mit
`frist().termin` und `frist().faellig == null`; ein Energieziel steht nur bis zum Ende der Zielperiode in der Vorschau
und erst wieder, wenn der Übersichts-Leser seine Bewertung fällig nennt (F1: letzter Monat endgültig).
⚠ **Kennzeichen der Berichte sind BR-…** (W11): R12 nennt VB-2028-0001 und BW-2027-0001, der Code BR-2028-0001 und
BR-2027-0001 — die Reihenfolge bleibt dieselbe (BB-0004 vor BR-2027-0001 am 24.11.2028).
⚠ **Test-Uhren:** ein Abruf braucht denselben Augenblick auf Wiedervorlage, Dokumenten, Audit, Feststellung und
`KennzahlService` (AP-18-Übersicht, Bezugsbasis-Frist, Maßnahmen-Kennzeichen) — Muster `abruf(...)` im API-Test.
⚠ **Geteilte Bühne:** `e2e/startansicht.tsx` stellt `energiemanagementWiedervorlage` leer (keine Kachel, kein Abruf
an den nicht laufenden Server — `uebersicht.spec.ts` prüft Konsolenfehler).

## Arbeitsliste und „Was steht an“ (Konzept Wiedervorlage w1, PR1)

Captain-Freigabe 05.10.2026; Konzept und Bericht: firstmate `data/vp-wiedervorlage-konzept-w1/` (`report.md`, `konzept.html`, `umsetzung.md`).
PR1 baute das Portal aus der damaligen Antwort, PR2 die additive API (Vertrag 1.1, unten); die Zählerablesungen folgen in PR3.

- **Ein Gegenstand, ein Eintrag.** `arbeitsliste()` fasst Zeilen gleicher Art und gleichen Kennzeichens zusammen (zehn Anstöße an einem Bericht = ein Eintrag mit `zeilen: 10`); der Tag des Eintrags ist der der ältesten Zeile, die Reihenfolge die der Route.
- **Dringlichkeit:** überfällig heißt `tage > 0`, heute fällig gehört zu „In den nächsten 30 Tagen“; die Marken zählen Einträge, nicht Zeilen.
  Der Vertragssatz „baustein“ zählt weiter Zeilen und steht deshalb nicht mehr auf der Fläche (PR2 ändert ihn in allen drei Zwillingen).
- **Aufgabe und Grund** kommen aus Art und Titel der Route: `DOKUMENT_TITEL`, `ANSTOSS_TITEL` und `BEZUGSBASIS_TITEL` lesen die Titel, wie die Quellen sie bilden; passt ein Titel nicht, bleibt der Grund ohne Herleitung (nie geraten).
  Eine unbekannte Art steht mit dem Titel der Route und ohne Sprung.
- **Übersicht, Variante A:** `wasStehtAn()` bündelt je Art, höchstens vier Zeilen bei Überfälligem, sonst die nächsten zwei Fristen; ohne jede Frist (auch ohne `nicht_in_liste`) kein Block (AP-13 E3).
  Ein Bündel öffnet die Wiedervorlage mit `?art=`, ein einzelner Eintrag sein Objekt mit Entscheid.
- **Status-Eskalation (Entscheid 9):** `wiedervorlageStatus()` liefert nur bei Überfälligem „8 Fristen überfällig“, „Älteste seit …“ und die Arten; `useUebersichtBausteine` reicht es als `wiedervorlageStatus` heraus, die Statuszeile der Übersicht (Portfolio-Umbau) hängt sich daran.
- **Schritt statt Häkchen (Entscheid 8):** `eintragSprung()` hängt `?entscheid=<art>` (beim Messbedarf `&kennzeichen=`) an die Adresse; die Zielseite markiert ihren Entscheid mit `data-entscheid` (Dokument-Aktionen, Kennzahl-Reiter „Bezugsbasis“, Bericht-Revision, Feststellung „Wirksamkeit“, Maßnahme „Zustand“, Energieziel „Bewertung“, Abweichung „Abschluss“, Audits- und Managementbewertungs-Kopf, Bewertung „Stand“, Messbedarf-Zeile).
  `useEntscheidFokus` hängt einmal an der Schale (`App.tsx`), wartet bis zu 8 s auf das Ziel, fokussiert dessen ersten Knopf, markiert ihn 2,4 s und nimmt den Parameter per `replaceCurrentNavigation` wieder aus der Adresse.
- **„Geprüft, bleibt“ am Dokument (DK5):** die Route gab es, den Knopf nicht; `GeprueftBleibtDialog` (Person, Tag ab der Freigabe der gültigen Fassung, Begründung 10 bis 500 Zeichen), danach die Rückmeldung mit der nächsten Überprüfung.
- **Zuständig** kommt seit PR2 von der Route (unten); das Portal erfindet keine Person und keine Lücke.

⚠ **Demo mit zwei Uhren:** die Bühnen-Uhr (`PruefumgebungUhr`, 30.04.2029) gilt für die Leser des Energiemanagements, die Füllung schrieb in echter Zeit.
  „Geprüft, bleibt“ mit dem heutigen Tag scheitert dort an „ab der Freigabe der gültigen Fassung“; in Produktion gibt es eine Uhr.

## Vertrag 1.1 und die additive Antwort (Konzept Wiedervorlage w1, PR2)

- **Operation `wiedervorlage` (drei Zwillinge, Vektoren):** `spaeter[]` ist der Jahresplan (nach dem Fenster bis einschließlich Abruf + `JAHRESPLAN_MONATE` = 12, Monatsende geklemmt), dazu `anzahl_ueberfaellig` (`tage` > 0), `anzahl_naechste` (heute und das Fenster) und `anzahl_spaeter`; `nicht_in_liste` bleibt für Bestandsleser.
  Der Satz `baustein` lautet „Energiemanagement: {ueberfaellig} überfällig · {naechste} in den nächsten {tage} Tagen.“; `copy.test.ts` trägt ihn wörtlich.
- **Ein Gegenstand, eine Zeile, schon an der Quelle:** `WiedervorlageBestand` bündelt die offenen Anstöße eines Berichts zu EINER Frist ab dem ersten erkannten (Titel bei einem Anstoß unverändert, sonst „… (n Korrekturen, zuerst K-…)“); freigegebene Managementbewertungen tragen ihre Titel unverändert weiter, nur neue Stände sehen die Bündelung.
- **Herleitung statt Satz:** jede Quelle gibt `WiedervorlageQuelle.Herkunft` aus denselben Werten, aus denen sie `faellig_am` hat (`basis` aus `wiedervorlage_basis`, Tag, Fassung, Monate, Kennung, Quelle, Anzahl, Gegenstand `bezug`, Konto, Energieeinsatz); der Leser gibt sie als `herleitung`, `bezug`, `einsatz_id` aus, die Wörter bildet `wiedervorlage.ts` (`grund`).
  Die Dokument-Überprüfung kennt die Art ihrer Basis aus der Dokument-Antwort (`ueberpruefung.basis_art`, `monate`, additiv), damit die Quelle nicht je Dokument nachlesen muss.
- **Zuständig:** die Person am Objekt geht vor (`herkunft` `objekt`); sonst die Person der laufenden Zuordnung der Aufgabe der Zeile (`ART_AUFGABE` im Leser, Feld `aufgabe` an jeder Zeile; die Managementbewertung zählt immer als Aufgabe); `ich` vergleicht das Konto (bzw. den Namen der eigenen Person im Energiemanagement).
  `aufgaben_lesbar = false` (wer nicht unternehmensweit liest, bekommt vom Personen-Dienst keine Aufgabe): dann gibt es keine Person laut Aufgabe, und das Portal schreibt NICHT „Niemand zuständig“ und zeigt den Filter „Ohne Zuständige“ nicht.
- **„Niemand zuständig“ mit „Aufgabe festlegen“:** der zweite Link der Karte (über dem Link der Aufgabe, der die Karte abdeckt) führt mit `?entscheid=aufgabe_festlegen&kennzeichen=<aufgabe>` in die Aufgaben; die Zeile der Aufgabe ohne Person trägt `data-entscheid`, ihr „Zuordnen“ `data-entscheid-schritt`.
  Der Messbedarf springt mit `einsatz_id` direkt an seinen Energieeinsatz („Messstelle einrichten“), ohne Einsatz wie bisher in die Messplanung.
- **Zuletzt erledigt:** eigener Abruf `GET …/wiedervorlage/zuletzt` (90 Tage, höchstens fünf): die Zeilen des Verzeichnisses, die eine Frist beenden oder neu beginnen lassen, und „geprüft, bleibt“ an Dokumenten (`EnergiemanagementDokumentService.geprueftBleibt`) und Bezugsbasen (`BezugsbasisPflegeService.bestaetigt`, Zaun über die lesbare Kennzahl).
  Der Leser selbst hält keine Abfrage (Vertragstest: kein `Repository` im Leser).
- **Portal:** Jahresplan als Karte nach Monaten (aufeinanderfolgende Monate eines Jahres unter einer Überschrift), gestrichelter Datumsblock, Schritt „Öffnen“ ohne Entscheid; im Normalfall offen, bei Überfälligem zu; die Marke „Jahresplan“ öffnet ihn.
  „Was steht an“ zeigt im Normalfall die nächsten zwei Fristen auch aus dem Jahresplan (je Monat gebündelt).

