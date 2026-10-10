package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.Eingetragen;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto.PersonKurz;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Konzept Nachweisen n1, Runde 2, Entscheid 5: „Trifft bei uns zurzeit nicht zu“ je Teil des Überblicks (Vertrag
 * energiemanagement 1.3, Vokabular {@code teil}). Ein Vermerk nennt den Satz, die Person, die es entschieden hat, und
 * wer es eingetragen hat; aufgehoben wird er einmal, danach ist er endgültig.
 */
public final class EnergiemanagementTeilVermerkDto {
    private EnergiemanagementTeilVermerkDto() {}

    /** Vermerken: Teil, Satz und „entschieden von“ Pflicht; ohne {@code entschieden_am} gilt heute. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String teil, String satz, UUID entschiedenVon, LocalDate entschiedenAm) {}

    /**
     * Ein Vermerk: {@code teil_wort} ist der Name des Teils (Vertrag {@code woerter.teil}); {@code aufgehoben} bleibt
     * {@code null}, solange er gilt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vermerk(UUID id, String teil, String teilWort, String satz, PersonKurz entschiedenVon,
            LocalDate entschiedenAm, Eingetragen eingetragen, Eingetragen aufgehoben) {}

    /**
     * {@code GET /api/v1/energiemanagement/teil-vermerke}: der Stichtag des Abrufs (in der Zeitzone des Unternehmens)
     * und die Vermerke, geltende zuerst in der Folge des Vokabulars {@code teil}, dann aufgehobene, jüngste zuerst.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vermerke(OffsetDateTime stichtag, List<Vermerk> vermerke) {}
}
