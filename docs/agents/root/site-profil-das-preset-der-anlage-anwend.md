# `site.profil`: das PRESET der Anlage (Anwendungs-Programm Stufe 2)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 119).


Captain-Entscheid **E3** vom 24.08.2026, wörtlich: „Ja: `site.profil` (privat|gewerbe, nullable) als
Preset + Tonalität + Reset-Basis, **nie ein Signal der Ableitung**; Bestand NULL = unverändert."
Migration `V20260838000000` (additiv, nullable OHNE Default, CHECK auf die zwei Wörter). **Eine
Anlage ohne Profil — also JEDE Bestandsanlage — verhält sich zeichengleich wie vor dieser Stufe**,
und das ist als Test festgenagelt (Portal `migration.test.ts` „Anwendungs-Preset Stufe 2").

- **⚠ Es hat GENAU DREI Wirkungen, und keine davon ist eine Verzweigung in der Datenwahrheit:**
  (1) die Vorauswahl im Regal, (2) die TONALITÄT der Geld-Sprache, (3) die Reset-Basis des
  Layouts (Stufe 3). **Die Aktivierungs-Ableitung kennt das Feld nicht** — `AnwendungDerivation.Input`
  bzw. `AnwendungSignals` haben gar keinen Platz dafür, und genau das ist der Beweis: was auf einer
  Anlage läuft, bleibt Anwendungen × Fähigkeiten. Ein Profil, das eine Anwendung aktivierte, wäre
  die harte Verzweigung, die M0 abgeschafft hat.
- **ZWEITE ACHSE, nicht dieselbe:** `tenant.betriebsart` (endkunde|betreiber) ist die SCHALE je
  Kunde, dieses Profil hängt an der ANLAGE — eine Organisation kann eine Privat- und eine
  Gewerbe-Anlage besitzen.
- **Die PRESETS sind Katalog-Daten, aber die LISTE steht dort NICHT** (`anwendungen/catalog.json`
  `presets` + `profile`/`tonalitaeten`): der Block trägt nur das Profil-eigene (Label, den
  „wir starten mit …"-Satz, die Tonalität `sparen|verdienen`). **Welche Anwendungen ein Profil
  einschaltet, wird aus dem `preset`-Feld JE ANWENDUNG abgeleitet** (`AnwendungKatalog.vorauswahl`
  ⟷ TS `vorauswahl`) — eine zweite Liste am Profil wäre eine zweite Wahrheit, die davon abdriftet.
  Die Portal-Kopie bleibt BYTE-gleich gepinnt.
- **⚠ Eine BASIS-Anwendung steht NIE in der Vorauswahl**, obwohl ihr Katalog-Eintrag auf `an` steht:
  sie läuft ohnehin und hat gar keinen Schalter, der Server lehnt einen Schaltversuch mit 400 ab —
  sie vorzuschlagen hieße, eine Handlung anzubieten, die es nicht gibt.
- **Schreibweg: `PUT /api/v1/sites/{siteId}/anwendungs-preset`** (`SiteProfileController`, dessen
  Klassen-Mapping dafür auf `/api/v1/sites/{siteId}` gerückt ist — die zwei `/profiles`-URLs sind
  unverändert). Mandantenbezogen wie jede `/sites/**`-Route (kein `@PreAuthorize`, RLS ist der Zaun,
  fremde Anlage 404, Admins über den `X-Tenant-Id`-Umschalter). **Bewusst eine SCHMALE Route statt
  eines Feldes im Stammdaten-Formular:** der Assistent schreibt das Profil aus einem Schritt heraus,
  der die Tarif-/Vergütungsfelder nie geladen hat, und ein voll-repräsentatives
  `PUT /sites/{id}` von dort wäre ein Überschreib-Risiko. **⚠ Der Pfad heißt ausdrücklich NICHT
  `/profil`** — das läge EIN Zeichen neben dem bestehenden `/profile` (dem AE7-Nutzungsprofil).
- **⚠ `SiteProfileService.setProfil` schaltet ABSICHTLICH keine Anwendung.** Eine Profil-Wahl, die
  nebenbei Schalter umlegt, nähme dem Kunden die Entscheidung ab, die das Regal sichtbar macht — und
  ein späteres „Profil ändern" überschriebe rückwirkend seine eigenen Schalter. Der Assistent legt
  die vorgeschlagenen Schalter deshalb EINZELN über `PUT /profiles` um; **damit sät
  `SiteProfileService.switchOn` den Starter für JEDEN Kunden**, nicht mehr nur für einen Admin (das
  war die stille Lücke: `entitiesApi.autoStart` lief im Assistenten hinter einem `if (admin)`).
- **`usage_profile_override` wird vom Portal NICHT MEHR GESCHRIEBEN** (F5 zu Ende): die Spalte und
  ihre Route bleiben, aber `PROFILE_OPTIONS`/`setUsageProfileOverride`/`autoStart` sind aus dem
  Assistenten ERSATZLOS entfallen. Der Abbau-Wächter in `migration.test.ts` prüft das auf dem
  KOMMENTAR-freien Text (die Grabstein-Notizen nennen die entfernten Namen absichtlich).
- **Tonalität (Portal `fleet.ts siteTonalitaet`/`fleetTonalitaet`):** `privat` spart, `gewerbe`
  verdient, **ohne Profil gilt byte-identisch die bisherige `plant_kind`-Regel**. Vorher hing der
  Ton an der VERÄUSSERUNGSFORM statt an der Zielgruppe — ein Gewerbebetrieb im Eigenverbrauch las
  „gespart" wie ein Privathaushalt.
- **Beweise:** rein `AnwendungKatalogTest` (+4: die zwei Profile mit Satz + Tonalität, das
  geschlossene Preset-Vokabular je Eintrag, die abgeleitete Vorauswahl ohne Basis-Anwendung, keine
  reservierte) · Testcontainers
  `SiteProfileApiTest.theApplicationPresetIsStoredWithoutTouchingASingleSwitch` (echte DB +
  Keycloak: Bestand NULL, gespeichert und zurückgemeldet, **der Regal-Zustand bleibt Zeichen für
  Zeichen derselbe**, Umschalten/Löschen, benannte Ablehnung ohne Schreibvorgang, RLS 404,
  Admin-Umschalter) · Portal `anwendungen.test.ts` (+22) · `fleet.test.ts` (+5) ·
  `migration.test.ts` (+3) · `components/AnlageFlow.test.tsx` (der Assistent) ·
  `pages/AnlageTechnik.test.tsx` („Profil ändern"). Portal-Seite in `frontend/portal/AGENTS.md`.
- **NICHT in dieser Stufe:** der Layout-Speicher (Stufe 3, seither GEBAUT — siehe „Cockpit
  anpassen"; `site.profil` ist dort die Preset- und Reset-Basis) · das komponierte Portfolio
  (Stufe 4) · ein
  „Anwendungen auf das Preset zurücksetzen" (es wäre eine zweite, rückwirkende Wirkung auf Schalter,
  die der Kunde selbst gestellt hat; wer sie ändern will, tut das im Regal).

