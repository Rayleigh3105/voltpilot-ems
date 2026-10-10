package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/** KR1: Dezimalschwellen als Vertragsstrings, Monate als Ganzzahlen. K4 bleibt ohne Schwelle. */
public final class BewertungKriterienDto {
    private BewertungKriterienDto() {}
    public record Speichern(JsonNode werte, String begruendung) {}
    public record Entscheidung(String begruendung) {}
    public record Kriterium(String kennung, JsonNode schwelle, String einheit, String vergleich) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(int fassung, JsonNode werte, List<Kriterium> kriterien, String herkunft,
            LocalDate gueltigAb, String begruendung, ProtokollAkteur akteur, boolean vieraugen,
            String freigabeStatus, ProtokollAkteur entschiedenVon, Instant entschiedenAm,
            String entscheidungsBegruendung, Instant createdAt, Instant aufgehobenAm) {}
    public record Historie(List<Fassung> fassungen) {}
}
