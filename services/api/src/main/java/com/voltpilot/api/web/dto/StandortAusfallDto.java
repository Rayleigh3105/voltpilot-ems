package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** Die belegten offenen Ausfälle eines Standorts (UEMS AP-06 IP-17). */
public final class StandortAusfallDto {

    private StandortAusfallDto() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ausfall(UUID standortId, int boxenGesamt, int boxenAusgefallen,
            int messstellenUnvollstaendig, List<Box> boxen, List<Messstelle> messstellen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Box(UUID id, String name, OffsetDateTime seit, List<UUID> anlagen) {}

    /**
     * {@code box} und {@code seit} stehen nur an gemessenen Messstellen, deren laufende Quelle
     * ein offenes, als {@code box_meldet_sich_nicht} festgehaltenes Datenlücken-Ereignis trägt.
     * Berechnete Messstellen nennen ausschließlich ihre fehlenden Eingänge.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messstelle(UUID id, String kennzeichen, String name, String art,
            OffsetDateTime seit, UUID boxId, String box, List<String> fehlt) {}
}
