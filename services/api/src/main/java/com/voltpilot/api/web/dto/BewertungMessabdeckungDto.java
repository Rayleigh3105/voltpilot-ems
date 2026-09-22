package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** AP-16 IP-13: Messabdeckung aus denselben Mengen wie die Rangliste; unbekannt bleibt null. */
public final class BewertungMessabdeckungDto {
    private BewertungMessabdeckungDto() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messabdeckung(LocalDate von, LocalDate bis, UUID umfangId, Integer umfangFassung,
            boolean teilansicht, Summe summe, List<Einsatz> jeEinsatz, List<Ort> jeOrt) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Summe(BewertungRanglisteDto.Nenner nenner, String gemessenZugeordnet,
            String abdeckungProzent, String k8, String ersatz, String ungemessen,
            String ungemessenProzent) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Einsatz(UUID id, String kennzeichen, String name, UUID prozessId, String traeger,
            String einheit, String menge, List<Messwert> gemessen, List<Plan> geplant,
            List<Messwert> ersatz, List<Rest> ungemessen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Ort(String art, UUID id, String kennzeichen, String name, String traeger,
            String einheit, List<Messwert> gemessen, List<Plan> geplant,
            List<Messwert> ersatz, Rest ungemessen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Messwert(UUID id, String kennzeichen, String ort, String menge, String einheit) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Plan(UUID messstelleId, String kennzeichen, String ort, LocalDate keineDatenquelleSeit,
            String messbedarf) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Rest(UUID anlageId, String anlage, String menge, String anteilProzent) {}
}
