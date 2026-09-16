package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** Vertragsformen der kundenbereichsweiten Zuordnungs-Vorlagen (UEMS AP-09 IP-14, E12). */
public final class BezugsdatenVorlageDto {
    private BezugsdatenVorlageDto() {}

    /** Ohne {@code vorlage_id} entsteht Fassung 1; mit ID die nächste unveränderliche Fassung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anfrage(UUID vorlageId, String name, BezugsdatenImportDto.Zuordnung zuordnung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Urheber(String name, String rolle, String art) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorlage(
            UUID vorlageId,
            int fassung,
            String name,
            BezugsdatenImportDto.Zuordnung zuordnung,
            Urheber urheber,
            OffsetDateTime erstelltAm) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(List<Vorlage> vorlagen) {}

    /** Der Beleg an Vorschau und Import: genau diese Vorlage in genau dieser Fassung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verweis(UUID vorlageId, int fassung, String name) {}
}
