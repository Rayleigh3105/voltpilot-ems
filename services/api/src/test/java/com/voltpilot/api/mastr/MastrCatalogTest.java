package com.voltpilot.api.mastr;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Every catalog id from the feasibility report's verified tables maps to the
 * agreed degrees; ids without a single-plane meaning (Ost-West, nachgeführt)
 * and unknown ids yield null degrees (the forecaster's defaults then apply).
 */
class MastrCatalogTest {

    @Test
    void everyAzimuthCatalogIdMapsToTheReportsDegrees() {
        Map<Integer, String> expected = Map.of(
                695, "0", 696, "45", 697, "90", 698, "135", 699, "180",
                700, "225", 701, "270", 702, "315");
        expected.forEach((id, deg) -> assertThat(MastrCatalog.azimuthDegrees(id))
                .as("azimuth id %s", id)
                .isEqualByComparingTo(new BigDecimal(deg)));
    }

    @Test
    void trackingAndOstWestKeepLabelsButNoDegrees() {
        assertThat(MastrCatalog.azimuthDegrees(703)).isNull();
        assertThat(MastrCatalog.azimuthLabel(703)).isEqualTo("nachgeführt");
        assertThat(MastrCatalog.azimuthDegrees(704)).isNull();
        assertThat(MastrCatalog.azimuthLabel(704)).isEqualTo("Ost-West");
    }

    @Test
    void everyTiltCatalogIdMapsToTheBinMidpoint() {
        Map<Integer, String> expected = Map.of(
                810, "12.5", 809, "30", 808, "50", 807, "75", 806, "90");
        expected.forEach((id, deg) -> assertThat(MastrCatalog.tiltDegrees(id))
                .as("tilt id %s", id)
                .isEqualByComparingTo(new BigDecimal(deg)));
        assertThat(MastrCatalog.tiltDegrees(811)).isNull();
        assertThat(MastrCatalog.tiltLabel(811)).isEqualTo("nachgeführt");
    }

    @Test
    void webdienstEnumNamesMapToTheSameCatalogIdsAsTheJsonBackend() {
        Map<String, Integer> azimuth = Map.ofEntries(
                Map.entry("Nord", 695), Map.entry("NordOst", 696), Map.entry("Ost", 697),
                Map.entry("SuedOst", 698), Map.entry("Sued", 699), Map.entry("SuedWest", 700),
                Map.entry("West", 701), Map.entry("NordWest", 702), Map.entry("Nachgefuehrt", 703),
                Map.entry("OstWest", 704));
        azimuth.forEach((name, id) -> assertThat(MastrCatalog.azimuthCatalogIdForEnumName(name))
                .as("azimuth enum %s", name).isEqualTo(id));
        assertThat(MastrCatalog.azimuthCatalogIdForEnumName("None")).isNull();
        assertThat(MastrCatalog.azimuthCatalogIdForEnumName(null)).isNull();

        Map<String, Integer> tilt = Map.of(
                "Grad5Bis20", 810, "Grad21Bis40", 809, "Grad41Bis60", 808,
                "Grad61Bis89", 807, "Grad90", 806, "Nachgefuehrt", 811);
        tilt.forEach((name, id) -> assertThat(MastrCatalog.tiltCatalogIdForEnumName(name))
                .as("tilt enum %s", name).isEqualTo(id));
        assertThat(MastrCatalog.tiltCatalogIdForEnumName(null)).isNull();
    }

    @Test
    void unter5TiltBucketGetsASyntheticIdWithTheRightDegrees() {
        // N2: the webdienst's "unter 5 Grad" bucket has no observed numeric
        // catalog id; MastrCatalog mints its own (negative, never collides
        // with a real id from the public JSON backend).
        Integer id = MastrCatalog.tiltCatalogIdForEnumName("Unter5");
        assertThat(id).isNotNull();
        assertThat(id).isNegative();
        assertThat(MastrCatalog.tiltDegrees(id)).isEqualByComparingTo(new BigDecimal("2.5"));
        assertThat(MastrCatalog.tiltLabel(id)).isEqualTo("unter 5 Grad");
    }

    @Test
    void unknownIdsYieldNullEverywhere() {
        assertThat(MastrCatalog.azimuthDegrees(999999)).isNull();
        assertThat(MastrCatalog.azimuthLabel(999999)).isNull();
        assertThat(MastrCatalog.tiltDegrees(999999)).isNull();
        assertThat(MastrCatalog.tiltLabel(999999)).isNull();
        assertThat(MastrCatalog.batteryTechnologyLabel(999999)).isNull();
        assertThat(MastrCatalog.azimuthDegrees(null)).isNull();
        assertThat(MastrCatalog.tiltDegrees(null)).isNull();
    }

    @Test
    void batteryTechnologyLabels() {
        assertThat(MastrCatalog.batteryTechnologyLabel(727)).isEqualTo("Lithium-Batterie");
        assertThat(MastrCatalog.batteryTechnologyLabel(728)).isEqualTo("Blei-Batterie");
        assertThat(MastrCatalog.batteryTechnologyLabel(732)).isEqualTo("Sonstige Batterie");
    }
}
