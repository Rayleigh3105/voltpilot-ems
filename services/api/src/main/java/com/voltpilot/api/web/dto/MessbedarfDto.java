package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** AP-16 IP-19, P1/P2: Messbedarf, Auflösung und unveränderliches Protokoll. */
public final class MessbedarfDto {
    private MessbedarfDto() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String wortlaut, String ort, String groesse, LocalDate frist) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bearbeiten(String wortlaut, String ort, String groesse, LocalDate frist) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einloesen(UUID messstelleId) {}
    public record Verwerfen(String begruendung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bedarf(UUID id, String kennzeichen, UUID energieeinsatzId, String wortlaut, String ort,
            String groesse, LocalDate frist, String zustand, Messstelle messstelle, String begruendung,
            ProtokollAkteur akteur, Instant angelegtAm, Instant geaendertAm) {}
    public record Messstelle(UUID id, String kennzeichen, String name) {}
    public record Liste(List<Bedarf> messbedarfe) {}

    public record Aenderung(long id, String art, JsonNode alt, JsonNode neu,
            ProtokollAkteur akteur, Instant zeit) {}
    public record Protokoll(List<Aenderung> aenderungen) {}
}
