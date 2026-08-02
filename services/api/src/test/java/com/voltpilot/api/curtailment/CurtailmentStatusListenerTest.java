package com.voltpilot.api.curtailment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.CurtailmentStatusRepository;
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
 * The curtailment listener's parse of the additive {@code curtailment}
 * heartbeat block (scout {@code vp-pilsting-abregeln}, PR 3) - a PURE unit
 * test, so it runs without Docker (the end-to-end journey lives in
 * {@code PortalApiTest.curtailmentStatusIsIngestedFromHeartbeatAndTenantScoped}).
 *
 * <p>What it protects: this block is the ONLY evidence the cloud has that a
 * planned "Abregeln" slot is actually executed. Every field here becomes a
 * customer sentence, so an absent value must stay absent - a fabricated
 * confirmation is exactly the defect the whole fix exists to end.
 */
class CurtailmentStatusListenerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/status";

    private DeviceRepository devices;
    private CurtailmentStatusRepository store;
    private CurtailmentStatusListener listener;

    @BeforeEach
    void setUp() {
        devices = mock(DeviceRepository.class);
        store = mock(CurtailmentStatusRepository.class);
        when(devices.findById(DEVICE)).thenReturn(Optional.of(new DeviceDto(
                DEVICE, SITE, "demo-inverter-01", "inverter", null, "active", Instant.now(), Instant.now())));
        listener = new CurtailmentStatusListener("tcp://localhost:1883", "", "", devices, store);
    }

    /** One heartbeat in; the captured upsert arguments out. */
    private record Row(int units, int certified, boolean controlEnabled, boolean active,
            Double cap, Boolean allMatch, boolean override, Instant checkedAt) {
    }

    private Row ingest(String block) {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"curtailment\":" + block + "}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        ArgumentCaptor<Integer> units = ArgumentCaptor.forClass(Integer.class);
        ArgumentCaptor<Integer> certified = ArgumentCaptor.forClass(Integer.class);
        ArgumentCaptor<Boolean> controlEnabled = ArgumentCaptor.forClass(Boolean.class);
        ArgumentCaptor<Boolean> active = ArgumentCaptor.forClass(Boolean.class);
        ArgumentCaptor<Double> cap = ArgumentCaptor.forClass(Double.class);
        ArgumentCaptor<Boolean> allMatch = ArgumentCaptor.forClass(Boolean.class);
        ArgumentCaptor<Boolean> override = ArgumentCaptor.forClass(Boolean.class);
        ArgumentCaptor<Instant> checkedAt = ArgumentCaptor.forClass(Instant.class);
        verify(store).upsert(eq(DEVICE), eq(SITE), units.capture(), certified.capture(),
                controlEnabled.capture(), active.capture(), cap.capture(), allMatch.capture(),
                override.capture(), checkedAt.capture());
        return new Row(units.getValue(), certified.getValue(), controlEnabled.getValue(),
                active.getValue(), cap.getValue(), allMatch.getValue(), override.getValue(),
                checkedAt.getValue());
    }

    private void assertNothingStored() {
        verify(store, never()).upsert(any(), any(), anyInt(), anyInt(), anyBoolean(), anyBoolean(),
                any(), any(), anyBoolean(), any());
    }

    /**
     * The Pilsting constellation (02.08., ~10:41): two Fronius units exist, the
     * kill-switch is on, and NEITHER unit carries a First-Light release - so
     * nothing is applied and the plan stays a plan. That is the cause the
     * portal names ("0 von 2 Wechselrichtern freigegeben").
     */
    @Test
    void anUnreleasedPlantIsStoredAsCapableButInactive() {
        Row row = ingest("{\"units\":2,\"certified_units\":0,\"control_enabled\":true,"
                + "\"active\":false,\"checked_at\":\"2026-08-02T10:41:07Z\"}");

        assertThat(row.units()).isEqualTo(2);
        assertThat(row.certified()).isZero();
        assertThat(row.controlEnabled()).isTrue();
        assertThat(row.active()).isFalse();
        assertThat(row.cap()).isNull();
        assertThat(row.allMatch()).isNull();
        assertThat(row.override()).isFalse();
        assertThat(row.checkedAt()).isEqualTo(Instant.parse("2026-08-02T10:41:07Z"));
    }

    /** The released, applying, confirmed plant - the only shape that is evidence. */
    @Test
    void aConfirmedCapCarriesItsAppliedValue() {
        Row row = ingest("{\"units\":2,\"certified_units\":2,\"control_enabled\":true,"
                + "\"active\":true,\"applied_cap_kw\":12.5,\"all_match\":true,"
                + "\"checked_at\":\"2026-08-02T11:00:00Z\"}");

        assertThat(row.certified()).isEqualTo(2);
        assertThat(row.active()).isTrue();
        assertThat(row.cap()).isEqualTo(12.5);
        assertThat(row.allMatch()).isTrue();
    }

    /**
     * "Nothing applied" and "the readback disagreed" are DIFFERENT statements:
     * an absent all_match must stay null, because false is what a consumer
     * renders as an override-shaped warning.
     */
    @Test
    void anAbsentAllMatchStaysNullNeverFalse() {
        assertThat(ingest("{\"units\":1,\"certified_units\":1,\"control_enabled\":true,"
                + "\"active\":false}").allMatch()).isNull();

        setUp();
        assertThat(ingest("{\"units\":1,\"certified_units\":1,\"control_enabled\":true,"
                + "\"active\":true,\"all_match\":false}").allMatch()).isFalse();
    }

    /** A foreign controller holding the inverter is the sharpest truth here. */
    @Test
    void aPossibleOverrideIsCarriedThrough() {
        Row row = ingest("{\"units\":2,\"certified_units\":2,\"control_enabled\":true,"
                + "\"active\":true,\"applied_cap_kw\":0.0,\"all_match\":true,"
                + "\"possible_override\":true}");

        assertThat(row.override()).isTrue();
        // A real applied cap of zero is a VALUE, not an absence.
        assertThat(row.cap()).isEqualTo(0.0);
    }

    /**
     * A block describing no actor at all would turn "we know nothing" into
     * "0 von 0 freigegeben" - it is dropped, so the portal keeps its plan
     * wording. Same for a heartbeat without the block (an older edge).
     */
    @Test
    void aBlockWithoutUnitsAndAHeartbeatWithoutTheBlockStoreNothing() {
        ingestRaw("{\"units\":0,\"certified_units\":0,\"control_enabled\":true,\"active\":false}");
        assertNothingStored();

        setUp();
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"control\":{\"all_match\":true}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
        assertNothingStored();
    }

    /**
     * The counts reach the customer as "X von Y Wechselrichtern", so garbage is
     * bounded rather than rendered: a negative count reads as 0, an absurd one
     * is capped, and more releases than units can never be reported.
     */
    @Test
    void unitCountsAreSanityBounded() {
        Row row = ingest("{\"units\":9999,\"certified_units\":-3,\"control_enabled\":true,"
                + "\"active\":false}");
        assertThat(row.units()).isEqualTo(64);
        assertThat(row.certified()).isZero();

        setUp();
        assertThat(ingest("{\"units\":2,\"certified_units\":7,\"control_enabled\":true,"
                + "\"active\":false}").certified()).isEqualTo(2);
    }

    /** A missing/garbage stamp falls back to now(), never drops the truth. */
    @Test
    void anUnparseableStampFallsBackToNow() {
        Instant before = Instant.now();
        Row row = ingest("{\"units\":1,\"certified_units\":1,\"control_enabled\":true,"
                + "\"active\":true,\"all_match\":true,\"checked_at\":\"gestern\"}");

        assertThat(row.checkedAt()).isBetween(before.minusSeconds(1), Instant.now().plusSeconds(1));
    }

    /** A device may not report another device's curtailment state (spoof guard). */
    @Test
    void aSpoofedIdentityIsIgnoredEntirely() {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"99999999-9999-9999-9999-999999999999\","
                + "\"curtailment\":{\"units\":2,\"certified_units\":2,\"control_enabled\":true,"
                + "\"active\":true,\"all_match\":true}}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));

        assertNothingStored();
    }

    /** Unknown device / wrong site on the topic: nothing is written. */
    @Test
    void anUnknownDeviceIsSkipped() {
        when(devices.findById(DEVICE)).thenReturn(Optional.empty());
        ingestRaw("{\"units\":2,\"certified_units\":2,\"control_enabled\":true,\"active\":true}");

        assertNothingStored();
    }

    private void ingestRaw(String block) {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"curtailment\":" + block + "}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
    }
}
