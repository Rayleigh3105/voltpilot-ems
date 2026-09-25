package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.web.dto.HistoryDto;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ConditionEvaluationResult;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Abschluss-Bestandsschutz AP-08 IP-20. Die Verbrauchsbildung liegt neben dem
 * bestehenden Messwertkern: sie darf weder dessen drei Rollup-Prozeduren noch
 * die Historienantwort eines plausiblen Bestandskunden veraendern.
 *
 * <p>Die Prozedur-Fingerabdruecke wurden auf dem Stand vor AP-08
 * ({@code 870b7e5a}) aufgenommen. Einmal bewusst fortgeschrieben:
 * {@code refresh_telemetry_rollups} mit {@code V20260922020000} (AP-15 Folgepunkt
 * {@code vp-uems-v15-folge-leser-je-anlage}) - neuer Zweig NUR fuer Mehr-Box-Anlagen mit
 * bestimmter fuehrender Box, jede andere Anlage rechnet Wort fuer Wort wie vorher; den
 * Zeilenbeweis fuehrt {@code UemsRollupMehrBoxMigrationTest}. Alle drei mit {@code V20260926004700} (AP-20,
 * Rollup-Race): je Stufe nur der Filter auf gesperrt lebende Mandanten. Cockpit und Erloese werden von den bestehenden
 * Bestandsmustern {@code PortalApiTest#overviewAggregatesFleetTenantScopedWithBerlinDaySavings}
 * und {@code PortalApiTest#earningsComputesRealizedSavingsPerSiteWithHonestDegradation}
 * abgedeckt und deshalb hier nicht nachgebaut.
 */
@Testcontainers
@ExtendWith(UemsVerbrauchBestandsschutzTest.DockerPflicht.class)
@SpringBootTest
@ActiveProfiles("local")
class UemsVerbrauchBestandsschutzTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000208");
    private static final Instant ERSTER = Instant.parse("2026-10-01T00:00:00Z");
    private static final Instant ZWEITER = Instant.parse("2026-10-02T00:00:00Z");

    // V20260926004700 (AP-20 Folge zu IP-18, Rollup-Race; vorher je Prozedur in Klammern): alle drei
    // woertlich plus je Stufe EINE Filterzeile tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED);
    // fuer jeden lebenden Mandanten Zeile fuer Zeile gleich (jede Gruppe enthaelt tenant_id), dieser Test und
    // die Leser oben bleiben gruen; den Race-Beweis fuehrt LoeschzugRollupNachlaeuferApiTest.
    private static final Map<String, String> ROLLUP_FINGERABDRUECKE = Map.of(
            // V20260922236000 (vorher 6290471ab9cd23b33415e31b97731c1d14a81aa7c4966083561b83e2ac4b492a):
            // die Verdichtung aus V20260853000000 woertlich plus EINE Filterbedingung
            // AND edge_entity_id IS NULL; jede Bestandszeile traegt NULL, die Buckets sind
            // Zeile fuer Zeile gleich (UemsGeteilterPunktBoxSchluesselMigrationTest).
            // V20260926004700 (vorher 174759bad2eea4bbb2d83f124b6cce6fb4b0898323e7683deed7febf4356db20).
            "refresh_device_measurement_rollup",
            "b6c7938ba1f187b645c17c59a74adbe6c7fa746b7f50fdedd3f7ae1086697432",
            // V20260922020000 (vorher 89c6795528f28718173c57613646e8251b70e32dd7d21cc486f316a44bad9cd4),
            // V20260922170000 (vorher e3c35a4157b245227daaa65a4dd92b94dc9b9d34e0ea9f96574f60dd4bec3945):
            // die 15m-Stufe liest telemetry_anlage_15m, Werte Zeile fuer Zeile gleich
            // (UemsAnlageLeserMigrationTest).
            // V20260926004700 (vorher 1a9e79a5c575a5e0602a49cb2b5a8a12a23007be436a3c3c07fa63932bc7e2f8).
            "refresh_telemetry_rollups",
            "2092a4d3c0b698759e0ced94c5352e16cb67c8d86cd0a78a6cb670a00ceacc71",
            // V20260926004700 (vorher 906ae662ee2e974c2b6822cda07e5dedc4f072990b0b5e28f771397d3569485c).
            "refresh_telemetry_v2_rollups",
            "72712bb7d25a5bbc66649cedbefdcefd1ed11948e9cc17f49f2f54289117a0ba");

    private static final String HISTORIE_SNAPSHOT = "{\"range\":\"month\","
            + "\"from\":\"2026-09-30T22:00:00Z\",\"to\":\"2026-10-31T23:00:00Z\",\"bucketMinutes\":1440,"
            + "\"buckets\":[{\"start\":\"2026-10-01T00:00:00Z\",\"pvKwh\":4,\"loadKwh\":5,"
            + "\"gridImportKwh\":3,\"gridExportKwh\":1,\"batteryChargeKwh\":null,"
            + "\"batteryDischargeKwh\":null,\"socMinPct\":null,\"socMaxPct\":null,\"socLastPct\":null,"
            + "\"priceEurMwh\":null,\"costEur\":0.30},{\"start\":\"2026-10-02T00:00:00Z\",\"pvKwh\":4,"
            + "\"loadKwh\":5,\"gridImportKwh\":1,\"gridExportKwh\":1,\"batteryChargeKwh\":null,"
            + "\"batteryDischargeKwh\":null,\"socMinPct\":null,\"socMaxPct\":null,\"socLastPct\":null,"
            + "\"priceEurMwh\":null,\"costEur\":null}],\"totals\":{\"consumptionKwh\":10.000,"
            + "\"pvGenerationKwh\":8.000,\"gridImportKwh\":4.000,\"gridExportKwh\":2.000,"
            + "\"gridCostEur\":0.3000,\"tarifArt\":\"fest\",\"tarifPriced\":true,"
            + "\"batterySavingsPlannedEur\":null,\"batterySavingsEur\":null,\"steuerungPlannedEur\":null,"
            + "\"autarkiePct\":60.0,\"eigenverbrauchPct\":75.0,\"autarkieUnplausibel\":false,"
            + "\"eigenverbrauchUnplausibel\":false},\"protocol\":[],\"plan\":[],\"coverage\":null,\"events\":[]}";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "false");
    }

    @Autowired
    ObjectMapper json;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @Test
    void dieDreiRollupProzedurenSindSeitVorAp08Unveraendert() throws Exception {
        Map<String, String> ist = root.query("SELECT p.proname, "
                + "pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                + "WHERE n.nspname = 'public' AND p.proname IN "
                + "('refresh_telemetry_rollups', 'refresh_telemetry_v2_rollups', "
                + "'refresh_device_measurement_rollup')",
                rs -> {
                    java.util.TreeMap<String, String> aus = new java.util.TreeMap<>();
                    while (rs.next()) {
                        aus.put(rs.getString(1), sha256(rs.getString(2)));
                    }
                    return aus;
                });

        assertThat(ist).containsExactlyInAnyOrderEntriesOf(ROLLUP_FINGERABDRUECKE);
    }

    @Test
    void plausibleHistorienAntwortBleibtMitDemAp10SchalterByteGleich() throws Exception {
        HistoryRepository repo = mock(HistoryRepository.class);
        OptimizerDiagnosticsService diagnostics = mock(OptimizerDiagnosticsService.class);
        List<HistoryBucketDto> werte = List.of(
                bucket(ERSTER, "4", "5", "3", "1"),
                bucket(ZWEITER, "4", "5", "1", "1"));

        when(repo.v2HistoryCutover(SITE)).thenReturn(null);
        when(repo.rollupBuckets(eq(SITE), any(), any(), eq(true))).thenReturn(werte);
        when(repo.costPerBucket(eq(SITE), any(), any(), eq("DE-LU"), eq(true)))
                .thenReturn(Map.of(ERSTER, new BigDecimal("0.30")));
        when(repo.plannedSavings(eq(SITE), any(), any()))
                .thenReturn(new HistoryRepository.PlannedSavings(null, null));
        when(repo.tariffContext(SITE)).thenReturn(new HistoryRepository.TariffContext("fest", true));
        when(repo.negativePriceSlots(eq("DE-LU"), any(), any())).thenReturn(List.of());
        when(repo.curtailSlots(eq(SITE), any(), any())).thenReturn(List.of());
        when(repo.gridChargeSlots(eq(SITE), any(), any())).thenReturn(List.of());
        when(repo.dataGaps(eq(SITE), any(), any())).thenReturn(List.of());
        when(repo.coverage(eq(SITE), any(), any())).thenReturn(null);

        HistoryDto ungeklemmt = new HistoryService(repo, diagnostics, true)
                .history(SITE, "DE-LU", HistoryRange.MONTH, LocalDate.parse("2026-10-15"));
        HistoryDto rueckbau = new HistoryService(repo, diagnostics, false)
                .history(SITE, "DE-LU", HistoryRange.MONTH, LocalDate.parse("2026-10-15"));
        byte[] snapshot = json.writeValueAsBytes(ungeklemmt);

        assertThat(snapshot).as("plausible Werte sind mit AP-10-Schalter an/aus identisch")
                .containsExactly(json.writeValueAsBytes(rueckbau));
        assertThat(new String(snapshot, StandardCharsets.UTF_8)).isEqualTo(HISTORIE_SNAPSHOT);
    }

    private static HistoryBucketDto bucket(Instant zeit, String pv, String last, String bezug, String abgabe) {
        return new HistoryBucketDto(zeit, new BigDecimal(pv), new BigDecimal(last), new BigDecimal(bezug),
                new BigDecimal(abgabe), null, null, null, null, null, null, null);
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("JDK ohne SHA-256", e);
        }
    }

    /** Ohne Docker ist der Abschlussnachweis nicht gruen, sondern nachweislich nicht gelaufen. */
    static final class DockerPflicht implements ExecutionCondition {
        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
            if (DockerClientFactory.instance().isDockerAvailable()) {
                return ConditionEvaluationResult.enabled("Docker ist da — der AP-08-Bestandsschutz laeuft");
            }
            String satz = "UEBERSPRUNGEN: " + context.getDisplayName()
                    + " — UEMS AP-08 IP-20 ist NICHT gelaufen, weil Docker fehlt.";
            System.err.println(satz);
            return ConditionEvaluationResult.disabled(satz);
        }
    }
}
