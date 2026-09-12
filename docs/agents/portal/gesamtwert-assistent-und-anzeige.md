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

## Die Anzeige danach

- **Cockpit-Karten** `src/components/GesamtwertKarten.tsx`: auf „Meine Anlage" unter dem
  Baustein-Stapel (`pages/AnlagenPage.tsx`, nur wenn ≥1 Gesamtwert). Live-Wert aus
  `GET …/{id}/wert`, dezentes „berechnet", Lebenszyklus über `RowMenu` (umbenennen via
  `PUT …/{id}` mit Kennzeichen; anhalten/fortsetzen; archivieren statt hartem Löschen via
  `ConfirmDialog`). „gilt als Gesamt-PV" persistiert je Standort im Browser
  (`src/gesamtwertCanonical.ts`, `localStorage`) — es gibt (noch) kein Server-Feld dafür.
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
npx vitest run src/gesamtwert.test.ts src/verlauf.test.ts src/components/GesamtwertDialog.test.ts src/copy.test.ts
npx playwright test e2e/gesamtwert.spec.ts   # SUN-30K durchspielen + Anzeige, Layout 375/768/1440
```

⚠ `e2e/gesamtwert.spec.ts` zieht den schweren Chart-Graphen herein; unter voller Parallelität
kompiliert der Dev-Server ihn kalt in mehreren Workern gleichzeitig (selten über der Frist),
deshalb `test.describe.configure({ retries: 2 })` — serial/isoliert ist er zuverlässig grün.
