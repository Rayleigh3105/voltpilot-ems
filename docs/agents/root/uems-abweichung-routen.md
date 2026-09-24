# UEMS-Auffälligkeit und Abweichung: Routen (AP-18 IP-16, A2–A6, U1–U3, RE1–RE3)

Neu am 24.09.2026: `AuffaelligkeitController` (`/api/v1/kennzahlen/{id}/auffaelligkeiten…`) und `AbweichungController`
(`/api/v1/abweichungen…`) → `uems/AbweichungService`, DTO `web/dto/AbweichungDto`, Ablehnungen `VerbesserungAbgelehnt`.
Keine Migration (Tabellen, Trigger, Grants: [Datenhaltung](uems-verbesserung-datenhaltung.md) IP-14), keine Naht
(die Vermerke schreibt IP-15).

**Portal (IP-18):** Vermerk-Zeile und „Abweichung eröffnen“ hängen als Zusatzzeile unter jedem Monat der Vergleichs-Fläche
(`BezugsbasisVergleich` → `MonateTafel zusatz`, nur mit `verbesserung.ansehen`; Komponenten `AuffaelligkeitZeile.tsx`),
Register `AbweichungenRegister.tsx`, Seite `pages/AbweichungSeite.tsx` (`#/portfolio/verbesserung/abweichungen/{id}`),
Dialoge `AbweichungDialoge.tsx`, reines Modul `abweichungen.ts`, Bühne `e2e/abweichungen.*` mit
`src/test/abweichungFixtures.ts`. ⚠ Der Anlass wird aus der Kopie gesprochen (`anlassSaetze`: `satz`, `vermerke[]`,
`vergleich[]`), nie neu gebildet; ⚠ „Maßnahme“ im Abschluss öffnet den IP-13-Dialog vorbelegt
(`massnahmeVorbelegung`) im selben Dialog-Zug, die neue Maßnahme steht danach gewählt.

| Route | Recht | Was |
|---|---|---|
| `GET /api/v1/kennzahlen/{id}/auffaelligkeiten?zustand=` | `verbesserung.ansehen` (Kommentar) | Vermerke der Kennzahl (Zaun über `fuerBezugsbasis` + RLS `standort_id`); `offen` zählt immer alle offenen |
| `POST …/auffaelligkeiten/{aid}/antwort` | `@Recht verbesserung.verwalten`, DIENST | einmalig (409 `auffaelligkeit_beantwortet`); `abweichung` → AW-… mit ALLEN offenen Vermerken derselben Kennzahl × Fassung (201); `zur_kenntnis` nur mit Begründung 10–500 (200, sonst 422) |
| `GET/POST /api/v1/abweichungen` | ansehen · verwalten | Register (`zustand`, `ueberfaellig` über `VerbesserungRegeln.frist`, `kennzahl`); von Hand: Anlass = Kopie von `BezugsbasisVergleich.fuerZiel` über abgeschlossene `monate` gegen EINE Fassung, `wortlaut` 10–500 |
| `GET …/{id}` | ansehen | mit `vermerke` und `verlauf`; Sätze `abweichung_kopf`, `ursache_aussage(_mit_beleg)`, `abschluss_massnahme`/`_erklaert` |
| `POST …/{id}/eintraege` · `PUT …/{id}/frist` · `PUT …/{id}/verantwortlicher` | verwalten | nur offen (409 `abweichung_abgeschlossen`); Ursache-Aussage mit Person (`aussage_sub` und/oder `aussage_name`), Tag, wahlfrei `beleg_kennung`; Frist nie vor dem Eröffnungstag (422 `frist_vor_eroeffnung`) |
| `POST …/{id}/abschliessen` | `@Recht verbesserung.abschliessen` | einmalig; `massnahme` nur mit sichtbarer Maßnahme (422 `massnahme_fehlt`/`massnahme_unbekannt`), sonst ohne Verweis |

⚠ **Anlass aus Vermerken:** EIN Vermerk → sein Anlass byte-gleich (dieselbe Prüfsumme wie in der Referenzdatei 1.9),
mehrere → `{"vermerke": […]}` kanonisch. Vermerke einer anderen Fassung bleiben offen (A3: genau eine Fassung).
⚠ **Vorbehalte** (`vorbehalte`) sind die Kennzeichen mit „vorläufig“ aus der Kopie — geerbt, nie neu gebildet (R8).
⚠ **Uhr:** „heute“, „abgeschlossen“, „Frist ≥ Eröffnungstag“ und `eroeffnet_am`/`beantwortet_am`/`abgeschlossen_am`
setzt der Dienst aus `KennzahlService.jetzt()`; nur die Frist-Vorgabe (+ 30) kommt vom Trigger.
⚠ **403 vor 404:** wer `verbesserung.abschliessen` nirgends hat (BE, BD), bekommt am Abschluss 403 vom Interceptor,
auch an einer Abweichung außerhalb seines Zauns.
⚠ **Nicht gebaut:** der Satz `auffaelligkeit` (offen) — er braucht gemessen/erwartet/Bedingung aus dem Anlass der Naht
(IP-15 legt die Form fest); `kopf_satz` nur für einen Monat mit Δ. Nachweis: `AbweichungApiTest` (R1, R2, R8, R11),
`AbweichungSchnittstelleVertragTest`, Zeilen in `RechtMatrixApiTest`, `RechtRoutenArchitekturTest.DIENST`,
`RechteKennungenDerRoutenTest`.
