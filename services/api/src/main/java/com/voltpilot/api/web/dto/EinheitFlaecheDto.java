package com.voltpilot.api.web.dto;

import java.math.BigDecimal;

/**
 * One roof face of a PV unit (S1/S3, vp-mastr-mehrere-einheiten-konzept
 * Abschnitt 5.1): direction, tilt, and its share of the unit's kWp. An
 * Ost-West unit has two of these; most units have exactly one.
 */
public record EinheitFlaecheDto(
        BigDecimal richtungGrad,
        BigDecimal neigungGrad,
        BigDecimal anteilKwp,
        Integer module,
        String quelle) {
}
