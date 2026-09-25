# BWB-2026-01 · Laufprotokoll des ersten Laufs am gebauten Stand (AP-20 IP-10)

Begleitblatt zum Entwurf [`BWB-2026-01`](BWB-2026-01.md). Es sagt, wie die Lauf-Berichte entstanden sind, welche Fälle übersprungen wurden und welche Testklassen nicht gefahren wurden. Es ist nicht Teil des Entwurfs: dessen Prüfsummen stehen in [`BWB-2026-01.sha256`](BWB-2026-01.sha256), dieses Blatt hat seine eigene in [`BWB-2026-01-laufprotokoll.sha256`](BWB-2026-01-laufprotokoll.sha256).

> Dieser Bericht zeigt, welche Zusagen von VoltPilot an welchem Stand mit welchem Nachweis geprüft sind. Er ist keine Zertifizierung, keine Förderlistung und keine rechtliche Bewertung.

| Angabe | Wert |
|---|---|
| Stand der Läufe | `09862815f0d7a78e8a1d0e73160b74abd346bcf3` (`origin/uems` beim Start am 25.09.2026) |
| gefahren am, von | 25.09.2026, Crew (Lauf AP-20 IP-10); jeder Lauf-Ordner trägt eine `stand.txt` mit diesem Stand |
| Umgebung | Mac mit Docker Desktop (Testcontainers), JDK 21, Node 25.2.0, Go 1.26.5, Python über `uv` |
| Prüfer und Matrix | `tools/bewertung/pruefe_matrix.py` und `docs/bewertung/nachweismatrix.json` am Stand `e803c2eba` (`uems` mit PR 1267 und PR 1271; Prüfer und Matrix sind seit dem Lauf-Stand geändert, die Kandidaten nicht) |
| Entwurf | `BWB-2026-01.json`, SHA-256 `5450ec7d3f8b90f395eaa5588b5cb8ecc3cec8030902250099163159b724fbe4` |

Aufruf des Prüfers:

```sh
python3 tools/bewertung/pruefe_matrix.py \
  --laeufe services/api/target/surefire-reports \
  --laeufe services/timescale-writer/target/surefire-reports \
  --laeufe frontend/portal/target/vitest-junit \
  --laeufe frontend/portal/target/playwright-junit \
  --laeufe edge-app/core/target/go-junit \
  --laeufe edge-app/nodered/target/node-junit \
  --laeufe tools/edge-simulator/target/pytest-junit \
  --stand 09862815f0d7a78e8a1d0e73160b74abd346bcf3 --heute 2026-09-25 --art gebaut
```

Die Lauf-Ordner liegen unter `target/` und sind nicht eingecheckt. Der Entwurf hält je Nachweis die SHA-256 der Berichtsdatei fest.

## Die Läufe

| Lauf-Ordner | Befehl | Berichte | Klassen oder Dateien | Fälle | grün | rot | übersprungen |
|---|---|---|---|---|---|---|---|
| `services/api/target/surefire-reports` | Surefire: `./mvnw clean test -Dsurefire.includesFile=<67 Kandidaten-Klassen> -Dspring.test.context.cache.maxSize=4` (ein Stapel, Testcontainers, 19:01 bis 20:00 Uhr MESZ) | 67 | 67 | 2185 | 2184 | 0 | 1 |
| `services/timescale-writer/target/surefire-reports` | Surefire: `./mvnw clean test -Dtest=UemsStreckeAbnahmeTest,WriterPipeTest` (Testcontainers) | 2 | 2 | 26 | 26 | 0 | 0 |
| `frontend/portal/target/vitest-junit` | Vitest: `npx vitest run --reporter=default --reporter=junit` (ganze Vitest-Suite) | 1 | 561 | 11741 | 11741 | 0 | 0 |
| `frontend/portal/target/playwright-junit` | Playwright: `npx playwright test e2e/steuern-assistent.spec.ts e2e/startansicht.spec.ts --reporter=line,junit` (alle vier Projekte, WebKit eingeschlossen) | 1 | 2 | 68 | 68 | 0 | 0 |
| `edge-app/core/target/go-junit` | gotestsum: `gotestsum --junitfile … -- ./...` (ganzes Modul `edge-app/core`, ohne `-race`) | 1 | 46 | 2229 | 2229 | 0 | 0 |
| `edge-app/nodered/target/node-junit` | node --test: `node --test --test-reporter=junit` über die 53 `*.test.js` wie im CI-Schritt „Node-RED runtime and drivers“ | 1 | 1 | 1091 | 1090 | 0 | 1 |
| `tools/edge-simulator/target/pytest-junit` | pytest: `python -m pytest <die sechs Dateien aus make test> --junitxml=…` | 1 | 6 | 77 | 77 | 0 | 0 |

Rot ist in keinem Lauf ein Fall.

## Übersprungene Fälle

| Lauf-Ordner | Klasse oder Datei | Fall | Grund | Kandidat? |
|---|---|---|---|---|
| `services/api/target/surefire-reports` | `com.voltpilot.api.uems.UemsBestandSteuerungAusEinemStueckTest` | buehneVorherNachherAntwortenAufzeichnen | Annahme im Test: nur der IP-20-Werkzeuglauf zeichnet Portalantworten auf | nein, keine Zusage nennt ihn |
| `edge-app/nodered/target/node-junit` | `edge-app/nodered (node --test)` | a real non-default password is hashed and accepted | bcryptjs not installed in this checkout (present in the image) | nein, keine Zusage nennt ihn |

Die übrigen Fälle von `UemsBestandSteuerungAusEinemStueckTest` sind grün; die Matrix nennt die Klasse nur mit Methoden, darum trägt der übersprungene Fall kein Urteil. Die Gegenprobe unten zeigt, dass er als Kandidat offen bliebe.

