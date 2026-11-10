package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * „Vom Kunden lösen" (Konzept vp-plattform-admin-box-benutzer-konzept, Vertrag Abschnitt 3.5) -
 * Feldnamen wie Box verbinden E2, damit S4 (künftig) denselben Befund zeigen kann.
 */
public final class BoxLoesenDto {

    private BoxLoesenDto() {
    }

    public record AnmeldungDto(Instant zuletztAngefragtAm, Instant schluesselAbgeholtAm) {
    }

    public record FaktenDto(Instant verbundenAm, Instant herzschlagAm, Instant messwertAm, Instant meldungAm,
            AnmeldungDto anmeldung) {
    }

    /** {@code GET .../loesen}: das Urteil, nicht nur ob, sondern WORAN es hängt. */
    public record BefundDto(boolean loesbar, List<String> gruende, FaktenDto fakten) {
    }

    /** {@code POST .../loesen}: der Anlass ist Pflicht ({@code anlassText} nur bei "anderer_anlass"). */
    public record AnfrageDto(String anlass, String anlassText) {
    }

    public record ErgebnisDto(String externalRef, String anlass) {
    }
}
