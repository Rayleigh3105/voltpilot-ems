package com.voltpilot.api.curtailment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.CurtailmentStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.web.dto.CurtailmentStatusDto;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.web.dto.DeviceExportLimitDto;
import com.voltpilot.api.web.dto.ExportGuardDto;
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

    /** One heartbeat in; the captured upsert row out. */
    private CurtailmentStatusDto ingest(String block) {
        ingestRaw(block);
        ArgumentCaptor<CurtailmentStatusDto> row =
                ArgumentCaptor.forClass(CurtailmentStatusDto.class);
        verify(store).upsert(eq(SITE), row.capture());
        assertThat(row.getValue().deviceId()).isEqualTo(DEVICE);
        return row.getValue();
    }

    private void assertNothingStored() {
        verify(store, never()).upsert(any(), any());
    }

    /**
     * The Pilsting constellation (02.08., ~10:41): two Fronius units exist, the
     * kill-switch is on, and NEITHER unit carries a First-Light release - so
     * nothing is applied and the plan stays a plan. That is the cause the
     * portal names ("0 von 2 Wechselrichtern freigegeben").
     */
    @Test
    void anUnreleasedPlantIsStoredAsCapableButInactive() {
        CurtailmentStatusDto row = ingest("{\"units\":2,\"certified_units\":0,\"control_enabled\":true,"
                + "\"active\":false,\"checked_at\":\"2026-08-02T10:41:07Z\"}");

        assertThat(row.units()).isEqualTo(2);
        assertThat(row.certifiedUnits()).isZero();
        assertThat(row.controlEnabled()).isTrue();
        assertThat(row.active()).isFalse();
        assertThat(row.appliedCapKw()).isNull();
        assertThat(row.allMatch()).isNull();
        assertThat(row.possibleOverride()).isFalse();
        assertThat(row.checkedAt()).isEqualTo(Instant.parse("2026-08-02T10:41:07Z"));
    }

    /** The released, applying, confirmed plant - the only shape that is evidence. */
    @Test
    void aConfirmedCapCarriesItsAppliedValue() {
        CurtailmentStatusDto row = ingest("{\"units\":2,\"certified_units\":2,\"control_enabled\":true,"
                + "\"active\":true,\"applied_cap_kw\":12.5,\"all_match\":true,"
                + "\"checked_at\":\"2026-08-02T11:00:00Z\"}");

        assertThat(row.certifiedUnits()).isEqualTo(2);
        assertThat(row.active()).isTrue();
        assertThat(row.appliedCapKw()).isEqualTo(12.5);
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
        CurtailmentStatusDto row = ingest("{\"units\":2,\"certified_units\":2,\"control_enabled\":true,"
                + "\"active\":true,\"applied_cap_kw\":0.0,\"all_match\":true,"
                + "\"possible_override\":true}");

        assertThat(row.possibleOverride()).isTrue();
        // A real applied cap of zero is a VALUE, not an absence.
        assertThat(row.appliedCapKw()).isEqualTo(0.0);
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
        CurtailmentStatusDto row = ingest("{\"units\":9999,\"certified_units\":-3,\"control_enabled\":true,"
                + "\"active\":false}");
        assertThat(row.units()).isEqualTo(64);
        assertThat(row.certifiedUnits()).isZero();

        setUp();
        assertThat(ingest("{\"units\":2,\"certified_units\":7,\"control_enabled\":true,"
                + "\"active\":false}").certifiedUnits()).isEqualTo(2);
    }

    /** A missing/garbage stamp falls back to now(), never drops the truth. */
    @Test
    void anUnparseableStampFallsBackToNow() {
        Instant before = Instant.now();
        CurtailmentStatusDto row = ingest("{\"units\":1,\"certified_units\":1,\"control_enabled\":true,"
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

    // --- „Grenzen & Wächter" Stufe 0 ------------------------------------------

    /**
     * The Herzogau block VERBATIM (live snapshot 17.08.2026, 18:19 -
     * {@code vp-herzogau-runde2-m6/live-snapshot-1818/state.json}): the box
     * knows a 70 kW limit, computes a 76,9 kW cap - and can write it NOWHERE
     * because neither of its two inverters is released. The cloud read none of
     * this, which is why "welche Einspeisegrenze hält die Box?" cost two
     * investigation rounds through a maintenance tunnel.
     */
    @Test
    void theHerzogauWatchdogBlockIsIngestedVerbatim() {
        CurtailmentStatusDto row = ingest("{\"units\":2,\"certified_units\":0,"
                + "\"control_enabled\":true,\"active\":false,"
                + "\"checked_at\":\"2026-08-17T16:19:00Z\",\"export_guard\":{"
                + "\"limit_kw\":70,\"state\":\"ueberwacht\","
                + "\"reason\":\"Die Einspeisung liegt bei 0,0 kW von 70,0 kW - die Erzeuger "
                + "sind vorsorglich auf 76,9 kW begrenzt, greifen dort aber nicht an "
                + "(Erzeugung 8,3 kW).\",\"cap_kw\":76.927,\"limiting\":false,\"blind\":false,"
                + "\"effective\":false,\"reach\":\"Kein Wechselrichter ist für die Abregelung "
                + "freigegeben (0 von 2) - die Einspeisegrenze wird berechnet, aber an KEIN "
                + "Gerät geschrieben. Sie ist damit nicht wirksam.\"}}");

        ExportGuardDto g = row.exportGuard();
        assertThat(g).isNotNull();
        assertThat(g.limitKw()).isEqualTo(70.0);
        assertThat(g.state()).isEqualTo("ueberwacht");
        assertThat(g.capKw()).isEqualTo(76.927);
        assertThat(g.limiting()).isFalse();
        assertThat(g.blind()).isFalse();
        // THE field: a perfect cap that reaches no device at all.
        assertThat(g.effective()).isFalse();
        assertThat(g.reach()).startsWith("Kein Wechselrichter ist für die Abregelung freigegeben");
        assertThat(g.reason()).contains("76,9 kW begrenzt");
    }

    /**
     * An OLDER edge sends no guard at all - the row is stored, the guard stays
     * null, and no surface may claim a limit nobody reported. That is what keeps
     * this ingest additive.
     */
    @Test
    void aHeartbeatWithoutTheGuardStoresTheRowWithoutIt() {
        CurtailmentStatusDto row = ingest("{\"units\":2,\"certified_units\":2,"
                + "\"control_enabled\":true,\"active\":true,\"all_match\":true}");

        assertThat(row.exportGuard()).isNull();
        assertThat(row.deviceExportLimit()).isNull();
        assertThat(row.units()).isEqualTo(2);
    }

    /**
     * The vocabulary rule: a state word we do not understand drops the WHOLE
     * guard, because a German sentence the portal cannot classify is exactly the
     * "unknown word became a claim" defect. The surrounding row survives - the
     * curtailment truth is a separate statement.
     */
    @Test
    void anUnknownGuardStateDropsTheGuardButKeepsTheRow() {
        CurtailmentStatusDto row = ingest("{\"units\":1,\"certified_units\":1,"
                + "\"control_enabled\":true,\"active\":false,\"export_guard\":{"
                + "\"limit_kw\":70,\"state\":\"tanzt\",\"reason\":\"…\",\"effective\":true}}");

        assertThat(row.exportGuard()).isNull();
        assertThat(row.units()).isEqualTo(1);
    }

    /**
     * A watchdog without its limit is not a limit statement - and the number is
     * exactly what the customer reads. Same for an implausible one.
     */
    @Test
    void aGuardWithoutAPlausibleLimitIsDropped() {
        assertThat(ingest("{\"units\":1,\"certified_units\":1,\"control_enabled\":true,"
                + "\"active\":false,\"export_guard\":{\"state\":\"regelt\","
                + "\"effective\":true}}").exportGuard()).isNull();

        setUp();
        assertThat(ingest("{\"units\":1,\"certified_units\":1,\"control_enabled\":true,"
                + "\"active\":false,\"export_guard\":{\"limit_kw\":-5,\"state\":\"regelt\","
                + "\"effective\":true}}").exportGuard()).isNull();
    }

    /**
     * Absent optional halves stay absent: no cap is null (never a fabricated 0),
     * and a complete reach (the device sends none when the cap reaches every
     * unit) reads as null rather than "".
     */
    @Test
    void anAbsentCapAndACompleteReachStayNull() {
        CurtailmentStatusDto row = ingest("{\"units\":2,\"certified_units\":2,"
                + "\"control_enabled\":true,\"active\":true,\"all_match\":true,"
                + "\"export_guard\":{\"limit_kw\":30,\"state\":\"regelt\",\"limiting\":true,"
                + "\"reason\":\"Die Einspeisung wird auf 30,0 kW begrenzt.\","
                + "\"effective\":true}}");

        ExportGuardDto g = row.exportGuard();
        assertThat(g).isNotNull();
        assertThat(g.capKw()).isNull();
        assertThat(g.reach()).isNull();
        assertThat(g.effective()).isTrue();
        assertThat(g.limiting()).isTrue();
    }

    /**
     * The device's OWN limit (Herzogau: Deye register 0x00E7 held an installer
     * cap of 33,0 kW while 70 kW were configured in the portal). All three parts
     * travel together - a value without its read time claims a freshness it does
     * not have, one without its register is a number without its origin.
     */
    @Test
    void theDevicesOwnExportLimitIsIngestedWithItsRegisterAndReadTime() {
        CurtailmentStatusDto row = ingest("{\"units\":2,\"certified_units\":0,"
                + "\"control_enabled\":true,\"active\":false,"
                + "\"device_export_limit_kw\":33.0,\"device_export_limit_register\":\"0x00e7\","
                + "\"device_export_limit_read_at\":\"2026-08-17T04:12:00Z\"}");

        DeviceExportLimitDto d = row.deviceExportLimit();
        assertThat(d).isNotNull();
        assertThat(d.limitKw()).isEqualTo(33.0);
        assertThat(d.register()).isEqualTo("0x00e7");
        assertThat(d.readAt()).isEqualTo(Instant.parse("2026-08-17T04:12:00Z"));
    }

    /** Any incomplete/garbage triple is dropped whole - never a half claim. */
    @Test
    void anIncompleteDeviceExportLimitIsDropped() {
        // no read time
        assertThat(ingest("{\"units\":1,\"certified_units\":0,\"control_enabled\":true,"
                + "\"active\":false,\"device_export_limit_kw\":33.0,"
                + "\"device_export_limit_register\":\"0x00e7\"}").deviceExportLimit()).isNull();

        setUp();
        // no register
        assertThat(ingest("{\"units\":1,\"certified_units\":0,\"control_enabled\":true,"
                + "\"active\":false,\"device_export_limit_kw\":33.0,"
                + "\"device_export_limit_read_at\":\"2026-08-17T04:12:00Z\"}")
                .deviceExportLimit()).isNull();

        setUp();
        // unparseable read time
        assertThat(ingest("{\"units\":1,\"certified_units\":0,\"control_enabled\":true,"
                + "\"active\":false,\"device_export_limit_kw\":33.0,"
                + "\"device_export_limit_register\":\"0x00e7\","
                + "\"device_export_limit_read_at\":\"gestern\"}").deviceExportLimit()).isNull();
    }

    /**
     * A device limit of exactly 0 kW is a VALUE ("this inverter may not feed in
     * at all"), not an absence - the same rule the applied cap already follows.
     */
    @Test
    void aZeroDeviceExportLimitIsAValueNotAnAbsence() {
        DeviceExportLimitDto d = ingest("{\"units\":1,\"certified_units\":0,"
                + "\"control_enabled\":true,\"active\":false,\"device_export_limit_kw\":0,"
                + "\"device_export_limit_register\":\"0x00e7\","
                + "\"device_export_limit_read_at\":\"2026-08-17T04:12:00Z\"}")
                .deviceExportLimit();

        assertThat(d).isNotNull();
        assertThat(d.limitKw()).isZero();
    }

    private void ingestRaw(String block) {
        String payload = "{\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\",\"curtailment\":" + block + "}";
        listener.handle(TOPIC, payload.getBytes(StandardCharsets.UTF_8));
    }
}
