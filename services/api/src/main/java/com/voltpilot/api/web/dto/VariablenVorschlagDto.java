package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * Die Form von {@code GET /api/v1/kennzahlen/{id}/variablen-vorschlag} (UEMS AP-17 IP-11a, V4, W1). Vertrag:
 * {@code docs/contracts/v2/kennzahl-variablen-vorschlag.md}. Nur Lesen — ein Vorschlag übernimmt nichts.
 */
public final class VariablenVorschlagDto {
    private VariablenVorschlagDto() {}

    /**
     * {@code bezug} prozess · zaehler_messstellen · keiner; {@code satz} nur bei {@code keiner}. {@code variable_1} ist
     * der Nenner der heute geltenden Fassung, wenn er eine Bezugsgröße ist — sonst {@code null}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Vorschlag(KennzahlDto.WerteKennzahl kennzahl, String geltungArt, String bezug, String referenzperiode,
            List<Einsatz> einsaetze, @JsonProperty("variable_1") Variable variable1, List<Kandidat> kandidaten,
            List<OhneZahl> ohneZahl, String satz) {}

    /** Ein Energieeinsatz, dessen Einflussgrößen gelesen wurden. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Einsatz(UUID id, String kennzeichen, String name, String traeger) {}

    /** Eine Bezugsgröße, wie der Vorschlag sie zeigt: Art, Einheit und ob Periodenwerte oder ein Kanal da sind. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Variable(UUID id, String kennzeichen, String name, String art, String wertart, String einheit,
            String periodeArt, boolean hatWerte, boolean hatKanal) {}

    /**
     * Ein Verweis (BZ-…) als Kandidat. {@code einfluss_art} ist die Art am Einsatz (produktion · betriebszeit · wetter ·
     * sonstige), {@code vorschlag} variable_1 · variable · statischer_faktor; {@code einsaetze} die Kennzeichen der
     * Einsätze, die ihn nennen. {@code abhaengigkeit} nur bei {@code variable}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Kandidat(Variable bezugsgroesse, String einflussArt, String vorschlag, List<String> einsaetze,
            Abhaengigkeit abhaengigkeit, String satz) {}

    /** G4 gegen Variable 1: r ungerundet, {@code grund} nur bei nicht_pruefbar. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Abhaengigkeit(String ergebnis, Double r, int paare, String grund, String gegen, BigDecimal schwelle) {}

    /** Ein Wortlaut am Einsatz: bleibt Freitext — „ohne Zahl — erst als Bezugsgröße erfassen“. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record OhneZahl(String wortlaut, String einflussArt, String einsatz, String satz) {}
}
