# Der Summenwert-Assistent und seine Anzeige

Der aktuelle gemeinsame Geräte-/Anlagen-Assistent ist unter
[H-5/H-6](../root/uems-summenwert-assistent.md) dokumentiert.
`GesamtwertDialog.tsx` ist nur noch ein Einstieg in `SummenwertAssistent.tsx`.
Kundenwort: `SUMMENWERT`; Live-Rollen: [H-1/H-2](../root/uems-rollen-zuordnung.md).

## Die Anzeige danach

- **Gesamtwert-Anzeige + Einstieg** `src/components/GesamtwertKarten.tsx`: seit vp-agg (Konzept
  `data/vp-agg-konzept3-r8` §2.5) **nicht mehr auf der Cockpit-Bühne**, sondern in
  **„Verlauf › Messwerte"** (`pages/MesswerteSection.tsx`) — dort leben Einstieg (der
  „+ Summenwert"-Knopf öffnet denselben `SummenwertAssistent`) UND Anzeige gemeinsam (Prop `eingebettet` =
  Host trägt Überschrift + Einstieg, die Karten lassen ihren eigenen Kopf weg). Der rollenlose
  Summenwert gehört zu den Auswertungen, nicht auf die Bühne. Live-Wert aus `GET …/{id}/wert`,
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

⚠ `e2e/gesamtwert.spec.ts` zieht den schweren Chart-Graphen herein; unter voller Parallelität
kompiliert der Dev-Server ihn kalt in mehreren Workern gleichzeitig (selten über der Frist),
deshalb `test.describe.configure({ retries: 2 })` — serial/isoliert ist er zuverlässig grün.
