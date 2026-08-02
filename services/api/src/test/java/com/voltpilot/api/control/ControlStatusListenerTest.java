package com.voltpilot.api.control;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.ControlStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * The status listener's parse of the in-slot EXECUTION truth (Fahrplan concept
 * vp-fahrplan-kunde-konzept §5, PR 3) - a PURE unit test, so it runs without
 * Docker (the end-to-end journey lives in
 * {@code PortalApiTest.controlStatusIsIngestedFromHeartbeatAndTenantScoped}).
 *
 * <p>What it protects: {@code commanded_kw} has carried the CORRECTED value
 * since the in-slot duties, but nothing said why - so the portal could only
 * state "the device adjusted the value" next to a Fahrplan bar showing a
 * different number. The direction is the load-bearing half (raising and
 * limiting a discharge are both deliberate), and every claim here must be one
 * the device actually made.
 */
class ControlStatusListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private DeviceRepository devices;
    private ControlStatusRepository store;
    private ControlStatusListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        store = mock(ControlStatusRepository.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(
                DEVICE, SITE, "demo-inverter-01", "inverter", null, "active", Instant.now(), Instant.now())));
        listener = new ControlStatusListener("tcp://localhost:1883", "", "", devices, store);
    }

    private ControlStatusRepository.Execution ingest(String controlBlock, String controlSource) {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\""
                + (controlSource == null ? "" : ",\"control_source\":\"" + controlSource + "\"")
                + ",\"control\":" + controlBlock + "}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        ArgumentCaptor<ControlStatusRepository.Execution> captor =
                ArgumentCaptor.forClass(ControlStatusRepository.Execution.class);
        verify(store).upsert(eq(DEVICE), eq(SITE), any(), any(), anyBoolean(), anyBoolean(), anyBoolean(),
                any(), any(), any(), captor.capture());
        return captor.getValue();
    }

    private static final String BASE = "\"commanded_kw\":-7.087,\"confirmed_kw\":-7.087,"
            + "\"all_match\":true,\"control_enabled\":true,\"certified\":true,"
            + "\"checked_at\":\"2026-07-30T21:22:03Z\"";

    /**
     * The captain's live constellation (30.07., 21:22): the plan discharged
     * -4,332 kW into a 7,117 kW house, so the box RAISED the discharge instead
     * of buying the difference at ~32,5 ct.
     */
    @Test
    void followDeepenCarriesDirectionPlanAndMeasuredDeficit() {
        var ex = ingest("{" + BASE + ",\"execution\":{\"mode\":\"follow\",\"direction\":\"deepen\","
                + "\"planned_kw\":-4.332,\"deficit_kw\":7.087}}", "schedule");

        assertThat(ex.source()).isEqualTo("schedule");
        assertThat(ex.mode()).isEqualTo("follow");
        assertThat(ex.direction()).isEqualTo("deepen");
        assertThat(ex.plannedKw()).isEqualTo(-4.332);
        assertThat(ex.targetKw()).isEqualTo(7.087);
    }

    /** The mirror (23:12): a discharge deeper than the house needed is LIMITED. */
    @Test
    void followReduceCarriesTheOtherDirection() {
        var ex = ingest("{" + BASE + ",\"execution\":{\"mode\":\"follow\",\"direction\":\"reduce\","
                + "\"planned_kw\":-6.7,\"deficit_kw\":5.1}}", "schedule");

        assertThat(ex.mode()).isEqualTo("follow");
        assertThat(ex.direction()).isEqualTo("reduce");
        assertThat(ex.targetKw()).isEqualTo(5.1);
    }

    /** A trim tracks the PV SURPLUS and has no follow direction to claim. */
    @Test
    void trimTakesTheSurplusAsItsTargetAndInventsNoDirection() {
        var ex = ingest("{" + BASE + ",\"execution\":{\"mode\":\"trim\","
                + "\"planned_kw\":11.1,\"surplus_kw\":3.1}}", "schedule");

        assertThat(ex.mode()).isEqualTo("trim");
        assertThat(ex.direction()).isNull();
        assertThat(ex.plannedKw()).isEqualTo(11.1);
        assertThat(ex.targetKw()).isEqualTo(3.1);
    }

    /** An uncorrected slot and the built-in rule are two different statements. */
    @Test
    void planAndFallbackAreStoredWithoutCorrectionDetail() {
        var plan = ingest("{" + BASE + ",\"execution\":{\"mode\":\"plan\"}}", "schedule");
        assertThat(plan.mode()).isEqualTo("plan");
        assertThat(plan.direction()).isNull();
        assertThat(plan.plannedKw()).isNull();
        assertThat(plan.targetKw()).isNull();

        setUp();
        var fallback = ingest("{" + BASE + ",\"execution\":{\"mode\":\"fallback\"}}", "default");
        assertThat(fallback.mode()).isEqualTo("fallback");
        assertThat(fallback.source()).isEqualTo("default");
    }

    /**
     * An older edge sends no execution block. The coarse source is all we know
     * and is stored as exactly that - a guessed mode would become a sentence
     * about something nobody measured.
     */
    @Test
    void anOlderEdgeYieldsTheCoarseSourceAndNothingElse() {
        var ex = ingest("{" + BASE + "}", "default");

        assertThat(ex.source()).isEqualTo("default");
        assertThat(ex.mode()).isNull();
        assertThat(ex.direction()).isNull();
        assertThat(ex.plannedKw()).isNull();
        assertThat(ex.targetKw()).isNull();
    }

    /** An edge that sends neither leaves the whole execution truth empty. */
    @Test
    void aHeartbeatWithoutASourceClaimsNothing() {
        var ex = ingest("{" + BASE + "}", null);

        assertThat(ex).isEqualTo(ControlStatusRepository.Execution.NONE);
    }

    /**
     * A word we do not understand must not become a claim: an unknown mode or
     * direction is dropped, the rest of the heartbeat still lands.
     */
    @Test
    void unknownModeOrDirectionIsDroppedNotStored() {
        var ex = ingest("{" + BASE + ",\"execution\":{\"mode\":\"telepathie\","
                + "\"direction\":\"seitwaerts\",\"planned_kw\":-4.0,\"deficit_kw\":7.0}}", "schedule");

        assertThat(ex.mode()).isNull();
        assertThat(ex.direction()).isNull();
        assertThat(ex.plannedKw()).isEqualTo(-4.0);
        assertThat(ex.source()).isEqualTo("schedule");
        // WHICH measurement the target is only follows from the mode - without
        // one it stays out rather than being stored uninterpretable.
        assertThat(ex.targetKw()).isNull();

        // A direction only exists for "follow" - a trim reporting one is ignored.
        setUp();
        var trim = ingest("{" + BASE + ",\"execution\":{\"mode\":\"trim\",\"direction\":\"deepen\"}}", "schedule");
        assertThat(trim.direction()).isNull();
    }

    /**
     * Never regulate blind - never REPORT blind either: a correction whose
     * measured target is missing keeps the target null instead of 0.
     */
    @Test
    void anUnmeasuredTargetStaysNullNeverZero() {
        var ex = ingest("{" + BASE + ",\"execution\":{\"mode\":\"follow\",\"direction\":\"deepen\","
                + "\"planned_kw\":-4.0}}", "schedule");

        assertThat(ex.targetKw()).isNull();
    }

    /** A device may not report another device's control state (spoof guard). */
    @Test
    void aSpoofedIdentityIsIgnoredEntirely() {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"99999999-9999-9999-9999-999999999999\","
                + "\"control\":{" + BASE + ",\"execution\":{\"mode\":\"follow\",\"direction\":\"deepen\"}}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));

        verify(store, never()).upsert(any(), any(), any(), any(), anyBoolean(), anyBoolean(), anyBoolean(),
                any(), any(), any(), any());
    }
}
