package com.voltpilot.api.ocpp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.OcppActionDto;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.postgresql.ds.PGSimpleDataSource;

@Testcontainers(disabledWithoutDocker = true)
class OcppActionRepositoryTest {
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>(DockerImageName
            .parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @BeforeAll static void migrate() throws Exception {
        Flyway.configure().dataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser","voltpilot_app","appDbPassword","action_pw",
                        "adminDbUser","voltpilot_admin","adminDbPassword","admin_pw")).load().migrate();
        try (Connection c = DriverManager.getConnection(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword()); Statement s = c.createStatement()) {
            s.executeUpdate("INSERT INTO ocpp_station(device_id,charge_point_id,tenant_id,site_id,connected,last_seen,updated_at) VALUES "
                    + "('"+DEVICE+"','CP-A','"+TENANT+"','"+SITE+"',true,now(),now()),"
                    + "('"+DEVICE+"','CP-B','"+TENANT+"','"+SITE+"',true,now(),now()) ON CONFLICT DO NOTHING");
        }
    }

    @Test void exactEffectCorrelationRejectsCrossConnectorAndCrossTargetTraffic() throws Exception {
        try (Harness h = harness()) {
            UUID id = insert(h, "CP-A", "RemoteStartTransaction", "RemoteStartTransaction", 1, null,
                    MAPPER.readTree("{\"connectorId\":1,\"idTag\":\"secret\"}"), Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "RemoteStartTransaction", "ocpp-"+id, "{\"status\":\"Accepted\"}");
            evidence(h, "CP-B", "Call", "StartTransaction", null, "{\"connectorId\":1,\"transactionId\":9,\"idTag\":\"secret\"}");
            evidence(h, "CP-A", "Call", "StartTransaction", null, "{\"connectorId\":2,\"transactionId\":9,\"idTag\":\"secret\"}");
            assertThat(h.repo.byId(id).orElseThrow().state()).isEqualTo("accepted_waiting_effect");
            evidence(h, "CP-A", "Call", "StartTransaction", null, "{\"connectorId\":1,\"transactionId\":9,\"idTag\":\"secret\"}");
            assertThat(h.repo.byId(id).orElseThrow().state()).isEqualTo("effect_observed");

            UUID stop = insert(h, "CP-A", "RemoteStopTransaction", "RemoteStopTransaction", null, 9,
                    MAPPER.readTree("{\"transactionId\":9}"), Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "RemoteStopTransaction", "ocpp-" + stop,
                    "{\"status\":\"Accepted\"}");
            evidence(h, "CP-A", "Call", "StopTransaction", null,
                    "{\"transactionId\":10,\"meterStop\":1,\"timestamp\":\"2026-08-25T00:00:00Z\"}");
            assertThat(h.repo.byId(stop).orElseThrow().state()).isEqualTo("accepted_waiting_effect");
            evidence(h, "CP-A", "Call", "StopTransaction", null,
                    "{\"transactionId\":9,\"meterStop\":1,\"timestamp\":\"2026-08-25T00:00:01Z\"}");
            assertThat(h.repo.byId(stop).orElseThrow().state()).isEqualTo("effect_observed");
        }
    }

    @Test void intermediateAndUnrelatedStationTrafficNeverBecomesTerminalEvidence() throws Exception {
        try (Harness h = harness()) {
            UUID diagnostics = insert(h, "CP-A", "GetDiagnostics", "GetDiagnostics", null, null,
                    MAPPER.createObjectNode(), Instant.now().plusSeconds(60));
            evidence(h, "CP-A", "CallResult", "GetDiagnostics", "ocpp-" + diagnostics, "{}");
            evidence(h, "CP-A", "Call", "DiagnosticsStatusNotification", null,
                    "{\"status\":\"Uploading\"}");
            assertThat(h.repo.byId(diagnostics).orElseThrow().state()).isEqualTo("accepted_waiting_effect");
            evidence(h, "CP-A", "Call", "DiagnosticsStatusNotification", null,
                    "{\"status\":\"Uploaded\"}");
            assertThat(h.repo.byId(diagnostics).orElseThrow().state()).isEqualTo("effect_observed");

            UUID firmware = insert(h, "CP-B", "UpdateFirmware", "UpdateFirmware", null, null,
                    MAPPER.createObjectNode(), Instant.now().plusSeconds(60));
            evidence(h, "CP-B", "CallResult", "UpdateFirmware", "ocpp-" + firmware, "{}");
            evidence(h, "CP-B", "Call", "FirmwareStatusNotification", null,
                    "{\"status\":\"Downloaded\"}");
            assertThat(h.repo.byId(firmware).orElseThrow().state()).isEqualTo("accepted_waiting_effect");
            evidence(h, "CP-B", "Call", "FirmwareStatusNotification", null,
                    "{\"status\":\"InstallationFailed\"}");
            assertThat(h.repo.byId(firmware).orElseThrow().state()).isEqualTo("effect_failed");

            UUID trigger = insert(h, "CP-A", "TriggerMessage", "TriggerMessage", null, null,
                    MAPPER.readTree("{\"requestedMessage\":\"Heartbeat\"}"), Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "TriggerMessage", "ocpp-" + trigger,
                    "{\"status\":\"Accepted\"}");
            evidence(h, "CP-A", "Call", "StatusNotification", null,
                    "{\"connectorId\":1,\"status\":\"Available\"}");
            assertThat(h.repo.byId(trigger).orElseThrow().state()).isEqualTo("accepted_waiting_effect");
            evidence(h, "CP-A", "Call", "Heartbeat", null, "{}");
            assertThat(h.repo.byId(trigger).orElseThrow().state()).isEqualTo("effect_observed");
        }
    }

    @Test void terminalStatusesLateResultsCancellationAndResetExclusionAreHonest() throws Exception {
        try (Harness h = harness()) {
            UUID unsupported = insert(h, "CP-A", "UnlockConnector", "UnlockConnector", 1, null,
                    MAPPER.readTree("{\"connectorId\":1}"), Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "UnlockConnector", "ocpp-"+unsupported, "{\"status\":\"NotSupported\"}");
            assertThat(h.repo.byId(unsupported).orElseThrow().state()).isEqualTo("rejected");

            UUID immediate = insert(h, "CP-A", "ClearCache", "ClearCache", null, null,
                    MAPPER.createObjectNode(), Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "GetConfiguration", "ocpp-"+immediate, "{}");
            assertThat(h.repo.byId(immediate).orElseThrow().state()).isEqualTo("prepared");
            var wrongWire = MAPPER.createObjectNode(); wrongWire.put("message_type", "CallResult");
            wrongWire.put("direction", "station_to_csms"); wrongWire.put("action", "ClearCache");
            wrongWire.put("correlation_id", "ocpp-" + immediate);
            wrongWire.put("wire_id", UUID.randomUUID().toString());
            wrongWire.put("occurred_at", Instant.now().toString());
            wrongWire.set("payload", MAPPER.readTree("{\"status\":\"Accepted\"}"));
            h.tx.executeWithoutResult(x -> h.repo.applyProtocolEvidence(TENANT, DEVICE, "CP-A", wrongWire));
            assertThat(h.repo.byId(immediate).orElseThrow().state()).isEqualTo("prepared");
            evidence(h, "CP-A", "CallResult", "ClearCache", "ocpp-"+immediate, "{\"status\":\"Accepted\"}");
            assertThat(h.repo.byId(immediate).orElseThrow().state()).isEqualTo("completed");

            UUID malformed = insert(h, "CP-A", "DataTransfer", "DataTransfer", null, null,
                    MAPPER.createObjectNode(), Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "DataTransfer", "ocpp-" + malformed, "{}");
            assertThat(h.repo.byId(malformed).orElseThrow().state()).isEqualTo("call_error");

            UUID late = insert(h, "CP-B", "ClearCache", "ClearCache", null, null,
                    MAPPER.createObjectNode(), Instant.now().minusSeconds(1));
            h.tx.executeWithoutResult(x -> h.repo.transition(late, TENANT, "system", "sent", null, Instant.now().minusSeconds(2), "sent"));
            h.tx.executeWithoutResult(x -> h.repo.expire(Instant.now()));
            evidence(h, "CP-B", "CallResult", "ClearCache", "ocpp-"+late, "{\"status\":\"Accepted\"}");
            var lateAction = h.repo.byId(late).orElseThrow();
            assertThat(lateAction.state()).isEqualTo("timed_out");
            assertThat(lateAction.reason()).contains("Spätes OCPP-Ergebnis");
            assertThat(h.repo.audit(SITE, late).stream().map(OcppActionDto.Audit::state)).contains("late_response");
            assertThat(h.repo.cancel(late, TENANT, "operator", Instant.now())).isFalse();

            insert(h, "CP-A", "SoftReset", "Reset", null, null, MAPPER.createObjectNode(), Instant.now().plusSeconds(30));
            assertThatThrownBy(() -> insert(h, "CP-A", "HardReset", "Reset", null, null,
                    MAPPER.createObjectNode(), Instant.now().plusSeconds(30))).isInstanceOf(DuplicateKeyException.class);
        }
    }

    @Test void fastResponseAndCancellationCannotBeRegressedByLateSentTransition() throws Exception {
        try (Harness h = harness()) {
            UUID fast = insert(h, "CP-A", "GetConfiguration", "GetConfiguration", null, null,
                    MAPPER.createObjectNode(), Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "GetConfiguration", "ocpp-"+fast,
                    "{\"configurationKey\":[],\"unknownKey\":[]}");
            h.tx.executeWithoutResult(x -> h.repo.transition(fast, TENANT, "system", "sent", null, Instant.now(), "sent"));
            assertThat(h.repo.byId(fast).orElseThrow().state()).isEqualTo("completed");

            UUID cancelled = insert(h, "CP-B", "GetConfiguration", "GetConfiguration", null, null,
                    MAPPER.createObjectNode(), Instant.now().plusSeconds(30));
            assertThat(h.repo.cancel(cancelled, TENANT, "operator", Instant.now())).isTrue();
            h.tx.executeWithoutResult(x -> h.repo.transition(cancelled, TENANT, "system", "sent", null, Instant.now(), "sent"));
            assertThat(h.repo.byId(cancelled).orElseThrow().state()).isEqualTo("cancelled");

            UUID crashedPrepared = insert(h, "CP-B", "ClearCache", "ClearCache", null, null,
                    MAPPER.createObjectNode(), Instant.now().minusSeconds(1));
            h.tx.executeWithoutResult(x -> h.repo.expire(Instant.now()));
            assertThat(h.repo.byId(crashedPrepared).orElseThrow().state()).isEqualTo("transport_failed");
        }
    }

    @Test void schedulerExpiresPreparedRowsWithoutARequestTenantAndAuditsAtomically() throws Exception {
        UUID id;
        try (Harness h = harness()) {
            id = insert(h, "CP-B", "DataTransfer", "scheduler-expiry-" + UUID.randomUUID(), null, null,
                    MAPPER.createObjectNode(), Instant.now().minusSeconds(1));
        }
        PGSimpleDataSource base = new PGSimpleDataSource(); base.setUrl(DB.getJdbcUrl());
        base.setUser("voltpilot_app"); base.setPassword("action_pw");
        new OcppActionRepository(new JdbcTemplate(base), MAPPER).expire(Instant.now());
        try (Harness h = harness()) {
            assertThat(h.repo.byId(id).orElseThrow().state()).isEqualTo("transport_failed");
            assertThat(h.repo.audit(SITE, id).stream().map(OcppActionDto.Audit::state))
                    .containsExactly("prepared", "transport_failed");
        }
    }

    @Test void configurationMutationCompletesOnlyAfterMatchingReadback() throws Exception {
        try (Harness h = harness()) {
            UUID id = insert(h, "CP-A", "ChangeConfiguration", "ChangeConfiguration", null, null,
                    MAPPER.readTree("{\"key\":\"HeartbeatInterval\",\"value\":\"300\"}"), Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "ChangeConfiguration", "ocpp-"+id, "{\"status\":\"Accepted\"}");
            evidence(h, "CP-A", "CallResult", "GetConfiguration", "readback-other",
                    "{\"configurationKey\":[{\"key\":\"HeartbeatInterval\",\"value\":\"120\"}]}");
            assertThat(h.repo.byId(id).orElseThrow().state()).isEqualTo("accepted_waiting_effect");
            evidence(h, "CP-A", "CallResult", "GetConfiguration", "readback-ocpp-"+id,
                    "{\"configurationKey\":[{\"key\":\"HeartbeatInterval\",\"value\":\"300\"}]}");
            assertThat(h.repo.byId(id).orElseThrow().state()).isEqualTo("effect_observed");

            UUID profile = insert(h, "CP-A", "SetChargingProfile", "ChargingProfileMutation", 1, null,
                    MAPPER.readTree("{\"connectorId\":1,\"csChargingProfiles\":{\"chargingSchedule\":{\"chargingRateUnit\":\"W\"}}}"),
                    Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "SetChargingProfile", "ocpp-" + profile,
                    "{\"status\":\"Accepted\"}");
            evidence(h, "CP-A", "CallResult", "GetCompositeSchedule", "readback-ocpp-" + profile,
                    "{\"status\":\"Accepted\",\"connectorId\":2,\"chargingSchedule\":{\"chargingRateUnit\":\"W\"}}");
            assertThat(h.repo.byId(profile).orElseThrow().state()).isEqualTo("effect_failed");

            UUID matchingProfile = insert(h, "CP-A", "SetChargingProfile", "ChargingProfileMutation", 1, null,
                    MAPPER.readTree("{\"connectorId\":1,\"csChargingProfiles\":{\"chargingSchedule\":{\"chargingRateUnit\":\"W\"}}}"),
                    Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "SetChargingProfile", "ocpp-" + matchingProfile,
                    "{\"status\":\"Accepted\"}");
            evidence(h, "CP-A", "CallResult", "GetCompositeSchedule", "readback-ocpp-" + matchingProfile,
                    "{\"status\":\"Accepted\",\"connectorId\":1,\"chargingSchedule\":{\"chargingRateUnit\":\"W\"}}");
            assertThat(h.repo.byId(matchingProfile).orElseThrow().state()).isEqualTo("effect_observed");
        }
    }

    @Test void availabilityRequiresAnExactConnectorStateTransitionNotPeriodicNoise() throws Exception {
        try (Harness h = harness()) {
            Instant base = Instant.now();
            connectorStatus(h, "CP-A", 1, "Unavailable", base.minusSeconds(30));
            UUID id = insert(h, "CP-A", "ChangeAvailability", "ChangeAvailability", 1, null,
                    MAPPER.readTree("{\"connectorId\":1,\"type\":\"Inoperative\"}"), base.plusSeconds(30));
            evidenceAt(h, "CP-A", "CallResult", "ChangeAvailability", "ocpp-"+id,
                    "{\"status\":\"Accepted\"}", base);
            evidenceAt(h, "CP-A", "Call", "StatusNotification", null,
                    "{\"connectorId\":1,\"status\":\"Unavailable\"}", base.plusSeconds(1));
            assertThat(h.repo.byId(id).orElseThrow().state()).isEqualTo("accepted_waiting_effect");

            connectorStatus(h, "CP-A", 1, "Available", base.plusSeconds(2));
            evidenceAt(h, "CP-A", "Call", "StatusNotification", null,
                    "{\"connectorId\":1,\"status\":\"Unavailable\"}", base.plusSeconds(3));
            assertThat(h.repo.byId(id).orElseThrow().state()).isEqualTo("effect_observed");
        }
    }

    @Test void highRiskIntentIsBoundToActorPayloadAndFourEyes() throws Exception {
        try (Harness h = harness()) {
            var intent = h.repo.insertIntent(TENANT, SITE, DEVICE, "CP-A", "UpdateFirmware", "CHALLENGE",
                    "approver-a", "hash-a", null, null, true, Instant.now().plusSeconds(60));
            assertThat(h.repo.consumeIntent(intent.id(), TENANT, SITE, DEVICE, "CP-B", "UpdateFirmware",
                    "hash-a", null, null, true, "CHALLENGE", "operator-b", Instant.now())).isFalse();
            assertThat(h.repo.consumeIntent(intent.id(), TENANT, SITE, DEVICE, "CP-A", "UpdateFirmware",
                    "hash-b", null, null, true, "CHALLENGE", "operator-b", Instant.now())).isFalse();
            assertThat(h.repo.consumeIntent(intent.id(), TENANT, SITE, DEVICE, "CP-A", "UpdateFirmware",
                    "hash-a", null, null, true, "CHALLENGE", "approver-a", Instant.now())).isFalse();
            assertThat(h.repo.consumeIntent(intent.id(), TENANT, SITE, DEVICE, "CP-A", "UpdateFirmware",
                    "hash-a", null, null, false, "CHALLENGE", "operator-b", Instant.now())).isFalse();
            assertThat(h.repo.consumeIntent(intent.id(), TENANT, SITE, DEVICE, "CP-A", "UpdateFirmware",
                    "hash-a", null, null, true, "CHALLENGE", "operator-b", Instant.now())).isTrue();
            assertThat(h.repo.consumeIntent(intent.id(), TENANT, SITE, DEVICE, "CP-A", "UpdateFirmware",
                    "hash-a", null, null, true, "CHALLENGE", "operator-c", Instant.now())).isFalse();
        }
    }

    @Test void concurrentIdenticalIdempotencyRetriesConvergeOnOneRowAndOneAudit() throws Exception {
        PGSimpleDataSource base = new PGSimpleDataSource(); base.setUrl(DB.getJdbcUrl());
        base.setUser("voltpilot_app"); base.setPassword("action_pw");
        var ds = new TenantAwareDataSource(base);
        var repo = new OcppActionRepository(new JdbcTemplate(ds), MAPPER);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        String key = "concurrent-" + UUID.randomUUID();
        CyclicBarrier barrier = new CyclicBarrier(2);
        Callable<OcppActionDto.Action> attempt = () -> {
            TenantContext.set(TENANT);
            try {
                barrier.await();
                return tx.execute(x -> {
                    repo.lockIdempotency(TENANT, key);
                    UUID id = UUID.randomUUID(); Instant now = Instant.now();
                    var inserted = repo.insertIfAbsent(id, TENANT, SITE, DEVICE, "CP-A", "GetConfiguration",
                            "ocpp-"+id, key, "b".repeat(64), "GetConfiguration", "actor", null, null,
                            MAPPER.createObjectNode(), now, now.plusSeconds(30));
                    return inserted.orElseGet(() -> repo.storedByIdempotency(TENANT, key).orElseThrow().action());
                });
            } finally { TenantContext.clear(); }
        };
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(attempt); var second = pool.submit(attempt);
            assertThat(first.get().id()).isEqualTo(second.get().id());
        }
        TenantContext.set(TENANT);
        try {
            var stored = repo.storedByIdempotency(TENANT, key).orElseThrow();
            assertThat(repo.audit(SITE, stored.action().id())).hasSize(1);
        } finally { TenantContext.clear(); }
    }

    @Test void concurrentStationResponsesSerializeWithoutRegressingTheTerminalOutcome() throws Exception {
        UUID id;
        try (Harness h = harness()) {
            id = insert(h, "CP-A", "ClearCache", "ClearCache", null, null,
                    MAPPER.createObjectNode(), Instant.now().plusSeconds(30));
        }
        PGSimpleDataSource base = new PGSimpleDataSource(); base.setUrl(DB.getJdbcUrl());
        base.setUser("voltpilot_app"); base.setPassword("action_pw");
        var ds = new TenantAwareDataSource(base);
        var repo = new OcppActionRepository(new JdbcTemplate(ds), MAPPER);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        CyclicBarrier barrier = new CyclicBarrier(2);
        Callable<Void> response = () -> {
            TenantContext.set(TENANT);
            try {
                barrier.await();
                var e = MAPPER.createObjectNode(); e.put("message_type", "CallResult");
                e.put("direction", "station_to_csms"); e.put("action", "ClearCache");
                e.put("correlation_id", "ocpp-" + id); e.put("wire_id", id.toString());
                e.put("occurred_at", Instant.now().toString());
                e.set("payload", MAPPER.readTree("{\"status\":\"Accepted\"}"));
                tx.executeWithoutResult(x -> repo.applyProtocolEvidence(TENANT, DEVICE, "CP-A", e));
                return null;
            } finally { TenantContext.clear(); }
        };
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(response); var second = pool.submit(response);
            first.get(); second.get();
        }
        TenantContext.set(TENANT);
        try {
            assertThat(repo.byId(id).orElseThrow().state()).isEqualTo("completed");
            assertThat(repo.audit(SITE, id).stream().map(OcppActionDto.Audit::state))
                    .containsExactly("prepared", "completed", "late_response");
        } finally { TenantContext.clear(); }
    }

    @Test void durableEdgeRejectionBecomesAnExplicitTerminalOutcome() throws Exception {
        try (Harness h = harness()) {
            UUID id = insert(h, "CP-A", "UnlockConnector", "UnlockConnector", 1, null,
                    MAPPER.readTree("{\"connectorId\":1}"), Instant.now().plusSeconds(30));
            var e = MAPPER.createObjectNode(); e.put("message_type", "Event");
            e.put("direction", "internal"); e.put("action", "CommandRejected");
            e.put("correlation_id", "ocpp-" + id); e.put("occurred_at", Instant.now().toString());
            e.set("payload", MAPPER.readTree("{\"action_id\":\"" + id
                    + "\",\"code\":\"station_offline\",\"reason\":\"Ladesäule ist offline\"}"));
            h.tx.executeWithoutResult(x -> h.repo.applyProtocolEvidence(TENANT, DEVICE, "CP-A", e));
            var action = h.repo.byId(id).orElseThrow();
            assertThat(action.state()).isEqualTo("edge_rejected");
            assertThat(action.reason()).contains("offline");

            UUID readback = insert(h, "CP-A", "ChangeConfiguration", "ChangeConfiguration", null, null,
                    MAPPER.readTree("{\"key\":\"HeartbeatInterval\",\"value\":\"300\"}"),
                    Instant.now().plusSeconds(30));
            evidence(h, "CP-A", "CallResult", "ChangeConfiguration", "ocpp-" + readback,
                    "{\"status\":\"Accepted\"}");
            var failedReadback = MAPPER.createObjectNode(); failedReadback.put("message_type", "Event");
            failedReadback.put("direction", "internal"); failedReadback.put("action", "CommandRejected");
            failedReadback.put("correlation_id", "ocpp-" + readback);
            failedReadback.put("occurred_at", Instant.now().toString());
            failedReadback.set("payload", MAPPER.readTree(
                    "{\"action_id\":\"" + readback
                            + "\",\"code\":\"readback_failed\",\"reason\":\"Readback konnte nicht gesendet werden\"}"));
            h.tx.executeWithoutResult(x -> h.repo.applyProtocolEvidence(TENANT, DEVICE, "CP-A", failedReadback));
            assertThat(h.repo.byId(readback).orElseThrow().state()).isEqualTo("effect_failed");

            UUID untouched = insert(h, "CP-A", "UnlockConnector", "UnlockConnector", 2, null,
                    MAPPER.readTree("{\"connectorId\":2}"), Instant.now().plusSeconds(30));
            var mismatched = MAPPER.createObjectNode(); mismatched.put("message_type", "Event");
            mismatched.put("direction", "internal"); mismatched.put("action", "CommandRejected");
            mismatched.put("correlation_id", "ocpp-" + untouched);
            mismatched.put("occurred_at", Instant.now().toString());
            mismatched.set("payload", MAPPER.readTree("{\"action_id\":\"" + UUID.randomUUID()
                    + "\",\"code\":\"station_offline\",\"reason\":\"wrong target\"}"));
            h.tx.executeWithoutResult(x -> h.repo.applyProtocolEvidence(TENANT, DEVICE, "CP-A", mismatched));
            assertThat(h.repo.byId(untouched).orElseThrow().state()).isEqualTo("prepared");
            assertThat(h.repo.cancel(untouched, TENANT, "test-cleanup", Instant.now())).isTrue();
        }
    }

    private static UUID insert(Harness h, String cp, String action, String conflict, Integer connector,
            Integer transaction, com.fasterxml.jackson.databind.JsonNode request, Instant deadline) {
        UUID id = UUID.randomUUID(); Instant now = deadline.minusSeconds(30);
        return h.tx.execute(x -> h.repo.insert(id, TENANT, SITE, DEVICE, cp, action, "ocpp-"+id,
                "idem-"+id, "a".repeat(64), conflict, "actor", connector, transaction,
                request, now, deadline).id());
    }

    private static void evidence(Harness h, String cp, String type, String action, String correlation, String payload) throws Exception {
        evidenceAt(h, cp, type, action, correlation, payload, Instant.now());
    }

    private static void evidenceAt(Harness h, String cp, String type, String action, String correlation,
            String payload, Instant occurredAt) throws Exception {
        var e = MAPPER.createObjectNode(); e.put("message_type", type); e.put("direction", "station_to_csms");
        e.put("action", action); e.put("occurred_at", occurredAt.toString());
        if (correlation != null) {
            e.put("correlation_id", correlation);
            e.put("wire_id", correlation.matches("^ocpp-[0-9a-f-]{36}$")
                    ? correlation.substring(5) : UUID.randomUUID().toString());
        }
        e.set("payload", MAPPER.readTree(payload));
        h.tx.executeWithoutResult(x -> h.repo.applyProtocolEvidence(TENANT, DEVICE, cp, e));
    }

    private static void connectorStatus(Harness h, String cp, int connector, String status, Instant at) {
        new JdbcTemplate(h.ds).update("INSERT INTO ocpp_connector_status_event(occurred_at,event_id,tenant_id,"
                + "site_id,device_id,charge_point_id,connector_id,status,error_code) VALUES(?,?,?,?,?,?,?,?,?)",
                java.sql.Timestamp.from(at), UUID.randomUUID(), TENANT, SITE, DEVICE, cp, connector, status, "NoError");
    }

    private static Harness harness() throws Exception {
        var ds = new SingleConnectionDataSource(DB.getJdbcUrl(), "voltpilot_app", "action_pw", true);
        try (PreparedStatement ps = ds.getConnection().prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) { ps.setString(1, TENANT.toString()); ps.execute(); }
        var tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        return new Harness(ds, new OcppActionRepository(new JdbcTemplate(ds), MAPPER), tx);
    }
    private record Harness(SingleConnectionDataSource ds, OcppActionRepository repo, TransactionTemplate tx) implements AutoCloseable {
        @Override public void close() { ds.destroy(); }
    }
}
