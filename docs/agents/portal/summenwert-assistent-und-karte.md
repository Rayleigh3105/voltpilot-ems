# Summenwert-Assistent und Gerätekarte

Gesamtwegweiser: [H-0 bis H-11](../root/uems-summenwerte-abschluss.md).
Gerätekarte und Rollen-Dialog: [H-7/H-8/H-10](../root/uems-summenwerte-geraetekarte.md).

Der aktuelle gemeinsame Geräte-/Anlagen-Assistent ist unter
[H-5/H-6](../root/uems-summenwert-assistent.md) dokumentiert.
`GesamtwertDialog.tsx` ist nur noch ein Einstieg in `SummenwertAssistent.tsx`.
Kundenwort: `SUMMENWERT`; Live-Rollen: [H-1/H-2](../root/uems-rollen-zuordnung.md).

## Typen, Fassungen, Kennzeichen und Rechte

- `SummenwertAssistent.tsx` ist auch nach AP-10 IP-16 der einzige Anlegefluss.
  `formelAssistent.ts` ergänzt seinen Entwurf um `formel_typ` und `gueltig_ab`:
  Summe und Saldo sind wählbar, Rest verweist auf die elektrische Stellung.
- Eine Änderung läuft über `SummenwertFormelDialog.tsx` und `POST
  …/{id}/formel/fassungen`; sie schreibt eine neue Tagesfassung, nie bestehende
  Terme um. Rückwirkende Tage brauchen zusätzlich `aenderung.rueckwirkend`.
- Karte und Verlauf zeigen Kennzeichen und Zustand aus der Antwort: `berechnet`,
  `saldiert`, Fassung und Herkunft werden nicht clientseitig geraten. Der
  Verlauf liest die Messstellen-Perioden; das frühere Kennzeichen „vorläufig
  (Geräte-Verdichtung)“ ist seit AP-10 IP-10 entfallen.
- Anlegen und neue Formel-Fassung brauchen `messstelle.formel`; Einmal-Lesen
  `messwerte.ansehen`, neue Beobachtung `mess_selektion.bearbeiten`, Rollenwahl
  `geraet.einrichten`, Lebenszyklus/Name `messstelle.bearbeiten`. Die Weichen
  kommen ausschließlich aus `rollen.ts`.
- Kundenwort ist `SUMMENWERT`. `GESAMTWERT` bleibt nur der gleichwertige
  Übergangs-Alias in `glossar.ts`; `copy.test.ts` hält Alias und Altwort-Bestand
  fest und lässt ihn nur schrumpfen.

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
npx playwright test e2e/formel-assistent.spec.ts e2e/gesamtwert.spec.ts   # Typ/Fassung + SUN-30K, 375/768/1440
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
