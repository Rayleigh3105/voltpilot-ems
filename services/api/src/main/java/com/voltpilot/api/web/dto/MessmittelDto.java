package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * AP-16 IP-15 (G1–G3): die Messmittel-Angaben eines Einbaus. Ohne Angabe steht {@code nicht_erhoben} —
 * nie ein erfundener Wert, nie eine gerechnete Genauigkeit der Messkette.
 */
public final class MessmittelDto {
    private MessmittelDto() {}

    /** PUT: die ganze Angabe; was fehlt, ist nicht erhoben. {@code wandler} nennt nur die geänderten Fassungen. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eintrag(String genauigkeitsklasse, String pruefungsart, LocalDate pruefungAm,
            LocalDate pruefungGueltigBis, BelegEintrag beleg, List<WandlerEintrag> wandler) {}

    /** Der Beleg als Verweis (G2): nur Bezeichnung, Ablage und die im Portal gebildete SHA-256. */
    public record BelegEintrag(String bezeichnung, String ablage, String sha256) {}

    /** Die Klasse an einer Wandler-Fassung dieses Einbaus; {@code null} = nicht erhoben. */
    public record WandlerEintrag(UUID fassung, String klasse) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Angaben(UUID geraetId, String kennzeichen, String einbauKennzeichen, String zustand,
            String genauigkeitsklasse, String pruefungsart, LocalDate pruefungAm, LocalDate pruefungGueltigBis,
            Beleg beleg, List<Wandler> wandler, List<Herstellerangabe> lautHersteller) {}

    /** G4: Katalog-Angabe je Geräte-/Kartentyp; ausdrücklich getrennt von {@link Angaben#genauigkeitsklasse()}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Herstellerangabe(String zielArt, UUID ziel, String bezeichnung, String hersteller, String modell,
            String zustand, String klasse, String wert, String bezug, String fundstelle, String sourceUrl,
            String sourceSha256) {}

    /** Person und Zeitpunkt sind die des Eintragens des Belegs, nicht der Datei. */
    public record Beleg(String bezeichnung, String ablage, String sha256, ProtokollAkteur person,
            Instant zeitpunkt) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wandler(UUID fassung, String art, JsonNode wert, Instant gueltigAb, Instant gueltigBis,
            String klasse, String zustand) {}
}
