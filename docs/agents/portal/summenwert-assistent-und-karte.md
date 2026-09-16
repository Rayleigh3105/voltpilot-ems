# Summenwert-Assistent und Gerätekarte

Gesamtwegweiser: [H-0 bis H-11](../root/uems-summenwerte-abschluss.md).
Gerätekarte und Rollen-Dialog: [H-7/H-8/H-10](../root/uems-summenwerte-geraetekarte.md).

Der aktuelle gemeinsame Geräte-/Anlagen-Assistent ist unter
[H-5/H-6](../root/uems-summenwert-assistent.md) dokumentiert.
`GesamtwertDialog.tsx` ist nur noch ein Einstieg in `SummenwertAssistent.tsx`.
Kundenwort: `SUMMENWERT`; Live-Rollen: [H-1/H-2](../root/uems-rollen-zuordnung.md).

## Die Anzeige danach

- **Summenwert-Anzeige + Einstieg** `src/components/GesamtwertKarten.tsx`: seit vp-agg (Konzept
  `data/vp-agg-konzept3-r8` §2.5) **nicht mehr auf der Cockpit-Bühne**, sondern in
  **„Verlauf › Messwerte"** (`pages/MesswerteSection.tsx`) — dort leben Einstieg (der
  „+ Summenwert"-Knopf öffnet denselben `SummenwertAssistent`) UND Anzeige gemeinsam (Prop `eingebettet` =
  Host trägt Überschrift + Einstieg, die Karten lassen ihren eigenen Kopf weg). Der rollenlose
  Summenwert gehört zu den Auswertungen, nicht auf die Bühne. Live-Wert aus `GET …/{id}/wert`,
  dezentes „berechnet", Lebenszyklus über `RowMenu` (umbenennen via `PUT …/{id}` mit Kennzeichen +
  Notiz; anhalten/fortsetzen; archivieren statt hartem Löschen via `ConfirmDialog`).
- **Cockpit-Rollen**: PV, Verbrauch und Netz aus derselben serverseitigen Ableitung;
  Mehrgeräte-Summen einmal, stumme Zuordnung unbekannt, ohne Zuordnung Rohwert-Rückfall.
  `RollenBreakdown` zeigt Stand und Herkunft, schreibt nichts. Details und Grenzen:
  [Rollen-Kapitel](../root/uems-rollen-zuordnung.md).
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

⚠ `e2e/gesamtwert.spec.ts` zieht den schweren Chart-Graphen herein; unter voller Parallelität
kompiliert der Dev-Server ihn kalt in mehreren Workern gleichzeitig (selten über der Frist),
deshalb `test.describe.configure({ retries: 2 })` — serial/isoliert ist er zuverlässig grün.
