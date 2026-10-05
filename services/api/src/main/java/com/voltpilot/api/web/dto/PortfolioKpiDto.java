package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Die Portfolio-Kennzahlen des Kachel-Rasters der UEMS-Übersicht (Konzept
 * {@code data/vp-portfolio-konzept2-p2} §4.2): Leitkennzahl (EnPI gegen Ziel),
 * Energieverbrauch (Netzbezug) gegen Vorjahr, Lastspitze gegen vereinbarte
 * Leistung und Energiekosten gegen Vorjahr - aggregiert über die sichtbaren
 * Anlagen des Mandanten (RLS), für den letzten abgeschlossenen Monat.
 *
 * <p><b>Ehrlichkeit (AGENTS.md „Fehlend ist keine Null"):</b> jede Menge/jeder
 * Betrag ist {@code null}, wenn keine Quelle ihn trägt - nie eine erfundene 0.
 * Netzbezug/Kosten kommen aus der UEMS-Ablesewelt (Vertrags-Zwillinge, dieselbe
 * Quelle wie die Energiebilanz), die Lastspitze aus der maßgeblichen 15-min-
 * Quelle (Telemetrie-Netzbezug); fehlt sie, bleibt {@code kw} null statt 0. Die
 * Leitkennzahl ist der EnPI mit freigegebener Bezugsbasis UND Energieziel; gibt
 * es keinen, ist {@code leit} null und das Portal zeigt den Datenlage-Fallback.
 */
@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record PortfolioKpiDto(
        Periode periode,
        Verbrauch verbrauch,
        Kosten kosten,
        Lastspitze lastspitze,
        @JsonInclude(JsonInclude.Include.NON_NULL) Leitkennzahl leit) {

    /** Der ausgewertete Zeitraum: der letzte abgeschlossene Berliner Monat. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Periode(LocalDate von, LocalDate bis, int jahr, int monat) {}

    /**
     * Energieverbrauch = Netzbezug (kWh) über die Anlagen, dieser Monat und der
     * gleiche Monat im Vorjahr. Ein Feld ist {@code null}, wenn keine Anlage für
     * den Zeitraum einen gemessenen Netzbezug trägt (nie 0). {@code vollstaendig}
     * ist false, sobald eine beitragende Anlage nur einen Teilmonat gemeldet hat.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verbrauch(BigDecimal kwh, BigDecimal kwhVorjahr, boolean vollstaendig) {}

    /**
     * Energiekosten = Σ(Netzbezug je Anlage × Arbeitspreis je Anlage), dieser
     * Monat und Vorjahr. {@code tarifHinterlegt} ist false, wenn für keine
     * beitragende Anlage ein Arbeitspreis hinterlegt ist - dann sind die Beträge
     * null und das Portal zeigt „kein Tarif hinterlegt" statt 0 €.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kosten(BigDecimal eur, BigDecimal eurVorjahr, boolean tarifHinterlegt) {}

    /**
     * Lastspitze: die höchste gemessene 15-min-Netzbezugsleistung (kW) einer
     * Anlage im Monat und die vereinbarte Leistung IHRER Anlage. {@code kw} ist
     * {@code null}, wenn keine 15-min-Quelle einen Netzbezug trägt (die Anlagen
     * speisen nur ein / es liegen keine Lastdaten vor) - nie 0. {@code anteilProzent}
     * ist der Balken (Spitze ÷ vereinbart), null ohne beide Werte.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Lastspitze(BigDecimal kw, BigDecimal vereinbartKw, Integer anteilProzent, String anlage) {}

    /**
     * Die Leitkennzahl (EnPI) gegen ihr Ziel: der jüngste Kennzahlwert mit
     * Einheit und Periode, das Ziel als Prozent gegen die Bezugsbasis (Wortlaut
     * aus dem Energieziel), der Trend zum Vormonat und das Urteil gegen die
     * Bezugsbasis über die Zielperiode. {@code wert}/{@code trendProzent} sind
     * ungerundet; das Portal rundet zur Anzeige (AP-08).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Leitkennzahl(
            String kennzeichen,
            String name,
            BigDecimal wert,
            String einheit,
            int jahr,
            int monat,
            String zustand,
            BigDecimal zielProzent,
            String zielperiode,
            String zielWortlaut,
            @JsonInclude(JsonInclude.Include.NON_NULL) BigDecimal trendProzent,
            @JsonInclude(JsonInclude.Include.NON_NULL) String urteil) {}
}
