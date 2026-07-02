package com.voltpilot.api.mastr;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * One registry unit as fetched from MaStR, before catalog decoding - the
 * registry-neutral shape both sources (SOAP webservice / public JSON backend)
 * normalize into. Orientation/tilt/battery technology stay CATALOG IDS here;
 * {@link MastrCatalog} decodes them at the preview-mapping step. Every field
 * except {@code unitNumber}/{@code kind} is nullable: small residential units
 * are heavily masked and Balkonkraftwerke carry no orientation at all.
 */
public record MastrUnit(
        String unitNumber,
        Kind kind,
        String name,
        String operatingStatus,
        String plantTypeLabel,
        BigDecimal grossPowerKw,
        BigDecimal netPowerKw,
        Integer moduleCount,
        Integer azimuthCatalogId,
        Integer tiltCatalogId,
        LocalDate commissionedOn,
        BigDecimal storageCapacityKwh,
        BigDecimal chargePowerKw,
        Integer batteryTechnologyId,
        String postalCode,
        String city,
        String linkedUnitNumber) {

    /** Storage units are ALSO SEE-numbered; the registry data tells them apart. */
    public enum Kind { SOLAR, STORAGE }
}
