# Der „Gesamtwert"-Assistent und seine Anzeige (Portal)

Die Kunden-Hälfte der berechneten Messwerte (Konzept `data/vp-helfer-konzept-h1`,
Backend = UEMS-AP-10, siehe `docs/agents/root/gesamtwert-berechnete-messstelle-formel-ap10.md`).
Der Kunde stellt aus mehreren gemessenen Werten seiner Anlage EINEN neuen Wert als
**gewichtete Summe** (Vorzeichen + optionaler Faktor) zusammen; danach verhält er sich wie
ein gemessener Wert. Nur Anzeige — keine Steuerungs-/Optimierungs-Kopplung.

## Das Kundenwort

**„Gesamtwert"** steht als EINE Konstante `GESAMTWERT` in `src/glossar.ts` (später änderbar).
Interne Wörter (Messstelle, Messkanal, Point-Key, Entität …) stehen in KEINEM Kundentext;
`src/copy.test.ts` bewacht das. Das automatische Kennzeichen `MS-…` erscheint klein/unaufdringlich.

## Die reine Hälfte: `src/gesamtwert.ts` (+ `gesamtwert.test.ts`)

Alle Regeln/Sätze/Vorschläge — ohne DOM, ohne Netz. Stützt sich additiv auf die Zwillinge
`src/uemsMessstelleFormel.ts` (`gewichteteSumme`, `formelGroesse`, `normiere`) und
`src/uemsMessstelle.ts` (`GROESSEN_KATALOG`). Kernstücke: `passt`/`sperrgrund` (nur
größen-verträgliche Werte sind summierbar — keine Äpfel+Birnen), `abgeleiteteGroesse`,
`vorschau`/`rechenzeile` (Live-Summe; fehlt EIN Term → `null` „unvollständig", NIE eine
Teilsumme), `giltAlsPvMoeglich`, `nameVorschlag`, `entwurfFehler`, `alsAnfrage` (POST-Körper),
`tagesverlauf` (client-seitige 15-min-Summe für die Vorschau-Kurve).

## Der Assistent: `src/components/GesamtwertDialog.tsx` (+ `.test.tsx`)

Geschwister von `EigeneAuswertungDialog`: zentriertes `Modal` (am Telefon Vollbild), Stepper
`.vp-steps`, Messwert-Baum aus **`verlauf.measurementTree`** (dieselben Namen/Kanäle wie der
Explorer). Fünf Schritte: (1) Werte wählen — **`VpPicker` Mehrfachauswahl** mit Live-Wert +
Status-Punkt je Kanal, unpassende Größen gesperrt mit Grund; (2) Rechnen — +/- je Term
(Standard +), Faktor hinter „Feineinstellung"; (3) Name (Freitext + Vorschlag, Kennzeichen,
optional Schalter „gilt als Gesamt-PV"); (4) Vorschau — Live-Rechenzeile + Ergebnis + kleiner
Verlauf, Größe/Einheit abgeleitet, ehrlich „unvollständig"; (5) Fertig. **Beim Speichern EIN
`POST /api/v1/messstellen/berechnet`** (keine Term-Ändern-Route — die Vorschau wird deshalb
CLIENT-seitig gerechnet, nicht durch ein Zwischen-Anlegen).

⚠ Die Schritt-Inhalte werden als **Funktionen aufgerufen** (`{SchrittWerte()}`), NICHT als
`<Schritt/>`-Komponenten gerendert: eine je Render neu definierte Komponente hätte einen neuen
Typ und würde den Picker bei jeder Auswahl neu mounten — das Panel klappte nach dem ersten
Haken zu.

Die Live-Werte + Vertrags-Größen kommen aus `ladeQuellen`: je Komponente `messkanaele`
(Größe/Richtung/Einheit/Wertart) + `entityHistory('day')` (zuletzt gemessener Wert + Frische).
Nur v2-Anlagen (echte Komponenten) tragen Gesamtwerte.

## ⚠ Der Vertrag ist snake_case (Backend #688)

Die Formel-DTOs (`MessstelleFormelDto`) tragen `@JsonNaming(SnakeCaseStrategy)`; das JSON heißt
also `terme[].entity_id` / `point_key` / `eingang_art` / `quell_messstelle_id`,
`formel_vorhanden`, `messstelle_id` (belegt in `MessstelleFormelApiTest`). `request()` wandelt
NICHT snake→camel um — die api.ts-Interfaces (`MessstelleFormel`, `MessstelleFormelTerm`,
`MessstelleVerlauf`) und ihre Leser (`gesamtwertQuelle.ts`) sprechen deshalb snake_case. Ein
camelCase-Feld wäre still `undefined` → die Site-Zuordnung fände nie einen Term (Review-Blocker
B1). `src/gesamtwertQuelle.test.ts` ist der Kontrakttest gegen die echte snake_case-Form;
Mocks (Unit + E2E) MÜSSEN snake_case liefern, sonst grünen sie am falschen Vertrag vorbei.

## Die Anzeige danach

