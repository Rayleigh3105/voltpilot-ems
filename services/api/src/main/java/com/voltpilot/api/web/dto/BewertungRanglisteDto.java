package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** AP-16 IP-9: Dezimaltexte, unbekannt bleibt null; keine Kriterien oder Einstufungen. */
public final class BewertungRanglisteDto {
    private BewertungRanglisteDto() {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Rangliste(LocalDate von, LocalDate bis, UUID umfangId, Integer umfangFassung,
            boolean teilansicht, Nenner nenner, String zugeordnet, String rest, String abdeckungProzent,
            String zustand, List<Anlage> anlagen, List<Einsatz> einsaetze, List<Einsatz> weitereTraeger) {}
    public record Nenner(String wert, String einheit, int vorhanden, int gesamt, String anlagen, String zustand) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlage(UUID id, String name, LocalDate ab, String nenner, String zugeordnet,
            String rest, String restAnteilProzent, String zustand) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Einsatz(UUID id, String kennzeichen, String name, UUID prozessId, String traeger,
            String einheit, String menge, String zustand, String ersatz, String ersatzProzent,
            String anteilProzent, String anteilZustand, Integer rang, List<Messstelle> messstellen) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messstelle(UUID id, String kennzeichen, UUID anlageId, String einheit, String menge,
            String zustand, String ersatz, String ersatzProzent, MessstelleWerteDto.Werte monatswerte) {}
}
