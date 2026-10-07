package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Konzept Nachweisen n1, Entscheid 7: die Antworten der Routen {@code …/energiemanagement/mappen} (openapi
 * {@code EnergiemanagementMappe…}). Eine Mappe nennt, wofür und was hineinging, ihre beiden Dateien mit Prüfsumme und
 * wie lange sie noch abrufbar ist ({@code abrufbar_tage}, gezählt in echter Zeit; 0 = abgelaufen).
 */
public final class EnergiemanagementMappeDto {
    private EnergiemanagementMappeDto() {}

    /** Die Anfrage: Anlass (Vokabular {@code mappe_anlass}), ab welchem Tag ({@code null} = alles), Gruppen, offene Teile. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(String anlass, String von, List<String> gruppen, List<String> offen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Erstellt(String name, Instant am) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Mappe(UUID id, String titel, String anlass, String anlassWort, LocalDate von, LocalDate bis,
            OffsetDateTime stichtag, List<String> gruppen, List<String> gruppenWoerter, List<String> offen,
            List<String> offenWoerter, int eintraege, int gilt, String dateiTitel, String dateiName, String pdfPruefsumme,
            String csvPruefsumme, boolean abrufbar, int abrufbarTage, int aufbewahrungTage, int abrufe, Erstellt erstellt) {}

    public record Mappen(List<Mappe> mappen) {}
}