## Kandidaten ohne lesbaren Lauf

Diese Kandidaten nennen keinen Bericht, den der Prüfer lesen kann. Die Zeile bleibt offen (NR1, NR7).

- Z-007 · `kandidat_ohne_lauf` · docs/contracts/v2/wago-registerbild-vectors.json (Simulator)
- Z-007 · `fall_fehlt` · edge-app/nodered/measurements/wago-registerbild.test.js#die Simulator-Faelle S1…S6 ueber den echten Modbus-Weg
- Z-008 · `kandidat_ohne_lauf` · docs/rollout/gemeinsame-steuerung-ausfalltests.md (Simulator, AP-15 NW-3)
- Z-014 · `kandidat_ohne_lauf` · infra/prod/keycloak/voltpilot-realm.json:9 (sslRequired external)
- Z-015 · `kandidat_ohne_lauf` · tools/backup/test-backup-restore.sh (Wegwerf-Container)
- Z-015 · `uebung_fehlt` · tools/generalprobe/rueckweg.sh → rueckweg.json (AP-14 NW-8)
- Z-017 · `kandidat_ohne_lauf` · services/api/src/main/resources/db/migration/V20260915030000__uems_zugriff.sql:19 (zugriff_protokoll)
- Z-019 · `kandidat_ohne_lauf` · docs/fachmodell/tools/check_belege.sh (Glossar und Fachmodell: jeder Beleg datei:zeile zeigt auf eine Datei)

Zu Z-007, `fall_fehlt`: `node --test --test-reporter=junit` schreibt einen Test mit Untertests als `<testsuite>`. Der Fall „die Simulator-Faelle S1…S6 ueber den echten Modbus-Weg“ steht darum nicht als `<testcase>` im Bericht, seine sechs Untertests S1 bis S6 sind grün. Der Prüfer liest heute nur `<testcase>`. Z-007 bliebe auch sonst offen: Lücke L-007 (Hardwarebeleg WAGO) und der Prüfstand des Betreibers.

## Blatt des Betreibers

Ein Stand-Blatt ist nicht geliefert. Z-013 („Server in Deutschland“) und Z-014 („Verschlüsselt“) bleiben offen, bis der Betreiber sie mit Person und Datum bestätigt. Dasselbe gilt für jeden anderen Rest des Betreibers.

## Gegenproben an den echten Berichten (RF-01, RF-11)

Beide Gegenproben schreiben in einen Wegwerf-Ordner (`--aus`), nicht hierher.

- **RF-01, belegt:** Z-002 ist `belegt` durch `UemsProduktionsrueckgangAbnahmeTest#r2PlanAbnahmeRohOhneUrteilBereinigtSchlechter` und `#r10…`, Stand `09862815f`, 25.09.2026, Crew (Lauf AP-20 IP-10), Bericht `services/api/target/surefire-reports/TEST-com.voltpilot.api.uems.UemsProduktionsrueckgangAbnahmeTest.xml`.
- **RF-01, Gegenprobe übersprungen:** dieselben Berichte, eine Kopie der Matrix, in der Z-010 zusätzlich `UemsBestandSteuerungAusEinemStueckTest#buehneVorherNachherAntwortenAufzeichnen` nennt: im selben Bericht ist `#migrationenUndAlleLaeuferSchaltenNichtsUndBewahrenDenBestand` grün, der zweite Fall „1 von 1 Fällen übersprungen“, die Zeile offen (NR2).
- **RF-11, älterer Stand:** dieselben Berichte mit `--stand e803c2eba` (der neuere Kopf von `uems`): 76 von 76 Zusagen offen, 159 Test-Befunde „älterer Stand: der Bericht stammt laut stand.txt von 09862815f“ (NR3). Z-009 (`UemsMesskundenLaufAbnahmeTest`) ist an `09862815f` grün und trägt `e803c2eba` nicht. Zwischen beiden Ständen liegen unter anderem Änderungen an `UemsEnergiemanagementAbnahmeTest`, an der Rechte-Matrix und an den MQTT-Rückmeldewegen; erst ein neuer Lauf trägt sie.

Ein Versuch, die Gegenprobe „übersprungen“ mit `DOCKER_HOST` auf einen leeren Socket zu fahren, lief grün: Testcontainers fand Docker Desktop über seine eigene Strategie. Der dabei überschriebene Bericht wurde aus der Sicherung zurückgelegt; alle 67 Berichte sind bytegleich mit dem Stapel.

## Nicht gefahren – kein Kandidat, trägt kein Urteil

Der Prüfer liest nur Berichte zu Kandidaten der Matrix (NR1). Klassen ohne Kandidat wurden in diesem Lauf nicht gefahren; der Lauf aller Suiten gehört zum Bericht am ausgelieferten Stand (AP-20 IP-24). Ganz gefahren sind die Vitest-Suite, das Go-Modul `edge-app/core`, die Node-RED-Tests und die Simulator-Tests (Tabelle oben).

| Modul | nicht gefahren | gefahren |
|---|---|---|
| `services/api` | 585 Testklassen | 67 Kandidaten-Klassen |
| `services/timescale-writer` | 19 Testklassen | 2 Kandidaten-Klassen |
| `services/ingest` | 23 Testklassen | keine, kein Kandidat |
| `frontend/portal/e2e` | 95 Specs | 2 Kandidaten-Specs |
| `edge-app/nodered/vp-palette` | 16 Mocha-Specs | keine, kein Kandidat |
| `catalog/measurement-points/tests` | 3 pytest-Dateien | keine, kein Kandidat |
| `services/forecast/tests` | 19 pytest-Dateien | keine, kein Kandidat |
| `services/market-data/tests` | 12 pytest-Dateien | keine, kein Kandidat |
| `services/marketing-adapter/tests` | 1 pytest-Datei | keine, kein Kandidat |
| `services/optimization/tests` | 66 pytest-Dateien | keine, kein Kandidat |
| `tools/freigabe` | 1 pytest-Datei | keine, kein Kandidat |
| `tools/generalprobe` | 1 pytest-Datei | keine, kein Kandidat |
| `tools/lastprofil-messung` | 1 pytest-Datei | keine, kein Kandidat |
| `tools/tests` | 1 pytest-Datei | keine, kein Kandidat |
| `tools/uems-verbund-sim` | 2 pytest-Dateien | keine, kein Kandidat |

