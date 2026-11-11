package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * „Endgültig löschen" einer ausgebauten Box (vp-box-endgueltig-loeschen) - der Befund nennt die
 * Datenarten, nicht nur ob (eine Ablehnung ohne Liste ist eine Sackgasse, wie {@code BoxLoesenDto}).
 */
public final class BoxEndgueltigDto {

    private BoxEndgueltigDto() {
    }

    public record FaktenDto(Instant verbundenAm, Instant ausgebautAm, String tenantName, String siteName) {
    }

    /** {@code GET .../endgueltig-loeschen}: das Urteil samt der Datenarten, an denen es hängt. */
    public record BefundDto(UUID deviceId, boolean loeschbar, List<String> daten, FaktenDto fakten) {
    }

    /** {@code POST .../endgueltig-loeschen}: GENAU die Box aus dem Befund, nie „die Referenz". */
    public record AnfrageDto(UUID deviceId) {
    }

    public record ErgebnisDto(String externalRef, UUID deviceId, Instant geloeschtAm, boolean bereitsGeloescht) {
    }
}