- **Gesamtwert-Anzeige + Einstieg** `src/components/GesamtwertKarten.tsx`: seit vp-agg (Konzept
  `data/vp-agg-konzept3-r8` §2.5) **nicht mehr auf der Cockpit-Bühne**, sondern in
  **„Verlauf › Messwerte"** (`pages/MesswerteSection.tsx`) — dort leben Einstieg (der
  „+ Gesamtwert"-Knopf öffnet den `GesamtwertDialog`) UND Anzeige gemeinsam (Prop `eingebettet` =
  Host trägt Überschrift + Einstieg, die Karten lassen ihren eigenen Kopf weg). Der GERÄTEFREIE
  Gesamtwert gehört zu den Auswertungen, nicht auf die Bühne. Live-Wert aus `GET …/{id}/wert`,
  dezentes „berechnet", Lebenszyklus über `RowMenu` (umbenennen via `PUT …/{id}` mit Kennzeichen +
  Notiz; anhalten/fortsetzen; archivieren statt hartem Löschen via `ConfirmDialog`).
- **Cockpit-PV = kanonische Rolle mit Rückfall (GEBAUT, vp-agg §2.4).** Die frühere Notiz „gilt als
  Gesamt-PV ist nicht gebaut" gilt NICHT mehr. Forgejo-PR #758 baute die verallgemeinerte
  Rollen-Zuordnung (`entity_role_assignment`: je (Gerät, Rolle=pv) EIN Kanal ODER EIN Gesamtwert) +
  die Kunden-PV-API `GET /api/v1/sites/{id}/rollen/pv` (`RollenZuordnungService.kanonisch` →
  `RollenDto.KanonischerWert`: ehrliche Teil-Summe, jedes Gerät benannt — liefernd mit Wert oder
  stumm mit Grund, nie eine stille Teilsumme). Das Cockpit liest die PV nun von dort:
  **`OverviewController` mischt je Anlage die kanonische PV in `OverviewLiveDto.pvKw` ein** (statt
  `telemetry.pv_power_kw`), WENN eine Standort-PV-Zuordnung existiert — sonst RÜCKFALL auf die
  Roh-Telemetrie (`RollenZuordnungService.pvJeAnlage`, flottenweit in EINER Abfrage; die kanonische
  Summe darf `null` sein → PV „unbekannt", nie eine 0). Das Frontend liest weiter `snap.pvKw`
  (`fleet.ts`), Portfolio-Summen bleiben dadurch konsistent. Unter dem Fluss zeigt der Cockpit-Hero
  die Herkunft: `src/components/PvRollenBreakdown.tsx` (reine Ableitung `src/pvRolle.ts`, gated auf
  `hasFlow`) — dezentes „berechnet" + auf Tipp „So setzt sich Ihre PV-Produktion zusammen" je Gerät
  (stummes Gerät „liefert gerade nicht", Teil-Summe „aus N von M Geräten"). Ohne Zuordnung rendert
  sie nichts (Rückfall bleibt unmarkiert) und die rohe Quellen-Aufteilung (`PvBreakdownLine`) bleibt.
  ⚠ NICHT umgelenkt: der Optimizer-Nowcast (separater Folgeschritt) und der Box-Steuerpfad.
- **Verlauf-Ast** in `src/components/VerlaufExplorer.tsx`: ein eigener Ast „Berechnete Werte"
  neben den gemessenen Komponenten; die synthetische `entityId` `berechnet-<uuid>` trägt KEINEN
  Doppelpunkt (Deep-Link `m={entityId}:{channel}` trennt am ersten). Reine Helfer in
  `src/verlauf.ts`: `berechneteGruppe`, `seriesFromMessstelleVerlauf`, `istBerechnet`.
- Enumeration je Anlage: `src/gesamtwertQuelle.ts` (`ladeSiteGesamtwerte`) filtert die
  tenant-weiten berechneten Messstellen auf die, deren Formel-Terme eine Komponente DIESER
  Anlage lesen (die Messstelle selbst trägt keinen Ort).
- MPPT-/Gen-Port-Kanäle des Ankerfalls (Deye SUN-30K) sind in `src/channels.ts` benannt
  (`pv1_power_kw`→„PV 1" … `microinverter_power_kw`→„Mikrowechselrichter").

## Prüfen

```bash
npx vitest run src/gesamtwert.test.ts src/gesamtwertQuelle.test.ts src/verlauf.test.ts src/pvRolle.test.ts src/components/GesamtwertDialog.test.tsx src/copy.test.ts
npx playwright test e2e/gesamtwert.spec.ts   # SUN-30K durchspielen + Anzeige, Layout 375/768/1440
```

Backend-Seite der Cockpit-Umlenkung (vp-agg §2.4): `SiteRollenApiTest` (Umlenkung + Rückfall +
„null statt 0 bei stummer Zuordnung" gegen `GET /api/v1/overview`).

⚠ Die Bühne `e2e/gesamtwert.tsx` verhält sich wie die echten Wirte (`MesswerteSection`,
`KennzahlAnlegenDialog`): `onGespeichert` lädt nur neu und schließt NICHT. Bis 15.09.2026 schloss
sie beim Speichern — „ist angelegt" stand dann nur ~180 ms (das Ausblenden des Modals), und unter
Last scheiterten SUN-30K und die Layout-Fälle an „Fertig" bzw. `.vp-modal` (auf 84f8307f wie auf
43cd7834: 6 bzw. 5 von 24 Fällen bei `--repeat-each=6 --workers=8`). `stehtOffen` prüft darum nach
„ist angelegt", dass das Modal NICHT `is-closing` trägt, und „Fertig" wird ohne `force` geklickt: ein
Wirt, der beim Speichern schließt, ist damit in JEDEM Versuch rot statt „flaky".
`test.describe.configure({ retries: 2 })` bleibt nur als Schutz gegen den Kaltstart des
Chart-Graphen unter Fremdlast — `flaky` in der Zusammenfassung ist ein Befund, kein Grün.
