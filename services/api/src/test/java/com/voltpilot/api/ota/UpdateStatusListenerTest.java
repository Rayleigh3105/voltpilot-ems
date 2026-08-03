package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.UpdateStatusRepository;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * The OTA Stufe-0 ingest of the heartbeat's top-level {@code version} plus the
 * additive {@code update} block - a PURE unit test, so it runs without Docker
 * (the end-to-end journey lives in
 * {@code AdminApiTest.otaUpdateStatusIsIngestedAndTheFleetCarriesTheRegisterSoll}).
 *
 * <p>What it protects: this is the ONLY thing that tells the platform which
 * build a box runs. The whole stage exists so „veraltet" stops being a guess,
 * so what must NOT be stored matters as much as what must - a fabricated
 * sequence number would corrupt the register ordering the verdict rests on,
 * and an unknown state word would become a portal sentence nobody can render.
 */
class UpdateStatusListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private DeviceRepository devices;
    private UpdateStatusRepository store;
    private UpdateStatusListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        store = mock(UpdateStatusRepository.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(
                DEVICE, SITE, "demo-inverter-01", "inverter", null, "active",
                Instant.now(), Instant.now())));
        listener = new UpdateStatusListener("tcp://localhost:1883", "", "", devices, store);
    }

    /** One heartbeat in; the captured upsert arguments out. */
    private record Row(String version, String backend, String current, Long currentSeq,
            String target, Long targetSeq, String channel, String state, String reason,
            String lastKnownGood) {
    }

    private Row ingest(String bodyFields) {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\"," + bodyFields + "}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        ArgumentCaptor<String> version = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> backend = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> current = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Long> currentSeq = ArgumentCaptor.forClass(Long.class);
        ArgumentCaptor<String> target = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Long> targetSeq = ArgumentCaptor.forClass(Long.class);
        ArgumentCaptor<String> channel = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> state = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> reason = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> lkg = ArgumentCaptor.forClass(String.class);
        verify(store).upsert(eq(DEVICE), eq(SITE), version.capture(), backend.capture(),
                current.capture(), currentSeq.capture(), target.capture(), targetSeq.capture(),
                channel.capture(), state.capture(), reason.capture(), lkg.capture(), any());
        return new Row(version.getValue(), backend.getValue(), current.getValue(),
                currentSeq.getValue(), target.getValue(), targetSeq.getValue(),
                channel.getValue(), state.getValue(), reason.getValue(), lkg.getValue());
    }

    private void assertNothingStored() {
        verify(store, never()).upsert(any(), any(), anyString(), anyString(), anyString(), any(),
                anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(store, never()).upsert(any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any());
    }

    /**
     * The Stufe-0 heartbeat of a healthy box: the top-level version plus an
     * idle update block naming the compose backend. This is the shape the
     * fleet's "Soll gegen Ist" column reads.
     */
    @Test
    void aStufe0HeartbeatIsStoredWithTheStampedVersion() {
        Row row = ingest("\"version\":\"edge-2026.08.0+3bf8c0380000\","
                + "\"update\":{\"backend\":\"compose\","
                + "\"current\":\"edge-2026.08.0+3bf8c0380000\",\"state\":\"idle\"}");

        assertThat(row.version()).isEqualTo("edge-2026.08.0+3bf8c0380000");
        assertThat(row.backend()).isEqualTo("compose");
        assertThat(row.current()).isEqualTo("edge-2026.08.0+3bf8c0380000");
        assertThat(row.state()).isEqualTo("idle");
        // Nothing the device could not know is invented on the way in.
        assertThat(row.currentSeq()).isNull();
        assertThat(row.target()).isNull();
        assertThat(row.targetSeq()).isNull();
        assertThat(row.channel()).isNull();
        assertThat(row.reason()).isNull();
        assertThat(row.lastKnownGood()).isNull();
    }

    /**
     * THE regression guard of the whole increment (scout §2.3 hole 1): a box on
     * which no automation was ever rolled out sends NO {@code flows} block -
     * the ingest that hangs on it never saw such a device. This listener does.
     */
    @Test
    void aDeviceWithoutAnyFlowsBlockStillReportsItsVersion() {
        Row row = ingest("\"version\":\"665d59b80000\","
                + "\"update\":{\"backend\":\"compose\",\"current\":\"665d59b80000\","
                + "\"state\":\"idle\"}");

        // Verbatim, including a bare commit SHA - the register lookup, not the
        // ingest, decides that such a version is "nicht registriert".
        assertThat(row.version()).isEqualTo("665d59b80000");
        assertThat(row.state()).isEqualTo("idle");
    }

    /**
     * An OLDER edge (no version, no update block) must leave no trace at all -
     * a row would turn "we have never heard" into a claim, and the fleet view
     * must be able to say „unbekannt".
     */
    @Test
    void anOlderEdgeWithoutEitherFieldStoresNothing() {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"online\":true,"
                + "\"flows\":{\"core_version\":\"1.4.0\",\"applied\":[]}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        assertNothingStored();
    }

    /**
     * A state outside the contract vocabulary is DROPPED, not stored: a word
     * the cloud does not understand must not become a portal sentence. The
     * version around it still lands - the rest of the report is not poisoned
     * by one unknown field.
     */
    @Test
    void anUnknownStateIsDroppedWhileTheRestIsKept() {
        Row row = ingest("\"version\":\"edge-2026.08.0\","
                + "\"update\":{\"backend\":\"compose\",\"current\":\"edge-2026.08.0\","
                + "\"state\":\"teleporting\"}");

        assertThat(row.state()).isNull();
        assertThat(row.version()).isEqualTo("edge-2026.08.0");
        assertThat(row.backend()).isEqualTo("compose");
    }

    /**
     * The later stages' fields are ingested when they DO arrive - the schema is
     * ready so Stufe 2 needs no second migration - but a sequence number that
     * is not a whole non-negative number is not the register's ordering and is
     * dropped rather than coerced.
     */
    @Test
    void theLaterStageFieldsAreIngestedButAGarbageSequenceIsDropped() {
        Row good = ingest("\"version\":\"edge-2026.07.2\","
                + "\"update\":{\"backend\":\"compose\",\"current\":\"edge-2026.07.2\","
                + "\"current_seq\":11,\"target\":\"edge-2026.08.0\",\"target_seq\":12,"
                + "\"channel\":\"stable\",\"state\":\"downloading\","
                + "\"last_known_good\":\"edge-2026.07.1\"}");
        assertThat(good.currentSeq()).isEqualTo(11L);
        assertThat(good.targetSeq()).isEqualTo(12L);
        assertThat(good.target()).isEqualTo("edge-2026.08.0");
        assertThat(good.channel()).isEqualTo("stable");
        assertThat(good.state()).isEqualTo("downloading");
        assertThat(good.lastKnownGood()).isEqualTo("edge-2026.07.1");

        setUp(); // fresh mocks for the second ingest
        Row bad = ingest("\"version\":\"edge-2026.07.2\","
                + "\"update\":{\"backend\":\"compose\",\"current_seq\":\"zwölf\","
                + "\"target_seq\":-3,\"state\":\"idle\"}");
        assertThat(bad.currentSeq()).isNull();
        assertThat(bad.targetSeq()).isNull();
    }

    /**
     * A device may only ever speak for itself: the topic identity is
     * re-validated against the payload identity exactly like every sibling
     * listener on this filter.
     */
    @Test
    void aSpoofedIdentityIsIgnored() {
        UUID other = UUID.fromString("00000000-0000-0000-0000-0000000000ff");
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + other + "\",\"version\":\"edge-2026.08.0\","
                + "\"update\":{\"backend\":\"compose\",\"state\":\"idle\"}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        assertNothingStored();
    }

    /** A device the tenant's RLS view does not know is skipped. */
    @Test
    void anUnknownDeviceIsSkipped() {
        when(devices.findById(DEVICE)).thenReturn(Optional.empty());
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"version\":\"edge-2026.08.0\"}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        assertNothingStored();
    }

    /** Garbage on the topic never throws and never stores. */
    @Test
    void garbageIsIgnored() {
        listener.handle(TOPIC, "not json".getBytes(StandardCharsets.UTF_8));
        listener.handle("ems/nope/status", "{}".getBytes(StandardCharsets.UTF_8));
        listener.handle("ems/a/b/c/status",
                "{\"version\":\"x\"}".getBytes(StandardCharsets.UTF_8));
        assertNothingStored();
    }
}
