package com.voltpilot.api.web.dto;

/**
 * One unit of a Lokations-Suche preview (S2, Abschnitt 5.3): the usual
 * registry preview, plus whether it is pre-selected for adoption.
 * {@code vorausgewaehlt} is {@code false} ONLY when the operator (ABR) is
 * known to differ from the unit the customer typed - the comparison itself
 * happens purely in memory at lookup time and is never persisted (Abschnitt
 * 4.5: Datenschutz). An unknown operator on either side stays pre-selected -
 * this never silently excludes on a guess.
 */
public record MastrLokationEinheitDto(
        MastrPreviewDto vorschau,
        boolean vorausgewaehlt,
        String grund) {
}
