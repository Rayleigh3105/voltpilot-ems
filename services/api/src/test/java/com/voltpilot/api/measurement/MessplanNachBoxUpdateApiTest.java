package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionService.Actor;
import com.voltpilot.api.measurement.MeasurementSelectionService.Change;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ErwarteteKadenz;
import java.sql.Connection;
import java.sql.Statement;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Update-Pfad des Messplans (Generalprobe 23.09.2026, B2): eine Box, deren Auswahl unter dem alten
 * Katalogstand angewandt ist, bekommt das Box-Release. Der Core spielt beim Neustart die gespeicherte
 * Konfiguration alten Stands wieder ein, die neue Palette lehnt sie mit {@code unsupported_catalog} ab
 * ({@code measurement-planner.js}), und diese Ablehnung zählt als Quittung. Vorher blieb die Box ohne Plan,
 * bis jemand ihre Auswahl änderte; jetzt liefert der {@link MeasurementConfigReconciler} den Plan im
 * heutigen Stand als neue Revision nach - einmal, ohne Schleife.
 *
 * <p>Echt sind Auswahl, Quittung ({@link MeasurementConfigStatusListener#handle}), Reconciler und das
 * zugestellte Dokument ({@link ZustellungOhneBroker}); nur der Broker fehlt (der Publisher ist ein Mock,
 * der mitschreibt). Die Box-Hälfte - Neustart mit gespeichertem Plan alten Stands, danach die nächste
 * Revision im eigenen Stand - belegt {@code edge-app/nodered/measurements/measurement-runtime.test.js}
 * („update path …“). Tor-Punkt GA/NW-3u ({@code tools/freigabe/pruefe_tor.py}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@ActiveProfiles("local")
class MessplanNachBoxUpdateApiTest {

    /** Der Stand, unter dem die Bestandsboxen ihre Auswahl angewandt haben (Feld-Release edge-2026.09.4). */
    private static final String ALTER_STAND = "2026.08.26.3";
    private static final String POINT = "deye.hybrid_1p.battery.battery-current";
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> "voltpilot_app");
        registry.add("spring.datasource.password", () -> "voltpilot_app_test_pw");
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        registry.add("spring.flyway.placeholders.appDbPassword", () -> "voltpilot_app_test_pw");
        registry.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MeasurementSelectionService selections;

    @Autowired
    MeasurementSelectionRepository repository;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

    @Autowired
    ErwarteteKadenz kadenzen;

    private final MeasurementConfigPublisher publisher = mock(MeasurementConfigPublisher.class);

    @Test
    void nachDemBoxUpdateLiefertDieCloudDenPlanImHeutigenStandNachUndDieBoxMisst() throws Exception {
        Box box = box("b2-update", "b1", "d0", "d1");
        String heute = selections.katalogstand();
        assertThat(heute).as("die Probe braucht einen Standwechsel").isNotEqualTo(ALTER_STAND);
        box.waehle(30);
        box.unterAltemStand();
        MeasurementConfigReconciler reconciler = new MeasurementConfigReconciler(adminJdbc, selections, publisher);

        // Vor dem Update: die alte Box wendet Revision 1 an. Nichts offen, nichts wird nachgeliefert.
        assertThat(box.quittung(1, true)).isTrue();
        reconciler.reconcile();
        verify(publisher, never()).publish(any(), any());
        assertThat(box.revision()).as("Bestand: angewandte Box ohne Wechsel").isEqualTo(1);
        assertThat(box.zeile()).isEqualTo("applied");

        // Das Update: der Core spielt den gespeicherten Plan (alter Stand) wieder ein, die neue Palette lehnt ab.
        assertThat(box.quittung(1, false)).as("die Ablehnung derselben Revision ist eine gültige Quittung").isTrue();
        assertThat(box.zeile()).isEqualTo("rejected:unsupported_catalog");
        assertThat(box.revision()).isEqualTo(1);

        // Die Cloud liefert nach: Revision 2 im heutigen Stand, im selben Durchlauf zugestellt.
        reconciler.reconcile();
        assertThat(box.revision()).as("Nachlieferung nach dem Box-Update").isEqualTo(2);
        ArgumentCaptor<State> zugestellt = ArgumentCaptor.forClass(State.class);
        verify(publisher).publish(eq(box.scope()), zugestellt.capture());
        assertThat(zugestellt.getValue().desiredRevision()).isEqualTo(2);
        assertThat(zugestellt.getValue().catalogVersion()).isEqualTo(heute);
        assertThat(zugestellt.getValue().selections()).singleElement().satisfies(p -> {
            assertThat(p.pointKey()).isEqualTo(POINT);
            assertThat(p.enabled()).isTrue();
            assertThat(p.cadenceS()).isEqualTo(30);
        });
        JsonNode dokument = MAPPER.readTree(ZustellungOhneBroker.dokument(repository, selections, kadenzen,
                MAPPER, TENANT, box.device()));
        assertThat(dokument.path("revision").asLong()).isEqualTo(2);
        assertThat(dokument.path("catalog_version").asText()).isEqualTo(heute);
        assertThat(dokument.path("selections")).hasSize(1);
        assertThat(box.katalogstandDerRevision(2)).isEqualTo(heute);
        assertThat(box.katalogstandDerRevision(1)).isEqualTo(ALTER_STAND);
        assertThat(adminJdbc.queryForObject("SELECT actor FROM device_measurement_selection_event "
                + "WHERE device_id=? AND desired_revision=2 AND event_kind='selection_requested'", String.class,
                box.device())).isEqualTo(MeasurementSelectionService.KATALOGSTAND_AKTEUR);
        assertThat(adminJdbc.queryForObject("SELECT catalog_version FROM device_measurement_selection "
                + "WHERE device_id=?", String.class, box.device()))
                .as("keine Auswahlzeile ändert sich").isEqualTo(ALTER_STAND);

        // Idempotent: solange Revision 2 offen ist, entsteht keine weitere.
        reconciler.reconcile();
        assertThat(box.revision()).isEqualTo(2);

        // Die Box wendet Revision 2 an und misst wieder.
        assertThat(box.quittung(2, true)).isTrue();
        assertThat(box.zeile()).isEqualTo("applied");
        TenantContext.set(TENANT);
        try {
            assertThat(selections.state(box.device()).status()).isEqualTo("applied");
        } finally {
            TenantContext.clear();
        }
        clearInvocations(publisher);
        reconciler.reconcile();
        verify(publisher, never()).publish(any(), any());
        assertThat(box.revision()).isEqualTo(2);

        // Die gehaltene Ablehnung von Revision 1 kommt nach einem api-Neustart noch einmal: sie ist veraltet.
        assertThat(box.quittung(1, false)).isFalse();
        assertThat(box.zeile()).isEqualTo("applied");
    }

    @Test
    void eineAblehnungDesHeutigenStandsLoestNichtsAusAuchNichtNachEinerNachlieferung() throws Exception {
        MeasurementConfigReconciler reconciler = new MeasurementConfigReconciler(adminJdbc, selections, publisher);

        // Box OHNE Update gegen die neue Cloud: sie lehnt einen Plan im heutigen Stand ab. Das bleibt so.
        Box ohneUpdate = box("b2-ohne-update", "b2", "d2", "d3");
        ohneUpdate.waehle(30);
        assertThat(ohneUpdate.quittung(1, false)).isTrue();
        for (int i = 0; i < 3; i++) reconciler.reconcile();
        assertThat(ohneUpdate.revision()).isEqualTo(1);

        // Alter Stand abgelehnt, aber die Box kann auch den heutigen nicht: genau eine Nachlieferung, dann Ruhe.
        Box zweimal = box("b2-zweimal", "b3", "d4", "d5");
        zweimal.waehle(60);
        zweimal.unterAltemStand();
        assertThat(zweimal.quittung(1, false)).isTrue();
        reconciler.reconcile();
        assertThat(zweimal.revision()).isEqualTo(2);
        assertThat(zweimal.quittung(2, false)).isTrue();
        for (int i = 0; i < 3; i++) reconciler.reconcile();
        assertThat(zweimal.revision()).as("keine Schleife").isEqualTo(2);

        // Ein anderer Ablehnungsgrund bei altem Stand ist kein Katalogstand-Befund.
        Box budget = box("b2-budget", "b4", "d6", "d7");
        budget.waehle(30);
        budget.unterAltemStand();
        assertThat(budget.quittung(1, "budget_samples")).isTrue();
        reconciler.reconcile();
        assertThat(budget.revision()).isEqualTo(1);
        assertThat(ohneUpdate.revision()).isEqualTo(1);
    }

    private Box box(String ref, String siteSuffix, String deviceSuffix, String entitySuffix) throws Exception {
        UUID site = UUID.fromString("00000000-0000-0000-0000-0000000000" + siteSuffix);
        UUID device = UUID.fromString("00000000-0000-0000-0000-0000000000" + deviceSuffix);
        UUID entity = UUID.fromString("00000000-0000-0000-0000-0000000000" + entitySuffix);
        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO site(id,tenant_id,name,bidding_zone) VALUES ('" + site + "','" + TENANT
                    + "','B2 " + ref + "','DE-LU') ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO device(id,tenant_id,site_id,external_ref,kind,status) VALUES ('" + device
                    + "','" + TENANT + "','" + site + "','" + ref + "','inverter','claimed') ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,label,family) VALUES ('"
                    + entity + "','" + TENANT + "','" + site + "','pv-inverter','Hybrid','hybrid_1p') "
                    + "ON CONFLICT DO NOTHING");
        }
        return new Box(site, device, entity);
    }

    private final class Box {
        private final UUID site;
        private final UUID device;
        private final UUID entity;

        Box(UUID site, UUID device, UUID entity) {
            this.site = site;
            this.device = device;
            this.entity = entity;
        }

        UUID device() {
            return device;
        }

        DeviceScope scope() {
            return new DeviceScope(TENANT, site, device);
        }

        void waehle(int cadenceS) {
            TenantContext.set(TENANT);
            try {
                selections.change(device, entity, POINT, new Change(0, UUID.randomUUID(), true, cadenceS),
                        new Actor("test:b2", "B2-Probe"));
            } finally {
                TenantContext.clear();
            }
        }

        /** Gewählt, als die api noch den alten Stand auslieferte: Zeile und Ereignis tragen ihn. */
        void unterAltemStand() throws Exception {
            try (Connection connection = POSTGRES.createConnection("");
                    Statement statement = connection.createStatement()) {
                statement.execute("UPDATE device_measurement_selection SET catalog_version='" + ALTER_STAND
                        + "' WHERE device_id='" + device + "'");
                statement.execute("UPDATE device_measurement_selection_event SET catalog_version='" + ALTER_STAND
                        + "' WHERE device_id='" + device + "'");
            }
        }

        boolean quittung(long revision, boolean angewandt) {
            return quittung(revision, angewandt ? null : "unsupported_catalog");
        }

        /** Die Quittung, wie der Core sie aus dem Status der Palette baut ({@code WrapStatus}). */
        boolean quittung(long revision, String ablehnung) {
            String topic = "ems/" + TENANT + "/" + site + "/" + device + "/v2/measurement-config-status";
            String status = "{\"schema_version\":\"2.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + site
                    + "\",\"device_id\":\"" + device + "\",\"revision\":" + revision
                    + ",\"applied_at\":\"2026-09-23T12:0" + revision + ":00Z\","
                    + (ablehnung == null
                            ? "\"accepted\":[\"" + POINT + "\"],\"rejected\":[]"
                            : "\"accepted\":[],\"rejected\":[{\"point_key\":\"" + POINT + "\",\"reason\":\""
                                    + ablehnung + "\"}]")
                    + ",\"edge_version\":\"edge-b2\"}";
            return new MeasurementConfigStatusListener("tcp://127.0.0.1:9", "", "", repository, MAPPER)
                    .handle(topic, status.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }

        long revision() {
            TenantContext.set(TENANT);
            try {
                return repository.revision(device);
            } finally {
                TenantContext.clear();
            }
        }

        String katalogstandDerRevision(long revision) {
            TenantContext.set(TENANT);
            try {
                return repository.katalogstandDerRevision(device, revision);
            } finally {
                TenantContext.clear();
            }
        }

        String zeile() {
            return adminJdbc.queryForObject("SELECT apply_status || CASE WHEN apply_status='rejected' "
                    + "THEN ':' || apply_reason ELSE '' END FROM device_measurement_selection WHERE device_id=?",
                    String.class, device);
        }
    }
}
