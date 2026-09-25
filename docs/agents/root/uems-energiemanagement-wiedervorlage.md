# UEMS-Energiemanagement: Wiedervorlage, Kalender-Abzug, Baustein (AP-19 IP-21)

Neu am 25.09.2026. Konzept: AP-19 §4.9 WV1–WV5, W9, E10 = A, R12, Anhang B.5 Z1 (`vp-uems-ap19-fundament/report.md`);
Vertrag: Operation `wiedervorlage` in [energiemanagement.md](../../contracts/v2/energiemanagement.md) §3. Kein Läufer,
kein Ereignis, keine Nachricht, keine Migration. Der Reiter „Wiedervorlage“ im Bereich kommt mit IP-24.

| Stelle | Was |
|---|---|
| `EnergiemanagementWiedervorlageController` | `GET /api/v1/energiemanagement/wiedervorlage` (`?format=json\|ics`), Recht `energiemanagement.ansehen` als Kommentar (kein `@Recht`, Zaun je Quelle); `format=ics` = Kalender-Abzug, auch für „Einsicht“ (Z4), nicht protokolliert |
| `EnergiemanagementWiedervorlageService` | sammelt alle `WiedervorlageQuelle`n in `@Order`, ruft `EnergiemanagementRegeln.wiedervorlage` (Lage, Vorschau-Fenster aus `energiemanagement_einstellung.vorschau_tage`, Reihenfolge) und hängt den Sprung (`id`, `kennzahl_id`) wieder an; `ics(...)` = RFC 5545 (CRLF, Faltung nach 75 Oktetten, TEXT-Maskierung, ganztägig, `X-WR-CALDESC` + `DESCRIPTION` = §5.8 „Stand vom … aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.“); Uhr `uhrStellen` |
| Quellen (`WiedervorlageQuelle`) | `DokumentWiedervorlage` (10, DK5 über `dokumente()`), `AuditWiedervorlage` (20, IA4 `programm(abruf).naechstes`, Kennzeichen = das durchgeführte Audit), `FeststellungWiedervorlage` (30, FS1 `liste(abruf)`), `ManagementbewertungWiedervorlage` (40, MG7 seit IP-23: letzte Sitzung einer freigegebenen Managementbewertung + `managementbewertung_rhythmus_monate`, ohne Sprung), `WiedervorlageBestand` (50: AP-16 S5 über `BerichtService.liste`, AP-12 E7 offene Anstöße über `detail`, AP-17 F5 über die `frist` der Basis-Antwort, AP-18 `faellig[]` des Übersichts-Lesers + Vorschau aus den Registern, Messbedarf über `VerbesserungRegeln.frist`) |
| Portal | `wiedervorlage.ts` (Typen, `energiemanagementBaustein`, `bausteinSatz`, `kalenderVermerk` über den Zwilling `energiemanagement.ts`), `components/EnergiemanagementBaustein.tsx`, Baustein `energiemanagement` in beiden `anwendungen/catalog.json`, `portfolioCockpit.ts`, `uebersichtBausteine.ts`, `UebersichtBausteine.tsx` (nur am Unternehmen, nur mit Inhalt); Bühne `e2e/energiemanagement-baustein.html` |
| Nachweis | `EnergiemanagementWiedervorlageApiTest` (R12 über echte Routen, ICS, Einsicht), `EnergiemanagementWiedervorlageSchnittstelleVertragTest` (openapi ↔ DTO ↔ Vokabular, nur Dienste, keine Uhr, kein Läufer, ICS-Form), `EnergiemanagementBaustein.test.tsx`, `e2e/energiemanagement-baustein.spec.ts` |

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
