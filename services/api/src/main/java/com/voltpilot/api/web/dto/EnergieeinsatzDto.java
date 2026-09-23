package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** UEMS AP-16 IP-4: Energieeinsätze, ohne eigene Mengenbildung oder Einstufung. */
public final class EnergieeinsatzDto {
    private EnergieeinsatzDto() {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(UUID prozessId, String traeger, String name, String wortlaut,
            String verbraucherWortlaut, String verantwortlichSub, LocalDate gueltigAb, List<Einfluss> einflussgroessen) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bearbeiten(String name, String wortlaut, String verbraucherWortlaut) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Beenden(LocalDate gueltigBis, String grund) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record VerantwortlicherSetzen(String verantwortlichSub) {}
    public record EinfluesseSetzen(List<Einfluss> einflussgroessen) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einfluss(UUID bezugsgroesseId,
            @JsonInclude(JsonInclude.Include.NON_NULL) Verweis bezugsgroesse,
            String wortlaut, String art) {}
    public record Verweis(UUID id, String kennzeichen, String name) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verantwortlicher(String sub, String name, String konto, String zustand, Instant ohneKontoSeit) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messstelle(UUID id, String kennzeichen, String name, String art, String traeger,
            List<MessstelleDto.OrtZuordnung> orte, String zustand, MessstelleWerteDto.Werte letzterMonat) {}
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einsatz(UUID id, String kennzeichen, Verweis prozess, String traeger, String name,
            String wortlaut, String verbraucherWortlaut, Verantwortlicher verantwortlich,
            List<Einfluss> einflussgroessen, List<Messstelle> messstellen, boolean keineWerte,
            LocalDate gueltigAb, LocalDate gueltigBis, Instant beendetAm, String beendetGrund) {}
    public record Liste(List<Einsatz> energieeinsaetze) {}
    public record Vorschlag(Verweis prozess, String traeger) {}
    public record Vorschlaege(List<Vorschlag> vorschlaege) {}
    public record Aenderung(long id, String art, JsonNode alt, JsonNode neu, ProtokollAkteur akteur, Instant zeit) {}
    public record Protokoll(List<Aenderung> aenderungen) {}
}
