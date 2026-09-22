package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** AP-16 IP-14: gemessene und berechnete Messstellen eines Prozesses samt reinen P4-Hinweisen. */
public final class ProzessMessstellenDto {
    private ProzessMessstellenDto() {}

    public record Verweis(UUID id, String kennzeichen, String name) {}

    public record Messstelle(UUID id, String kennzeichen, String name) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Hinweis(String code, Messstelle summe, Messstelle messstelle, List<Verweis> prozesse,
            boolean ueberVerteilung, String verteilung, String anteilProzent) {}

    public record Antwort(Verweis prozess, LocalDate am, List<Messstelle> gemessen,
            List<Messstelle> berechnet, List<Hinweis> hinweise) {}
}
