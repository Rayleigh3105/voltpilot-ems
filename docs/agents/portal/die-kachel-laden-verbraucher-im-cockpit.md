# Die Kachel „Laden" (Verbraucher im Cockpit, Phase 0 PR 2)

Ausgelagert aus `frontend/portal/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 23).


Konzept `vp-verbraucher-cockpit-k1` §5 (Captain-Entscheide E2/E6). Sie beantwortet ohne Klick,
was die Aufschlüsselung nicht kann: **„steckt ein Auto?"** — der Grund, warum Slim allein die
Pflicht-Infos nicht erfüllt (§7). Ohne einen einzigen Ladepunkt existiert der Baustein nicht,
und das Cockpit einer Bestandsanlage ist Zeichen für Zeichen das von vorher
(`migration.test.ts` „eine Anlage OHNE Ladepunkt sieht sie nie").

- **Der Baustein `laden` ist an SECHS Stellen registriert** — beide byte-gleichen Katalog-Kopien
  (`catalog_version` hochgezählt), `BausteinId`, BEIDE kanonischen Listen, `bausteinNodes`,
  `verfuegbar`. Die vollständige Checkliste steht im Katalog-Abschnitt dieses Hauses; die zwei
  Listen in `migration.test.ts` sind der bewusste Wächter davor, das Cockpit JEDER
  Bestandsanlage zu verändern.
- **⚠ EIN Block hat EINEN Wohnort:** `lade-budget` ist mit dieser Kachel aus `kacheln`
  HERAUSGEZOGEN, und die Netzanschluss-Kachel im Kennzahlen-Raster ist damit ersatzlos entfallen
  (`cockpitWidgets.ladebudgetWidget`, die `WidgetId` und ihr `verlaufTarget`-Eintrag sind
  gelöscht). Stünde der Block in beiden `bloecke`, renderte er zweimal und `lastmanagement`
  erschiene unter zwei Bausteinen — gepinnt von `CockpitLayoutServiceTest` in BEIDE Richtungen.
- **Verfügbar ist sie, sobald ein Ladepunkt EXISTIERT** — nicht erst mit einem Budget, sonst
  fehlte sie genau während der Einrichtung (§5.1). Abwählbar über „Anpassen" wie jeder Baustein.
- **Position (E2):** am Telefon direkt unter der Bühne, am Rechner nach der Steuerungs-Zeile.
  ⚠ Damit ist `laden` der ERSTE bewegliche Baustein — mehrere `cockpitLayout.test.ts`-Fälle
  prüfen „der erste Bewegliche kann nicht weiter hoch" und meinen jetzt ihn, nicht `kacheln`.
- **⚠ Sie ist ein BAUSTEIN (Karte), kein Widget im 3er-Raster** (§5.3): eine Kachel mit einer
  Zeile je Ladepunkt ist grösser als eine Kennzahl, und das Raster bliebe sonst nicht ganzzahlig.
- **REINE ANZEIGE** (Captain): kein Start, kein Stopp, keine Freigabe — im Bauteil gibt es
  keinen einzigen `<button>` (in `LadenKachel.test.tsx` festgenagelt). Der Kopf springt auf
  „Ladevorgänge", jede Zeile auf ihre Geräteseite.
- **E6:** bis 6 Zeilen steht jede voll da; ab der siebten bleiben die AKTIVEN und die Ruhenden
  werden EIN Satz. Der Kopf zählt weiter ALLE — kollabiert heisst zusammengefasst.
- **Die Ehrlichkeitsregeln der Kachel** (alle mutationsgeprüft in `ladenKachel.test.ts`): der
  Messwert gehört NUR einem wirklich ladenden Stecker (`kind === 'laedt'`); sind ALLE Säulen
  getrennt, gibt es gar keine Aussage über Autos; „eingesteckt, lädt nicht" ist NICHT „kein
  Auto"; ohne gemeldetes Budget gibt es KEINE Fusszeile (nie eine erfundene 0).
- **Chrome-Beweis 375/768/1440:** 0 px horizontaler Überlauf. Am Telefon fällt der Zustand
  unter den Namen — eine 375-px-Zeile trägt „Eingesteckt · wartet" nicht neben einem Gerätenamen.