`tools/bewertung` lief mit `python3 -m unittest discover -s tools/bewertung -p 'test_*.py'` ohne JUnit-Bericht; seine Tests sind Werkzeugtests und keine Kandidaten.

### `services/api`: 585 Testklassen ohne Kandidat

- `com.voltpilot.api` (46): `AdminApiTest`, `AdminWhatIfApiTest`, `AhrenbergDemoLoginTest`, `ChargerApiTest`, `CockpitLayoutApiTest`, `CommandHistoryApiTest`, `ComponentAdoptionApiTest`, `ComponentApiTest`, `ComponentTemplateAdminApiTest`, `ComponentTemplateApiTest`, `ConsumerApiTest`, `ControlCertificationApiTest`, `CustomerFlowApiTest`, `DevSeedGuardTest`, `DeviceAttributionTest`, `DeviceMeasurementSelectionApiTest`, `EdgeStandVerdictTest`, `EnrollmentApiTest`, `FlowApiTest`, `FlowLayoutApiTest`, `FlowPeakShavingApiTest`, `FlywayIgnoreMissingBootTest`, `FlywayOutOfOrderBootTest`, `FlywayStartupGuardTest`, `K8sReadinessConfigTest`, `KeycloakPartnerRolleApiTest`, `MastrApiTest`, `MeasurementHistoryMoveMigrationTest`, `MeasurementSelectionApiTest`, `MigrationHygieneTest`, `OtaRolloutApiTest`, `PortalApiTest`, `ProbeApiTest`, `ProduktionsRealmAnmeldungTest`, `ProduktionsRealmImportTest`, `ProvisioningClaimTest`, `RegisterWriteApiTest`, `RegistrationApiTest`, `RlsIsolationTest`, `SelfBuildComponentApiTest`, `SelfHealingFlywayMigrationStrategyTest`, `SimulationApiTest`, `SiteProfileApiTest`, `SteuerartApiTest`, `UsageProfileApiTest`, `VerbraucherApiTest`
- `com.voltpilot.api.admin` (1): `OffboardingKontenTest`
- `com.voltpilot.api.benutzer` (2): `BenutzerStartpasswortApiTest`, `StartpasswortGeheimhaltungTest`
- `com.voltpilot.api.chargers` (8): `ChargerComponentComposerTest`, `ChargerStatusListenerTest`, `ChargingBoostPublisherTest`, `ChargingConfigPublisherTest`, `LadeparkGrenzeAnstossApiTest`, `LadeparkJeBoxApiTest`, `LadeparkJeBoxVectorsTest`, `NetzanschlussGrenzeApiTest`
- `com.voltpilot.api.cockpit` (3): `CockpitLayoutServiceTest`, `EigeneAuswertungTest`, `PortfolioPresetTest`
- `com.voltpilot.api.command` (2): `CommandFilterTest`, `CommandLogTest`
- `com.voltpilot.api.components` (27): `BatteryHybridPvPowerBackfillMigrationTest`, `ComponentActivationOperationsTest`, `ComponentActivationOutboxWiringTest`, `ComponentAdoptionAusgebauteBoxTest`, `ComponentAdoptionTest`, `ComponentAdoptionWiringTest`, `ComponentCapabilitiesRepairMigrationTest`, `ComponentConnectionReceiptsTest`, `ComponentDefaultsTest`, `ComponentEditCapabilitiesTest`, `ComponentLabelsTest`, `ComponentRebindTest`, `ComponentSecretsTest`, `ComponentSyncStatusTest`, `ComponentTakeoverTest`, `KomponenteLoeschenBelegschutzTest`, `ProtectionProfileTest`, `SelfBuildDefinitionTest`, `SocCurveTemplateTest`, `SocFromVoltageBoundsTest`, `SwitchDefinitionTest`, `UserDefinedBatteryBindingTest`, `UserDefinedBatteryDefinitionTest`, `UserDefinedBatteryFlowCompilerTest`, `UserDefinedBatteryHttpSecretTest`, `UserDefinedBatteryProtectionPersistenceTest`, `UserDefinedBatteryProtectionTest`
- `com.voltpilot.api.config` (3): `HealthProbeSecurityTest`, `KeycloakRealmRoleConverterTest`, `MetricsEndpointSecurityTest`
- `com.voltpilot.api.consumers` (12): `ConsumerAuditEventTypesTest`, `ConsumerPolicyActivationBrokerTest`, `ConsumerPolicyCompilerTest`, `ConsumerPolicyValidatorTest`, `ConsumerReplanTriggerListenerTest`, `ConsumerReplanTriggerTest`, `ConsumerRequirementLedgerTest`, `ConsumerRequirementLedgerWriterTest`, `ConsumerRuntimeStatusListenerTest`, `LoadResidualReplanListenerTest`, `LoadResidualReplanTriggerTest`, `SgReadyTest`
- `com.voltpilot.api.control` (2): `ControlCertificationPublisherTest`, `ControlStatusListenerTest`
- `com.voltpilot.api.curtailment` (1): `CurtailmentStatusListenerTest`
- `com.voltpilot.api.enrollment` (8): `AclGrantWriterTest`, `AclRegenerateReloadBrokerE2eTest`, `AclSelfHealBrokerE2eTest`, `BrokerAuthzReloaderContextTest`, `BrokerAuthzReloaderTest`, `CsrsTest`, `DeviceCertificateAuthorityTest`, `EnrollmentServiceStartupReloadTest`
- `com.voltpilot.api.entities` (16): `EinmalAuftraegeTest`, `EntityAutoComposerTest`, `EntityRegistryChargePointTest`, `EntityRegistryFlexTest`, `EntityRegistryRoleAssignmentTest`, `EntityRegistryRuhePushTest`, `EntityRegistryServiceTest`, `EntityStatusListenerTest`, `EvChargerCatalogTypeTest`, `LeadDeviceBestandVerhaltensgleichTest`, `LeadDeviceServiceTest`, `RegistryPushJeBoxBestandTest`, `UemsQuellenUebergabeTest`, `UserDefinedBatteryCatalogTypeTest`, `V2SiteBackfillReconcileWiringTest`, `V2SiteBackfillRunnerTest`
- `com.voltpilot.api.fahrzeuge` (1): `FahrzeugSteuerartTest`
- `com.voltpilot.api.fleet` (1): `FleetPflegeTest`
- `com.voltpilot.api.flows` (11): `FlowActivationBrokerTest`, `FlowActivationServiceTest`, `FlowCompilerClientTest`, `FlowDeploymentPublishBrokerTest`, `FlowDeploymentTest`, `FlowGovernanceTest`, `FlowGraphValidatorTest`, `FlowNodeStatusListenerTest`, `FlowSimulationMapperTest`, `FlowTemplatesTest`, `SelfconsumptionFlowSweepRunnerTest`
- `com.voltpilot.api.forecast` (1): `ForecastModelsTest`
- `com.voltpilot.api.history` (5): `EreignisseTest`, `HistoryCoverageTest`, `HistoryRangeTest`, `TagesprotokollTest`, `UemsBilanzenBestandsschutzTest`
- `com.voltpilot.api.interventions` (1): `HandeingriffTest`
- `com.voltpilot.api.kundenbereich` (1): `KundenbereichEndeTest`
- `com.voltpilot.api.mastr` (5): `MastrCatalogTest`, `MastrJsonClientTest`, `MastrNumbersTest`, `MastrServiceTest`, `MastrSoapClientTest`
- `com.voltpilot.api.measurement` (19): `BestandGeraeteCsvTest`, `BestandsboxBudgetPruefungTest`, `CustomMeasurementPointTest`, `KatalogEinheitenNutzungAbfrageTest`, `MeasurementBudgetTest`, `MeasurementBudgetVectorsTest`, `MeasurementCatalogFamiliesTest`, `MeasurementCatalogTest`, `MeasurementContractsTest`, `MeasurementHistoryServiceTest`, `MeasurementSelectionRoutingTest`, `MesskanalAbbildungTest`, `MesskanalApiTest`, `MessplanJeKomponenteBestandTest`, `MessplanNachBoxUpdateApiTest`, `MessplanRevisionsAnstossTest`, `SummenwertQuellenServiceTest`, `WagoRegisterbilderDbTest`, `WagoRegisterbilderTest`
- `com.voltpilot.api.metrics` (19): `ConsumerMetricsScrapeTest`, `DauerlaeuferGanzerWegDbTest`, `DauerlaeuferMetrikenDbTest`, `DbHealthMetricsDbTest`, `DbHealthMetricsScrapeTest`, `DbHealthMetricsWiringTest`, `DbStorageMetricsScrapeTest`, `FleetMetricsDbTest`, `FleetMetricsEndpointE2eTest`, `FleetMetricsScrapeTest`, `FleetMetricsTest`, `FleetMetricsWiringTest`, `GemeinsameSteuerungMetrikDbTest`, `GemeinsameSteuerungMetrikScrapeTest`, `UemsMetricsDbTest`, `UemsMetricsEndpointE2eTest`, `UemsMetricsScrapeTest`, `UemsMetrikenWiringTest`, `VmCompressionMeasurementTest`
- `com.voltpilot.api.ocpp` (7): `OcppActionPolicyTest`, `OcppActionRepositoryTest`, `OcppCommandValidatorTest`, `OcppControlCommitTest`, `OcppControlValidatorTest`, `OcppEventListenerTest`, `OcppPrivacyTest`
- `com.voltpilot.api.optimizer` (3): `EegRatesTest`, `SchedulePricingServiceTest`, `SlotEconomicsTest`
- `com.voltpilot.api.ota` (4): `OtaTargetPublisherTest`, `RolloutJournalTest`, `RolloutStatesTest`, `UpdateStatusListenerTest`
- `com.voltpilot.api.probe` (4): `ProbePublisherTest`, `ProbeRegistryTest`, `ProbeResultListenerTest`, `ProbeServiceBoxTest`
- `com.voltpilot.api.profile` (3): `AnwendungDerivationTest`, `AnwendungKatalogTest`, `UsageProfileDeriverTest`
- `com.voltpilot.api.provisioning` (1): `MoveProvisioningOutboxServiceTest`
- `com.voltpilot.api.registerwrite` (11): `RegisterKnowledgeTest`, `RegisterWriteBudgetTest`, `RegisterWriteGatewayTest`, `RegisterWriteKillSwitchTest`, `RegisterWritePublisherTest`, `RegisterWriteReasonWiringTest`, `RegisterWriteRegistryTest`, `RegisterWriteResultListenerTest`, `RegisterWriteSilenceTest`, `RegisterWriteTargetsTest`, `RegisterWriteUplinkListenerTest`
- `com.voltpilot.api.repo` (8): `ConsumerEnergyOverPeriodTest`, `FleetLastPlanRewriteEqualityTest`, `ForecastTableDisciplineTest`, `HotReadRewriteEqualityTest`, `MeasuredSlotsTest`, `PriceSlotEqualityTest`, `SpeicherBankTest`, `StandardSpeicherTest`
- `com.voltpilot.api.rules` (1): `RuleEventsTest`
- `com.voltpilot.api.suggestions` (1): `VorschlaegeTest`
- `com.voltpilot.api.templates` (3): `BuiltinComponentTemplatesTest`, `ComponentTemplateDefinitionTest`, `WagoComponentTemplateSeederTest`
- `com.voltpilot.api.tenant` (3): `BetriebsartTest`, `TenantAwareDataSourceSitzungTest`, `TenantFilterTest`
- `com.voltpilot.api.topology` (5): `EntityRoleAssignmentQuellMigrationTest`, `SiteRollenApiTest`, `TopologyDeriverTest`, `TopologyLatestValueWindowTest`, `TopologyRolePushTest`
- `com.voltpilot.api.uems` (308): `AblesungApiTest`, `AblesungHerkunftVectorsTest`, `AbweichungSchnittstelleVertragTest`, `AenderungSatzTest`, `AnlageUmzugApiTest`, `AnteilLesewegVectorsTest`, `AnteilVerlustApiTest`, `AnteilVerlustAusHerzschlagTest`, `AnteilVerlustSchaetzungApiTest`, `AnteilVerlustSchaetzungTest`, `BerechnetePeriodeVectorsTest`, `BerichtAbzugBildungTest`, `BerichtAbzugUnternehmenTest`, `BerichtCsvTest`, `BerichtFreigabeHilfenTest`, `BerichtLeistungsvergleichTest`, `BerichtPdfTest`, `BerichtRechteTest`, `BerichtRegelwerkTest`, `BerichtSchnittstelleVertragTest`, `BestandAnschlussTest`, `BestandsschutzTest`, `BestandsuebernahmeWiringTest`, `BetriebsabfragenBlaetterTest`, `BewertungFristTest`, `BewertungKriterienApiTest`, `BewertungKriterienSchnittstelleVertragTest`, `BewertungMengenLeserTest`, `BewertungMessabdeckungSchnittstelleVertragTest`, `BewertungRanglisteSchnittstelleVertragTest`, `BewertungUmfangApiTest`, `BewertungUmfangSchnittstelleVertragTest`, `BewertungVectorsTest`, `BezugsArtTest`, `BezugsEinheitTest`, `BezugsPeriodeTest`, `BezugsbasisGrundlageTest`, `BezugsbasisMethodenControllerTest`, `BezugsbasisPflegeApiTest`, `BezugsbasisQuelltextTest`, `BezugsbasisVectorsTest`, `BezugsbasisVergleichSchnittstelleVertragTest`, `BezugsdatenImportSchnittstelleVertragTest`, `BezugsdatenImportVorschauApiTest`, `BezugsdatenVorlageSchnittstelleVertragTest`, `BezugsgroesseApiTest`, `BezugsgroesseSchnittstelleVertragTest`, `BezugswertEingabeApiTest`, `BilanzApiTest`, `BilanzSchnittstelleVertragTest`, `BilanzwertHerkunftVectorsTest`, `BoxFaehigkeitenGemeldetTest`, `BoxTauschApiTest`, `CsvLeserTest`, `DataSourceStatusListenerTest`, `DataSourceStatusMigrationTest`, `DatenquelleAdresseTest`, `DatenquelleBudgetTest`, `DatenquellePruefungBewertungTest`, `DatenquelleRegelnVectorsTest`, `DatenquelleSchnittstelleVertragTest`, `DatenquelleVorschlagApiTest`, `EdgeSupportsLegacyListenerTest`, `EdgeSupportsListenerTest`, `EndgueltigkeitLaeuferReihenfolgeTest`, `EndgueltigkeitWiringTest`, `EnergieeinsatzDatenhaltungTest`, `EnergieeinsatzSchnittstelleVertragTest`, `EnergiemanagementDokumentSchnittstelleVertragTest`, `EnergiemanagementNachweiseApiTest`, `EnergiemanagementNachweiseSchnittstelleVertragTest`, `EnergiemanagementPersonenApiTest`, `EnergiemanagementPersonenSchnittstelleVertragTest`, `EnergiemanagementVectorsTest`, `EnergiemanagementVerantwortungApiTest`, `EnergiemanagementVerantwortungSchnittstelleVertragTest`, `EnergiemanagementVerzeichnisApiTest`, `EnergiemanagementVerzeichnisSchnittstelleVertragTest`, `EnergiemanagementWiedervorlageSchnittstelleVertragTest`, `EnergiezielSchnittstelleVertragTest`, `EreignisVokabularVectorsTest`, `ErgebnisZustandVectorsTest`, `ErsatzwertInvarianteTest`, `ErsatzwertPeriodenTest`, `ErsatzwertWiringTest`, `FaktorenVorschlagApiTest`, `FaktorenVorschlagSchnittstelleVertragTest`, `FeststellungApiTest`, `FeststellungSchnittstelleVertragTest`, `FuehrendeBoxAbleitungVectorsTest`, `FunktionBestandApiTest`, `FunktionBestandWiringTest`, `FunktionSchnittstelleVertragTest`, `FunktionZustandAbleitungVectorsTest`, `GemeinsameSteuerungAusscheidenTest`, `GemeinsameSteuerungBoxTauschApiTest`, `GemeinsameSteuerungEinrichtenApiTest`, `GemeinsameSteuerungSchnittstelleVertragTest`, `GeraetAnlegewegTest`, `GeraetApiTest`, `GeraetSchnittstelleVertragTest`, `GeraeteRueckfallDienstTest`, `GeraeteRueckfallRegelTest`, `GeteiltesRegisterTest`, `GrenzNachweisVectorsTest`, `GrenzeAufloesungVectorsTest`, `ImportVorschauTest`, `InternesAuditApiTest`, `InternesAuditSchnittstelleVertragTest`, `KadenzRegelnTest`, `KanalbindungApiTest`, `KennzahlApiTest`, `KennzahlLaufQuelltextTest`, `KennzahlSchnittstelleVertragTest`, `KennzahlVorlagenTest`, `KorrekturFreigabeApiTest`, `KorrekturFreigabeSchnittstelleVertragTest`, `KorrekturKaskadeWiringTest`, `KorrekturPortalApiTest`, `KorrekturRechteTest`, `KorrekturVorschlagRegelnTest`, `KostenstelleEnergieApiTest`, `KostenstelleEnergieSchnittstelleVertragTest`, `KostenstelleProzessApiTest`, `KostenstelleProzessSchnittstelleVertragTest`, `KundenbereichBeendetApiTest`, `LesepfadQuelleTest`, `LesewegImZugriffApiTest`, `LueckenRegelnTest`, `LueckenWiringTest`, `ManagementbewertungVorlageApiTest`, `MassnahmeSchnittstelleVertragTest`, `MessbedarfApiTest`, `MessbedarfSchnittstelleVertragTest`, `MessmittelAngabenApiTest`, `MessmittelSchnittstelleVertragTest`, `MessreiheEreignisMigrationTest`, `MessstelleApiTest`, `MessstelleFormelApiTest`, `MessstelleFormelFassungApiTest`, `MessstelleFormelFassungMigrationTest`, `MessstelleFormelRegelnVectorsTest`, `MessstelleFormelSchnittstelleVertragTest`, `MessstelleFormelTermMigrationTest`, `MessstelleFormelTermVerteilungMigrationTest`, `MessstelleFormelTypenTest`, `MessstelleFormelVerteilungsTermApiTest`, `MessstelleMigrationTest`, `MessstelleQuelleApiTest`, `MessstelleRegelnVectorsTest`, `MessstelleSchnittstelleVertragTest`, `MessstelleVorschlagApiTest`, `MessstelleWerteRegelnTest`, `MessstelleWerteVersionenApiTest`, `MessstelleZuordnungApiTest`, `MessstelleZuordnungMigrationTest`, `MessstellenregisterNachbarbedarfTest`, `MesswertHerkunftVectorsTest`, `NetzanschlussApiTest`, `NetzanschlussGrenznachweisApiTest`, `NetzanschlussSchnittstelleVertragTest`, `NetzanschlussVectorsTest`, `Nw3AusgeliefertesBoxImageTest`, `OrtAktionenVerschiebenTest`, `OrtApiTest`, `OrtArchivApiTest`, `OrtSchnittstelleVertragTest`, `OrtsbaumAbleitungVectorsTest`, `OrtsbaumLesemodellTest`, `PlanResultListenerTest`, `PlanZustellungApiTest`, `PlanZustellungAufbewahrungWiringTest`, `PushJeBoxTest`, `QuelleEinstellungApiTest`, `QuelleEinstellungRegelnVectorsTest`, `QuelleEinstellungSchnittstelleVertragTest`, `QuelleKadenzApiTest`, `RechteAbleitungVectorsTest`, `RechteKennungenDerRoutenTest`, `RegisterBerechnungTest`, `RichtungspaarTest`, `RollenZuordnungRegelnVectorsTest`, `RuheHinweisRegelTest`, `RuheRegelVectorsTest`, `SprungprobeApiTest`, `SprungprobeRegelTest`, `StammdatumEintragWieFlaecheTest`, `StandortLesemodellTest`, `SteuerungsverbundAnteilDienstTest`, `SteuerungsverbundAnteilVectorsTest`, `SteuerungsverbundMigrationTest`, `SteuerungsverbundRegelnVectorsTest`, `SteuerungsverbundScharfschaltenTest`, `SteuerungsverbundZweischrittTest`, `StrukturAenderungWiringTest`, `SummenwertKontextServiceTest`, `SummenwertKontextVectorsTest`, `TagRegelnTest`, `UebergabeWiringTest`, `UemsAbnahmeKlammerTest`, `UemsAbweichungMigrationTest`, `UemsAkteurVokabularMigrationTest`, `UemsAnlageLeserMigrationTest`, `UemsAuditFeststellungMigrationTest`, `UemsAusgebauteBoxLiveFlaechenApiTest`, `UemsBelegschutzApiTest`, `UemsBerechnetePeriodenwerteMigrationTest`, `UemsBerichtKaskadeTest`, `UemsBerichtKennzahlAbwahlMigrationTest`, `UemsBerichtMigrationTest`, `UemsBewertungFlagArchitekturTest`, `UemsBezugsArtMigrationTest`, `UemsBezugsbasisAnstossTest`, `UemsBezugsbasisFlagArchitekturTest`, `UemsBezugsbasisMigrationTest`, `UemsBezugsdatenBestandsschutzTest`, `UemsBezugsdatenImportMigrationTest`, `UemsBezugsgroesseLoeschenMigrationTest`, `UemsBezugsgroesseMigrationTest`, `UemsBezugsgroesseStammdatumMigrationTest`, `UemsBilanzNeuBerechnetMigrationTest`, `UemsBilanzRestMigrationTest`, `UemsBoxSchluesselBauenMigrationTest`, `UemsDatenquelleMigrationTest`, `UemsEndgueltigkeitTagesklasseTest`, `UemsEnergiemanagementMigrationTest`, `UemsErsatzwertMethodenTest`, `UemsFristVorschlagTest`, `UemsFunktionMigrationTest`, `UemsGeraetMigrationTest`, `UemsGeteilterPunktBoxSchluesselMigrationTest`, `UemsIntervallMomentanwertTest`, `UemsKaskadeErsatzwertTest`, `UemsKennzahlAusloeserTest`, `UemsKennzahlFlaecheNennerTest`, `UemsKennzahlKaskadeTest`, `UemsKennzahlLoeschenMigrationTest`, `UemsKennzahlMigrationTest`, `UemsKennzahlNeuGebildetMigrationTest`, `UemsKorrekturErsatzwertMigrationTest`, `UemsKorrekturKaskadeTest`, `UemsKorrekturVorschlaegeTest`, `UemsKostenstelleProzessMigrationTest`, `UemsLeistungsvergleichApiTest`, `UemsLesepfadMengenTest`, `UemsLesepfadTest`, `UemsLoeschwegeApiTest`, `UemsLoeschwegeMigrationTest`, `UemsLueckenMelderTest`, `UemsLueckenZuwachsTest`, `UemsMassnahmeHerkunftMigrationTest`, `UemsMassnahmeMigrationTest`, `UemsMessstelleQuelleMigrationTest`, `UemsMessstelleVerteilungMigrationTest`, `UemsMesswertRohtabelleMigrationTest`, `UemsNetzanschlussMigrationTest`, `UemsOrteMigrationTest`, `UemsPeriodenmengeTest`, `UemsProduktionsreihenfolgeMigrationTest`, `UemsPunktzustandJeKomponenteMigrationTest`, `UemsQuelleAnteilTest`, `UemsQuelleEinstellungMigrationTest`, `UemsQuelleKadenzMigrationTest`, `UemsRichtungspaarLaufTest`, `UemsRollupMehrBoxMigrationTest`, `UemsRuheBisZumStartMigrationTest`, `UemsStandortMigrationTest`, `UemsSummenwertAbnahmeTest`, `UemsTagesmengeNachtragTest`, `UemsVerbesserungFlagArchitekturTest`, `UemsVerbesserungMigrationTest`, `UemsVierAugenFreigabeMigrationTest`, `UemsWetterArchivAbrufTest`, `UemsWetterbezugApiTest`, `UemsZugriffMigrationTest`, `VariablenAbhaengigkeitVectorsTest`, `VariablenVorschlagApiTest`, `VariablenVorschlagSchnittstelleVertragTest`, `VerbesserungNahtTest`, `VerbesserungUebersichtApiTest`, `VerbesserungUebersichtSchnittstelleVertragTest`, `VerbesserungVectorsTest`, `VerbrauchErsatzwertVectorsTest`, `VerbrauchTeilperiodenTest`, `VerbrauchVectorsTest`, `VerbrauchWerteteileTest`, `VerbundAnteileReserveVectorsTest`, `VerbundAnteileUngeregeltVectorsTest`, `VerbundAnteileVectorsTest`, `VerbundBilanzApiTest`, `VerbundBilanzVectorsTest`, `VergleichToleranzApiTest`, `VergleichToleranzSchnittstelleVertragTest`, `VerteilungApiTest`, `VerteilungSchnittstelleVertragTest`, `VerteilungVectorsTest`, `ViertelstundeRegelnTest`, `ViertelstundeWiringTest`, `VorbehaltApiTest`, `VorbehaltVectorsTest`, `VorbehaltViertelstundeLaeuferTest`, `VorgangAnstossApiTest`, `WagoKartenfassungMigrationTest`, `WertVersionenRegelnTest`, `WetterArchivWiringTest`, `WirksameAnteileAusHerzschlagTest`, `ZeilentextAufbewahrungWiringTest`, `ZustandAbleitungVectorsTest`
- `com.voltpilot.api.unterstuetzung` (2): `UnterstuetzungSchnittstelleVertragTest`, `UnterstuetzungWiringTest`
- `com.voltpilot.api.verbraucher` (6): `LadeparkRahmenTest`, `RanglisteAbleitungTest`, `RanglisteProjektionTest`, `SteuerartProjektionTest`, `SteuerartRundlaufTest`, `SteuerartSatzTest`
- `com.voltpilot.api.vorschau` (1): `VorschauTest`
- `com.voltpilot.api.web` (6): `BerichtVorlagenControllerTest`, `ComponentEventsContractTest`, `EdgeRefTest`, `RegistrationRateLimiterTest`, `ScheduleModeTest`, `SiteDetailDtoJsonTest`
- `com.voltpilot.api.zugriff` (13): `AdminBenutzerEntzugApiTest`, `BenutzerVerwaltungApiTest`, `RechtAufruferTest`, `RechtMatrixApiTest`, `RechtRoutenArchitekturTest`, `SelbstauskunftApiTest`, `SelbstauskunftSchnittstelleVertragTest`, `SiteScopeBestandTest`, `TeilansichtSchnittstelleVertragTest`, `ZugriffAenderungArchitekturTest`, `ZugriffBestandWiringTest`, `ZugriffEntzugApiTest`, `ZugriffStichtagTest`

