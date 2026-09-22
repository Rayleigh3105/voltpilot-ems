package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * AP-16 IP-17 (G5, E10 = A): der Monatsvergleich führend ↔ Vergleich je Vergleichsquelle mit ihrer Toleranz-Fassung.
 * Ein Befund nennt Abweichung und Toleranz — nie eine Ursache, nie einen Ersatz; kein Wert ändert sich.
 */
public final class VergleichToleranzDto {
    private VergleichToleranzDto() {}

    /** PUT: eine neue Fassung — Prozent je Monat (Text, höchstens zwei Nachkommastellen) und Begründung. */
    public record Eintrag(String prozent, String begruendung) {}

    /**
     * Eine Fassung. Fassung 1 ist der Startwert des Vertrags ({@code startwert}: ohne Person, ohne Begründung, gültig
     * ab dem Beginn der Vergleichsquelle); jede weitere gilt ab dem Monat ihres Eintrags.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Toleranz(int fassung, String prozent, boolean startwert, LocalDate giltAbMonat,
            String begruendung, ProtokollAkteur person, Instant eingetragenAm) {}

    /**
     * Ein Monat: beide Mengen, wie sie gespeichert sind, und das Ergebnis der Regel {@code monatsvergleich}
     * ({@code passt} · {@code abweichung} · {@code nicht_vergleichbar} mit {@code grund}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Monat(String monat, String fuehrend, String fuehrendZustand, String vergleich,
            String vergleichZustand, String zustand, String grund, String abweichungProzent,
            String toleranzProzent, int toleranzFassung, Boolean befund) {}

    /**
     * Eine Vergleichsquelle der Messstelle. {@code monatsvergleich}: {@code ja} nur an der Hauptgröße mit einer
     * Monatsmenge (Zählerstand, Differenzen, Integration, ohne Anteil) — sonst {@code ohne_monatsmenge} und keine
     * Monate.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vergleichsquelle(UUID quelleId, UUID entityId, String komponente, String kanal, String zweck,
            String groesse, String richtung, String herleitung, Instant gueltigAb, Instant gueltigBis,
            String monatsvergleich, Toleranz toleranz, List<Toleranz> fassungen, List<Monat> monate) {}

    /** Der Befund {@code abweichung_vergleichsquelle}: „Abweichung x % (Toleranz y %)“ — ohne Ursache. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Befund(String art, UUID quelleId, String monat, String abweichungProzent, String toleranzProzent,
            int toleranzFassung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vergleich(UUID messstelleId, String kennzeichen, String von, String bis, String einheit,
            List<Vergleichsquelle> vergleichsquellen, List<Befund> befunde) {}
}
