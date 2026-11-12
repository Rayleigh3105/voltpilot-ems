package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * One registered unit of a site (S1/S2, vp-mastr-mehrere-einheiten-konzept
 * Abschnitt 5.1): the WIRKSAM (customer-confirmed) layer, plus whether the
 * register has since reported something different ({@code
 * abweichungVonRegister} - a hint, never a silent change). {@code
 * bestaetigtAm == null} marks a unit the background reconciliation found at
 * the same Lokation but the customer has not yet confirmed (E5: suggested
 * once, never silently adopted) - nothing computes from such a row.
 */
public record RegisterEinheitDto(
        UUID id,
        String art,
        String registry,
        String registryUnitId,
        String bezeichnung,
        LocalDate inbetriebnahme,
        BigDecimal leistungKwp,
        BigDecimal speicherKwh,
        BigDecimal speicherKw,
        Instant bestaetigtAm,
        Instant registryFetchedAt,
        boolean abweichungVonRegister,
        List<EinheitFlaecheDto> flaechen) {
}
