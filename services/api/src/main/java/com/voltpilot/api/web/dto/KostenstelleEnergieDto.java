package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Antwort der Kostenstellen-Sicht (UEMS AP-10 IP-11, {@code GET /api/v1/unternehmen/kostenstellen/{id}/energie}) —
 * snake_case wie die Bilanz-Schnittstelle.
 *
 * <p><b>Jedes Feld steht immer da, auch leer ({@code null}).</b> {@code null} heißt „keine Menge“ und nie 0 — der
 * {@code grund} sagt, warum. {@code nicht_verteilt} gehört KEINER Kostenstelle und zählt in {@code summe} nie mit.
 */
public final class KostenstelleEnergieDto {
    private KostenstelleEnergieDto() {}

    /**
     * @param version die angefragte Version ({@code null} = die neueste je Tag); {@code n} = je Tag die höchste
     *     Version bis n — mit 1 die Zahlen, wie sie vor jeder Korrektur galten
     * @param berechnetAm wann diese Sicht gebildet wurde — verteilte Werte werden nie gespeichert
     * @param doppelzaehlung welcher Posten in welchem bereits enthalten ist — eine Warnung NEBEN den Blöcken; sie ändert
     *     keine Zahl (Captain-Entscheid 14.09.2026), das letzte Feld
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Energie(
            Kostenstelle kostenstelle,
            String periode,
            LocalDate am,
            LocalDate von,
            LocalDate bis,
            String zeitzone,
            Integer version,
            String berechnetAm,
            Block gemessen,
            Block verteilt,
            Block berechnet,
            Block summe,
            Block nichtVerteilt,
            Doppelzaehlung doppelzaehlung) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Kostenstelle(UUID id, String kennzeichen, String name, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /**
     * Eine Herkunft (oder die Summe der drei): {@code menge}/{@code einheit}/{@code zustand} nur bei GENAU einer Größe;
     * {@code grund} {@code keine_zuordnung} (keine Posten) oder {@code groessen_gemischt} (je Größe eine Summe).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Block(BigDecimal menge, String einheit, String zustand, String grund, List<Summe> summen,
            List<Posten> posten) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Summe(String groesse, String richtung, String einheit, BigDecimal menge, String zustand,
            Integer abdeckungProzent, int vorhanden, int gesamt, List<String> fehlend) {}

    /**
     * Eine Messstelle in einer Herkunft.
     *
     * @param herkunft die Hülle {@code {satz, fehlt}} nach {@code bilanzwert-herkunft.schema.json} (Art
     *     {@code verteilt}); bei {@code nicht_verteilt} {@code null} — dort gibt es keine Verteilung; die Rechnung
     *     einer berechneten Messstelle steht je Tag an {@code tage[].herkunft}
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Posten(MessstelleRef messstelle, String groesse, String richtung, String einheit, BigDecimal menge,
            String zustand, Integer abdeckungProzent, int version, List<String> kennzeichen, List<Integer> fassungen,
            List<String> fehlend, List<Tag> tage, Map<String, Object> herkunft) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record MessstelleRef(UUID id, String kennzeichen, String name, String art) {}

    /**
     * Ein Tagesanteil: der Tageswert der Quelle, der Anteil DIESES Tages und die Menge daraus.
     *
     * @param herkunft die Hülle {@code {satz, fehlt}} (Art {@code berechnet}, AP-10 IP-12) am Tageswert einer
     *     BERECHNETEN Quelle in der gezeigten Version; {@code null} bei einer gemessenen Quelle und an einem Tag ohne
     *     gespeicherten Tageswert
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Tag(LocalDate tag, BigDecimal anteilProzent, BigDecimal quelleMenge, BigDecimal menge,
            String zustand, Integer abdeckungProzent, int version, String grund, Map<String, Object> herkunft) {}

    /**
     * Die Warnung vor doppelter Zählung: {@code enthalten} je Paar (Teil in Summe) mit Umfang und Tagen,
     * {@code nicht_pruefbar} je Posten, dessen Formel im Kreis führt. Beide Listen leer = keine Überdeckung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Doppelzaehlung(List<Enthalten> enthalten, List<NichtPruefbar> nichtPruefbar) {}

    /**
     * @param umfang {@code ganz} oder {@code teilweise} — nie eine Menge
     * @param kette der Weg durch die Formeln, die Summe zuerst, der Teil zuletzt
     * @param satz der Kundensatz aus {@code verteilung-vectors.json} ({@code doppelt_enthalten…})
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Enthalten(String teil, String summe, String umfang, List<String> kette, List<Zeitraum> zeitraeume,
            String satz) {}

    /** Tage, der letzte einschließlich. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Zeitraum(LocalDate von, LocalDate bis) {}

    /** @param grund {@code formel_kreis} oder {@code haengt_an_kreis} */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record NichtPruefbar(String messstelle, String grund, List<String> kette, String satz) {}
}