### `services/timescale-writer`: 19 Testklassen ohne Kandidat

- `com.voltpilot.writer` (19): `AblesungHerkunftVectorsTest`, `ComposedEntityFanoutTest`, `DatenannahmeNachrichtenTest`, `DauerlaeuferWriterNahtTest`, `EreignisTabelleImTest`, `EreignisVokabularZwillingTest`, `EventsRawConsumerTest`, `GeteilterPunktConsumerTest`, `K8sReadinessConfigTest`, `KafkaConsumerLagScrapeTest`, `KafkaLagMetricsWiringTest`, `KafkaLagProbeTest`, `KernSpiegelTest`, `MesswertHerkunftZwillingTest`, `PunktzustandBestandTest`, `TelemetryV2RawSeqTest`, `UeberlaufRegelZwillingTest`, `UemsLastprofilWerkzeugTest`, `WriterVerwerfMetrikenTest`

### `services/ingest`: 23 Testklassen ohne Kandidat

- `com.voltpilot.ingest` (21): `BeendeteKundenbereicheTest`, `BoxEreignisTorTest`, `BoxEventsValidatorTest`, `DatenannahmeTest`, `DatenannahmeVektorenTest`, `DauerlaeuferVorlageAnnahmeTest`, `EventsContractSchemaTest`, `EventsTopicAnlageTest`, `EventsTopicPruefungTest`, `IngestMetrikenTest`, `IngestPipeTest`, `K8sReadinessConfigTest`, `MeasurementEdgeProvenanceTest`, `MeasurementIngestAcknowledgementTest`, `MeasurementSamplesContractSchemaTest`, `MeasurementSamplesValidatorTest`, `MesszeitregelTest`, `MetrikEndpunktTest`, `ProbeEndpointsTest`, `TelemetryV2ValidatorTest`, `TelemetryValidatorTest`
- `com.voltpilot.ingest.provisioning` (2): `ProvisioningHandlerTest`, `ProvisioningPipeTest`

