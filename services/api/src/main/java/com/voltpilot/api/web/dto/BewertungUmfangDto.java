package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** AP-16 U1/U2: Mengen und Bilanzabdeckung folgen erst mit IP-9. */
public final class BewertungUmfangDto {
    private BewertungUmfangDto() {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Speichern(LocalDate gueltigAb, List<UUID> standortIds, List<String> traeger,
            List<Ausschluss> ausschluesse, String begruendung) {}
    public record Ausschluss(String art, UUID verweis, String begruendung) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Traeger(String name, boolean mitAnteil) {}
    public record Anlage(UUID id, String name) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Standort(UUID id, String name, List<Anlage> anlagenImUmfang, int anzahlAnlagenImUmfang) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Umfang(UUID id, Integer fassung, LocalDate gueltigAb, LocalDate am,
            List<Standort> standorte, List<Traeger> traeger, List<Ausschluss> ausschluesse,
            List<Anlage> anlagenImUmfang, int anzahlAnlagenImUmfang, String nennerTraeger,
            String begruendung, ProtokollAkteur akteur, Instant createdAt, Instant aufgehobenAm,
            boolean teilansicht) {}
    public record Historie(List<Umfang> fassungen) {}
}
