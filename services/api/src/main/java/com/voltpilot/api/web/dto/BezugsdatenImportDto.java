package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Formen der Import-Vorschau der Bezugsdaten (UEMS AP-09 IP-12,
 * {@code POST /api/v1/bezugsdaten/importe/vorschau}).
 *
 * <p>snake_case wie der Bezugsdaten-Vertrag; die Zuordnung hat die Form {@code vorschau_zuordnung} der
 * Vektor-Datei, das Ergebnis die Felder der Regel {@code vorschau}. Beträge reisen als DEZIMALTEXT. Jeder
 * Befund reist mit seinem Kundensatz — die Fläche erfindet keinen zweiten.
 */
public final class BezugsdatenImportDto {
    private BezugsdatenImportDto() {}

    // ------------------------------------------------------------------ Anfrage

    /** Der Teil {@code zuordnung}: C3. Unbekannte Felder sind 400 {@code anfrage_ungueltig}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zuordnung(
            Csv csv,
            Spalten spalten,
            String deutung,
            String zahlformat,
            String einheit,
            String bezugsgroesse,
            Map<String, String> bezugTabelle,
            Map<String, String> synonyme) {}

    /** Was die Datei nicht selbst sagen soll: Kodierung, Trennzeichen, Kopfzeile — sonst erkennt der Leser. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Csv(String kodierung, String trennzeichen, Boolean kopfzeile) {}

    /** Die Spalten der Rollen, 1-basiert. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Spalten(Integer periode, Integer bis, Integer wert, Integer einheit, Integer bezug, Integer bemerkung) {}

    // ------------------------------------------------------------------ Antwort

    /**
     * Die Vorschau. Sie ist KEIN Import: {@code vorschau.status} ist immer {@code vorschau}, gespeichert wird nichts.
     * {@code vorschau.kennung} gehört {@code gueltig_bis} lang zu genau diesem Ergebnis.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschau(
            Kennung vorschau,
            BezugsdatenVorlageDto.Verweis vorlage,
            Datei datei,
            FruehererImport fruehererImport,
            List<Zeile> zeilen,
            @JsonProperty("import") Import importergebnis) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Kennung(
            String kennung,
            String status,
            OffsetDateTime ausgestelltAm,
            OffsetDateTime gueltigBis,
            String ergebnisFingerabdruck) {}

    /** Die Datei, wie der Leser sie gesehen hat — ihr Inhalt wird nicht aufbewahrt (E14), nur ihr Fingerabdruck. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Datei(
            String name,
            int bytes,
            String sha256,
            Befund befund,
            String zusatz,
            String zusatzSatz,
            Integer zeile,
            String kodierung,
            Boolean bom,
            String trennzeichen,
            Boolean kopfzeile,
            List<String> kopf,
            Integer spalten,
            Integer datenzeilen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record FruehererImport(String kennung, String status, OffsetDateTime am) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Befund(String befund, String satz, boolean hinweis) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Geliefert(String wert, String einheit) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bestand(String betrag, int fassung, String importKennung) {}

    /**
     * Eine beurteilte Datenzeile. {@code felder} sind zur Anzeige neutralisiert (C1). {@code schluessel} und
     * {@code fingerabdruck} stehen, sobald die Zeile die Stufe Schlüssel erreicht hat; die Periode als Tage mit
     * letztem Tag einschließlich, ein Stand als Zeitpunkt.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zeile(
            int nr,
            List<String> felder,
            String bezugsgroesse,
            UUID bezugsgroesseId,
            String schluessel,
            LocalDate periodeVon,
            LocalDate periodeBis,
            OffsetDateTime zeitpunkt,
            String betrag,
            String einheit,
            Geliefert geliefert,
            String urteil,
            List<Befund> befunde,
            String fingerabdruck,
            Bestand bestand) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zaehler(
            int zeilen, int neu, int wiederholung, int konflikt, int berichtigung, int uebersprungen, int abgelehnt,
            int mitHinweis) {}

    /** Was die Regel {@code import} über diese Zeilen sagt: welcher Status und was eine Übernahme schriebe. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Import(
            String status,
            Zaehler zaehler,
            boolean uebernahmeMoeglich,
            boolean importDatensatz,
            String bestaetigung,
            int aenderungen,
            List<Befund> befunde) {}
}
