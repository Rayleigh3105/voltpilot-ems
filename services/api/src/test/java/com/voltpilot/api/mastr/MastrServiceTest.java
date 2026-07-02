package com.voltpilot.api.mastr;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import com.voltpilot.api.web.dto.MastrPreviewDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;

/** Preview mapping: catalog decoding, honest nulls and honest German warnings. */
class MastrServiceTest {

    @Test
    void solarPreviewDecodesCatalogValues() throws Exception {
        MastrPreviewDto p = service(solarUnit(699, 809)).lookup("SEE966831669444");

        assertThat(p.kind()).isEqualTo("pv");
        assertThat(p.azimuthDeg()).isEqualByComparingTo(new BigDecimal("180"));
        assertThat(p.azimuthLabel()).isEqualTo("Süd");
        assertThat(p.tiltDeg()).isEqualByComparingTo(new BigDecimal("30"));
        assertThat(p.tiltLabel()).isEqualTo("21 - 40 Grad");
        assertThat(p.warnings()).isEmpty();
        assertThat(p.plz()).isEqualTo("89150");
    }

    @Test
    void ostWestKeepsTheLabelDropsDegreesAndWarns() throws Exception {
        MastrPreviewDto p = service(solarUnit(704, 809)).lookup("SEE966831669444");

        assertThat(p.azimuthDeg()).isNull();
        assertThat(p.azimuthLabel()).isEqualTo("Ost-West");
        assertThat(p.warnings()).hasSize(1);
        assertThat(p.warnings().get(0)).contains("Ost-West").contains("Standardwert");
    }

    @Test
    void unknownCatalogIdYieldsNullAndAWarning() throws Exception {
        MastrPreviewDto p = service(solarUnit(424242, 424242)).lookup("SEE966831669444");

        assertThat(p.azimuthDeg()).isNull();
        assertThat(p.tiltDeg()).isNull();
        assertThat(p.warnings()).hasSize(2);
        assertThat(p.warnings().get(0)).contains("Unbekannter Registerwert");
    }

    @Test
    void balkonkraftwerkWithoutOrientationHasNullsAndNoWarning() throws Exception {
        // Orientation is simply not collected for plug-in devices; that is not
        // a warning-worthy anomaly, the UI shows "nicht im Register hinterlegt".
        MastrPreviewDto p = service(solarUnit(null, null)).lookup("SEE966831669444");

        assertThat(p.azimuthDeg()).isNull();
        assertThat(p.azimuthLabel()).isNull();
        assertThat(p.tiltDeg()).isNull();
        assertThat(p.warnings()).isEmpty();
    }

    @Test
    void storagePreviewAssumesSymmetricChargingWhenTheSourceHasNone() throws Exception {
        MastrPreviewDto p = service(storageUnit(null)).lookup("SEE972142227037");

        assertThat(p.kind()).isEqualTo("storage");
        assertThat(p.storageCapacityKwh()).isEqualByComparingTo(new BigDecimal("12.8"));
        assertThat(p.powerKw()).isEqualByComparingTo(new BigDecimal("8.76"));
        assertThat(p.chargePowerKw()).isEqualByComparingTo(new BigDecimal("8.76"));
        assertThat(p.batteryTechnology()).isEqualTo("Lithium-Batterie");
        assertThat(p.warnings()).hasSize(1);
        assertThat(p.warnings().get(0)).contains("Ladeleistung");
    }

    @Test
    void storagePreviewPrefersTheRealChargingPower() throws Exception {
        MastrPreviewDto p = service(storageUnit(new BigDecimal("8.20"))).lookup("SEE972142227037");

        assertThat(p.chargePowerKw()).isEqualByComparingTo(new BigDecimal("8.20"));
        assertThat(p.warnings()).isEmpty();
    }

    @Test
    void invalidNumberFailsBeforeAnyRegistryCall() {
        MastrService service = new MastrService(unit -> {
            throw new AssertionError("must not be called");
        });
        RegistryLookupException e = catchThrowableOfType(
                () -> service.lookup("SSE933136239009"), RegistryLookupException.class);
        assertThat(e.reason()).isEqualTo(RegistryLookupException.Reason.INVALID_NUMBER);
    }

    // ---- helpers ---------------------------------------------------------------

    private MastrService service(MastrUnit unit) {
        return new MastrService(number -> unit);
    }

    private MastrUnit solarUnit(Integer azimuthId, Integer tiltId) {
        return new MastrUnit("SEE966831669444", MastrUnit.Kind.SOLAR, "PV Anlage", "In Betrieb",
                "Gebäudesolaranlage", new BigDecimal("6.05"), new BigDecimal("6.0"), 13,
                azimuthId, tiltId, LocalDate.of(2026, 7, 1), null, null, null,
                "89150", "Laichingen", null);
    }

    private MastrUnit storageUnit(BigDecimal chargeKw) {
        return new MastrUnit("SEE972142227037", MastrUnit.Kind.STORAGE, null, "In Betrieb",
                "Batterie", new BigDecimal("8.76"), new BigDecimal("8.76"), null,
                null, null, LocalDate.of(2026, 7, 1), new BigDecimal("12.8"), chargeKw, 727,
                "79674", "Todtnau", null);
    }
}