### `frontend/portal/e2e`: 95 Specs ohne Kandidat

`abdeckung-messmittel.spec.ts`, `abweichungen.spec.ts`, `admin-flotte.spec.ts`, `anlage-anlegen.spec.ts`, `anlage-umziehen.spec.ts`, `belegschutz.spec.ts`, `benutzer.spec.ts`, `bericht-freigeben.spec.ts`, `berichte.spec.ts`, `betreiberblatt.spec.ts`, `betriebszeit-kennzeichen.spec.ts`, `bewertung-baustein.spec.ts`, `bewertung.spec.ts`, `bewertungsstand.spec.ts`, `bezugsbasis-fassungen.spec.ts`, `bezugsbasis-modell.spec.ts`, `bezugsbasis-vergleich.spec.ts`, `bezugsbasis.spec.ts`, `bezugsgroessen.spec.ts`, `box-updates.spec.ts`, `buehne-vorher-nachher.spec.ts`, `cockpit-rollen.spec.ts`, `controllerwechsel.spec.ts`, `device-edit.spec.ts`, `eigener-messwert.spec.ts`, `energiebilanz.spec.ts`, `energiemanagement-audits.spec.ts`, `energiemanagement-aufgaben.spec.ts`, `energiemanagement-baustein.spec.ts`, `energiemanagement-managementbewertung.spec.ts`, `energiemanagement.spec.ts`, `energieziele.spec.ts`, `erloes-formel.spec.ts`, `erloes-vergleich.spec.ts`, `flaeche-aendern.spec.ts`, `formel-assistent.spec.ts`, `gebaeude-karte.spec.ts`, `gemeinsame-steuerung.spec.ts`, `geraet-herkunft.spec.ts`, `gesamtwert.spec.ts`, `help.spec.ts`, `herkunft-verlauf.spec.ts`, `historie-unplausibel.spec.ts`, `kanalbindung.spec.ts`, `kennzahl-aendern.spec.ts`, `kennzahl-anlegen.spec.ts`, `kennzahlen.spec.ts`, `korrekturen.spec.ts`, `kostenstellen.spec.ts`, `ladegrenze.spec.ts`, `ladepark-box.spec.ts`, `leerzustaende.spec.ts`, `leistungsvergleich.spec.ts`, `massnahme-wirkung.spec.ts`, `massnahmen.spec.ts`, `messen-assistent-einstieg.spec.ts`, `messen-assistent.spec.ts`, `messplanung.spec.ts`, `messstelle-dialog.spec.ts`, `messstelle-seite.spec.ts`, `messstellen.spec.ts`, `mobile-ui.spec.ts`, `nachweise.spec.ts`, `netzanschluesse.spec.ts`, `ocpp-wallbox.spec.ts`, `ort-aenderungen.spec.ts`, `ort-archivieren.spec.ts`, `ort-verschieben.spec.ts`, `ortsbaum.spec.ts`, `portal-rechte.spec.ts`, `quelle-binden.spec.ts`, `shell-layout.spec.ts`, `stand-am.spec.ts`, `standort-ebenen.spec.ts`, `standort-vorschlag.spec.ts`, `standorte.spec.ts`, `startpasswort.spec.ts`, `steuerquelle-gemeinsame-steuerung.spec.ts`, `steuerung-anhalten.spec.ts`, `summenwert-abnahme.spec.ts`, `summenwert-geraet-kontext.spec.ts`, `summenwert-geraetkarte.spec.ts`, `summenwert-hybrid.spec.ts`, `summenwert.spec.ts`, `tageskarte.spec.ts`, `telefonleiste.spec.ts`, `uebersicht.spec.ts`, `unterstuetzung.spec.ts`, `wago-karte.spec.ts`, `weg.spec.ts`, `werte-eingabe.spec.ts`, `wetterbezug.spec.ts`, `zaehlerwechsel.spec.ts`, `ziele-massnahmen-baustein.spec.ts`, `zuordnung-korrigieren.spec.ts`

### `edge-app/nodered/vp-palette`: 16 Mocha-Specs ohne Kandidat

`consumer_policy_spec.js`, `flowc_runtime_spec.js`, `http_read_spec.js`, `limit_guard_spec.js`, `modbus_spec.js`, `mqtt_read_spec.js`, `node_status_spec.js`, `nodes_spec.js`, `private_host_spec.js`, `probe_spec.js`, `register_write_spec.js`, `soc_derive_spec.js`, `switch_spec.js`, `v2_nodes_spec.js`, `wago_kopf_spec.js`, `wago_simulator_spec.js`

