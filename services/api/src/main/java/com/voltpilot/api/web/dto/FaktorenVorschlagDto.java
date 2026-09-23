package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * {@code GET /api/v1/kennzahlen/{id}/faktoren-vorschlag} (UEMS AP-17 IP-16a, V3, E6 = A): die statischen Faktoren,
 * die die Struktur der Geltung einer Kennzahl an einem Stichtag vorschlägt. Ein Vorschlag — nichts davon ist
 * gespeichert; die Liste an der Fassung mit der Kopie zum Freigabetag baut IP-16b. Vertrag:
 * {@code docs/contracts/v2/bezugsbasis.md} §14.
 */
public final class FaktorenVorschlagDto {

    private FaktorenVorschlagDto() {}

    /** Die Antwort: Kennzahl, Geltung, Stichtag, die Kandidaten und die Fläche der Geltung als Summe. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschlag(
            UUID kennzahlId,
            String kennzeichen,
            String geltungArt,
            UUID geltungId,
            String geltungName,
            LocalDate stichtag,
            List<Faktor> faktoren,
            FlaecheDerGeltung flaeche,
            String hinweis) {}

    /**
     * Ein Kandidat: {@code art} aus dem Vokabular {@code faktor_art} (ohne {@code wortlaut} — den schreibt der Kunde);
     * {@code wert} und {@code einheit} nur bei der Fläche, sonst ist der Faktor ein Verweis ohne Zahl.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Faktor(
            String art,
            UUID objektId,
            String kennung,
            String bezeichnung,
            Integer wert,
            String einheit,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            String satz) {}

    /**
     * Die Fläche der Geltung als Summe der Flächen-Kandidaten — {@code wert} {@code null}, sobald einem Objekt der
     * Geltung die Fläche am Stichtag fehlt ({@code ohne_flaeche}); nie 0, nie eine Teilsumme.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FlaecheDerGeltung(
            Integer wert,
            String einheit,
            List<String> objekte,
            List<String> ohneFlaeche,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            String satz) {}
}
