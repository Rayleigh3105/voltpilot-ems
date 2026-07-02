package com.voltpilot.api.mastr;

import java.math.BigDecimal;
import java.util.Map;

/**
 * MaStR catalog-value decoding. The registry stores orientation, tilt and
 * battery technology as CATALOG IDS, not values; the SOAP API returns only the
 * ids and the public JSON backend returns ids plus display labels. These maps
 * were enumerated empirically against the live register (feasibility scout
 * voltpilot-mastr-scout-m1, 2026-07-02) and turn the ids into the degrees the
 * PV forecast model consumes ({@code PlantSpec}: azimuth clockwise from North,
 * 180 = due South; tilt = bin midpoint).
 *
 * <p>Ids that do NOT map to a single plane (Ost-West, nachgeführt/tracking)
 * keep a label but yield {@code null} degrees - the forecaster then falls back
 * to its defaults, and the portal shows the label honestly. Unknown ids also
 * yield {@code null} (registry catalogs can grow).
 */
public final class MastrCatalog {

    private MastrCatalog() {
    }

    /** Hauptausrichtung catalog id -> azimuth degrees (PlantSpec convention). */
    private static final Map<Integer, BigDecimal> AZIMUTH_DEG = Map.of(
            695, new BigDecimal("0"),    // Nord
            696, new BigDecimal("45"),   // Nord-Ost
            697, new BigDecimal("90"),   // Ost
            698, new BigDecimal("135"),  // Süd-Ost
            699, new BigDecimal("180"),  // Süd
            700, new BigDecimal("225"),  // Süd-West
            701, new BigDecimal("270"),  // West
            702, new BigDecimal("315")); // Nord-West

    private static final Map<Integer, String> AZIMUTH_LABEL = Map.of(
            695, "Nord",
            696, "Nord-Ost",
            697, "Ost",
            698, "Süd-Ost",
            699, "Süd",
            700, "Süd-West",
            701, "West",
            702, "Nord-West",
            703, "nachgeführt",
            704, "Ost-West");

    /** Hauptneigungswinkel catalog id -> tilt degrees (bin midpoint). */
    private static final Map<Integer, BigDecimal> TILT_DEG = Map.of(
            810, new BigDecimal("12.5"), // 5 - 20 Grad
            809, new BigDecimal("30"),   // 21 - 40 Grad
            808, new BigDecimal("50"),   // 41 - 60 Grad
            807, new BigDecimal("75"),   // 61 - 89 Grad
            806, new BigDecimal("90"));  // 90 Grad (vertikal)

    private static final Map<Integer, String> TILT_LABEL = Map.of(
            810, "5 - 20 Grad",
            809, "21 - 40 Grad",
            808, "41 - 60 Grad",
            807, "61 - 89 Grad",
            806, "90 Grad (vertikal)",
            811, "nachgeführt");

    private static final Map<Integer, String> BATTERY_TECH_LABEL = Map.of(
            727, "Lithium-Batterie",
            728, "Blei-Batterie",
            729, "Redox-Flow-Batterie",
            730, "Hochtemperaturbatterie",
            731, "Nickel-Batterie",
            732, "Sonstige Batterie");

    /** Art der Solaranlage - only the ids verified on real records are mapped. */
    private static final Map<Integer, String> SOLAR_TYPE_LABEL = Map.of(
            852, "Freiflächensolaranlage",
            853, "Gebäudesolaranlage",
            2484, "Steckerfertige Solaranlage (Balkonkraftwerk)");

    public static BigDecimal azimuthDegrees(Integer catalogId) {
        return catalogId == null ? null : AZIMUTH_DEG.get(catalogId);
    }

    public static String azimuthLabel(Integer catalogId) {
        return catalogId == null ? null : AZIMUTH_LABEL.get(catalogId);
    }

    public static BigDecimal tiltDegrees(Integer catalogId) {
        return catalogId == null ? null : TILT_DEG.get(catalogId);
    }

    public static String tiltLabel(Integer catalogId) {
        return catalogId == null ? null : TILT_LABEL.get(catalogId);
    }

    public static String batteryTechnologyLabel(Integer catalogId) {
        return catalogId == null ? null : BATTERY_TECH_LABEL.get(catalogId);
    }

    public static String solarTypeLabel(Integer catalogId) {
        return catalogId == null ? null : SOLAR_TYPE_LABEL.get(catalogId);
    }
}
