# Geräteseiten Stufe 1: die BOX ist eine TOR-Seite (`/box`)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 147).


Scout `data/vp-geraeteseite-rev-b8` §4.1 + E3 (Captain-Abnahme 21.08.2026). Die
Box teilte sich eine Seite mit den Geräten DAHINTER und trug dort Abschnitte, die
ihr strukturell nicht gehören (Register, gelesene Register, Komponenten). Sie
beantwortet eine ANDERE Frage - „komme ich an VoltPilot, ist meine Software
aktuell, was hängt an mir?" - und hat deshalb eine eigene Route.

- **`GET /api/v1/sites/{id}/edge-versions` FÄLLT SEIN URTEIL SELBST** (additiv:
  `newestRelease` + das DREIWERTIGE `upToDate`). Es gab bis hierher keinen
  KUNDEN-Lesepfad auf das Release-Register - der Soll-Stand lag allein im
  Flotten-Aggregat hinter `/admin/**`, also konnte eine Kundenfläche „aktuell"
  gar nicht behaupten. Die reine `ota/EdgeStandVerdict` (Docker-frei geprüft) ist
  die EINE Regel; sie ist die Server-Hälfte der Portal-Ableitung `adminFleet.edgeStand`
  und teilt deren Präfix-Regel (`RolloutStates.releaseIsRunning`).
- **⚠ Das Register wird über die APP-Rolle gelesen** (`EdgeVersionRepository.releases()`,
  `GRANT SELECT` aus `V20260803020000`), NICHT über die BYPASSRLS-`EdgeReleaseRepository`
  - die Disziplin „BYPASSRLS bleibt hinter `/admin/**`" gilt auch für eine
  globale, mandantenlose Tabelle. **Und es reist NICHT mit:** nach draußen geht
  nur das URTEIL plus der Soll-Name; die Kundenfläche bekommt kein Release-Register.
- **⚠ `upToDate` ist DREIWERTIG, und `null` heißt „nicht einzuordnen", nie
  „veraltet"**: leeres Register (kein Maßstab), leerer Stempel, oder ein Stand,
  den das Register nicht führt. Nur ein Treffer nach der Präfix-Regel erlaubt den
  Vergleich, und verglichen wird `release_seq` - **nie ein Versionsstring** (die
  dokumentierte `parseInt("665d59b8…")`-Falle).
- **Portal: `/box[/{ref}]` ist die Route, `…/geraet/{ref}` LEITET UM** (E3) - die
  Referenz reist mit, damit die Weiterleitung auch auf einer Mehr-Geräte-Anlage
  verlustfrei ist; jedes Lesezeichen gilt. Die Box-Gattung ist damit aus
  `geraetSeite.ts` VOLLSTÄNDIG entfernt (`GeraetArt` kennt nur noch
  `hauptgeraet|quelle|ladepunkt`), statt tot mitzulaufen.
- **Beweise:** rein `EdgeStandVerdictTest` (6) · `PortalApiTest`
  (Register-Urteil + die drei `null`-Fälle) · portal `boxSeite.test.ts` (19) +
  `BoxSeiteSection.test.tsx` (12) + `nav.test.ts` (Route, Weiterleitung,
  Rundlauf).

