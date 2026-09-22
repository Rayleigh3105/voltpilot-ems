package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.BewertungRanglisteDto.HerkunftEntwurf;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/** AP-16 IP-11: menschliche Einstufungs-Fassungen; der Herkunftsentwurf aus IP-10 wird eingefroren. */
public final class EnergieeinsatzEinstufungDto {
    private EnergieeinsatzEinstufungDto() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Speichern(String einstufung, String begruendung, List<String> grund,
            LocalDate gueltigAb, HerkunftEntwurf herkunft) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(int fassung, String einstufung, String begruendung, List<String> grund,
            JsonNode herkunft, LocalDate vorgeschlagenAb, LocalDate gueltigAb, LocalDate gueltigBis,
            boolean rueckwirkend, ProtokollAkteur akteur, boolean vieraugen, String freigabeStatus,
            ProtokollAkteur entschiedenVon, Instant entschiedenAm, Instant createdAt) {}

    public record Historie(List<Fassung> fassungen) {}
}
