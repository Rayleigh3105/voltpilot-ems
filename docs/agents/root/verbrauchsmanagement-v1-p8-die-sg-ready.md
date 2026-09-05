# Verbrauchsmanagement v1 / P8: die SG-Ready-Wärmepumpe ist ein eigener Typ

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 163).


Konzept `data/vp-verbrauchsmgmt-konzept-v1` §3.1/§3.3/§3.4/§3.5, **Captain-Entscheid E9: nur
Zustand 3 „Anlaufempfehlung", EIN Relais**. Betreiber-Handbuch:
[`docs/waermepumpe-sg-ready.md`](docs/waermepumpe-sg-ready.md). **Kein Edge-Release, kein neuer
Vertrag** — der Katalogtyp ist additiv, jeder bestehende Verbraucher verhält sich zeichengleich.

- **⚠ DIE EINE AUSSAGE, aus der jede Regel folgt: es wird eine FREIGABE geschaltet, kein Gerät.**
  Ein potentialfreier Kontakt liegt auf dem SG-Ready-Eingang 2; ob die Pumpe anläuft und wie
  stark, entscheidet SIE. Also: kein Ziel, keine kW, keine Energie-Behauptung.
- **⚠ Der Nachweis ist eine EIGENE D3-Stufe `freigabe`, kein `relay_state`.** Ohne sie hätte
  `ConsumerService.confirmationChannelFor` `relay_state` → `ASSUMED` → „Nennleistung × Zeit"
  abgeleitet, also eine erfundene Energie über ein Gerät, dessen Verbrauch wir nicht messen.
  `EnergyConfirmation.FREIGABE` erzeugt deshalb NIE eine Energie-Zahl — und weil das gespeicherte
  Niveau nur NEBEN einer Energie-Zahl steht, erreicht das Wort die Spalte `energy_confirmation`
  gar nicht (keine Migration am CHECK nötig). `hasReadback()` bleibt true: die LAUFZEIT der
  Freigabe ist belegt.
- **⚠ Der Kanal hängt am TYP, nicht am gebundenen Gerät.** Auch ein messendes Shelly (1PM/Plug S)
  misst auf einem potentialfreien Kontakt nichts — der Strom der Pumpe fließt woanders. Die
  Typ-Regel läuft deshalb VOR der Geräte-Ableitung (`SgReady.confirmationChannel`).
- **⚠ Die Nennleistung ist OPTIONAL — und das ist eine SCHEMA-Änderung** (Migration
  `V20260862000000`: `rated_power_kw` verliert NOT NULL, der CHECK wird `IS NULL OR > 0`). WER sie
  weglassen darf, steht im Anwendungscode (`SgReady.ratedPowerOptional`), nicht im Schema — jeder
  andere Typ verlangt sie unverändert. Jeder Leser der Spalte war schon null-tolerant
  (`ConsumerPolicyCompiler`, `ConsumerRequirementLedger.actualEnergy`,
  `ConsumerOverrideService.clampToRated`, `EntityRegistryService.defaultGuards`), eine fehlende
  Nennleistung erzeugt damit keine Guard-Grenze und keine angenommene Energie, nie eine 0.
  Das Portal liest die SERVER-Wahrheit `TypeOption.ratedPowerRequired` statt den Typ ein zweites
  Mal zu kennen; ein älteres Backend ohne das Feld verlangt sie überall.
- **⚠ Die TYP-Regeln stehen NEBEN `ConsumerPolicyValidator`, nie darin.** Der ist ein
  DOKUMENT-Validator mit einem TS-Zwilling und geteilten Vektoren
  (`docs/contracts/v2/consumer-policy-vectors.json`) und kennt den Verbrauchertyp per Konstruktion
  nicht; ihn dafür zu erweitern ließe die zwei Zwillinge auseinanderlaufen. `SgReady.findings`
  wird in `ConsumerService.savePolicyDraft` NACH ihm angehängt und lehnt für diesen Typ ein
  Frist-Ziel (`flexible_task` · `required_by_deadline` · `demand`) und jedes Nicht-`on_off`-Ziel
  ab — **für jeden anderen Typ ist die Liste leer**.
- **Die Vorlage (§3.3) ist rein und wartet auf P2:** `SgReady.policyDocument` projiziert
  `freigabe_ueberschuss`/`freigabe_guenstig` auf `reactive` + `opportunistic` + `on_off:true`.
  **⚠ Die Hysterese hängt an der Signal-KLASSE:** das LOKALE `site.pv_surplus_kw` bekommt
  `reset_value` (0,75 × Schwelle) + `max_age_s` 120, das CLOUD-Signal
  `market.import_price_ct_kwh` bekommt KEINE (der Validator lehnt sie dort ab,
  `cloud_signal_hysteresis`). Mindestfreigabe (30 min) und Sperrzeit (20 min) sind deshalb
  PROFIL-Felder (`min_on_seconds`/`min_off_seconds`, Zyklen-Wächter auf der Box), kein
  Dokument-Feld.
- **Simulator:** `vp-consumer-sim --preset heat-pump-sgready`. `consumersim.Config.ReleaseContact`
  ist der Grund für einen eigenen Zweig in `Apply`: ein Freigabe-Kontakt ist **EIN bei 0 kW**, und
  ohne diese Regel fiele er auf „applied <= 0 heißt aus" durch und meldete eine gesetzte Freigabe
  als aufgehoben.
- **NICHT gebaut (E9):** Zustand 4 „Anlaufbefehl" (zwingt die Pumpe, braucht Hersteller-Freigabe
  je Modell und ein zweites Relais) und Zustand 1 „Sperre" (gehört dem Netzbetreiber). Ebenso
  nicht: der Steuerart-DIALOG (P2 hängt den Typ nur noch ein) und der geführte Adoptionspfad
  `setupPath.ts` (er brächte die noch nicht entworfene „Regel anlegen?"-Brücke mit).
- **Beweise:** rein `SgReadyTest` (10, mutationsgeprüft: Typ-Gate, Stufe, „nie eine Energie-Zahl",
  beide Vorlagen gegen den ECHTEN Validator, jede der drei Frist-Kennzeichen einzeln) ·
  Testcontainers `ConsumerApiTest.sgReadyLaeuftOhneNennleistungWeistNurDieFreigabeNachUndKenntKeinZiel`
  · Go `consumersim` · Portal `consumers/questions.test.ts` · `geraetGesicht.test.ts` ·
  `components/VerbraucherDrawers.test.tsx`.

