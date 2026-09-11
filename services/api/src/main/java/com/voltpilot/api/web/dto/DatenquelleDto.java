package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.probe.ProbeResult;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Datenquellen-Schnittstelle (UEMS AP-06 IP-3) unter
 * {@code /api/v1/sites/{siteId}/data-sources}. Die Wörter sind die des Vertrags
 * {@code docs/contracts/v2/data-source-assignment.md} §2 — auch in seiner Schreibweise
 * ({@code snake_case}: {@code geraete_ids}, {@code effective_from}, {@code vergleich_bestaetigt}),
 * wie die Messstellen-Schnittstelle ihren Vertrag. Zeitpunkte sind Instants (UTC),
 * Zuständigkeiten halboffen auf die Minute ({@code effective_to} gehört nicht dazu, {@code null}
 * = offen).
 */
public final class DatenquelleDto {

    private DatenquelleDto() {}

    /** Eine Box, wie ein Satz sie nennt: der Kundenname, sonst ihre Geräte-ID vom Aufkleber. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Box(UUID id, String name, UUID heimatAnlage) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zeitraum(Box box, Instant effectiveFrom, Instant effectiveTo) {}

    /**
     * Eine Datenquelle. {@code zustaendige_box} ist die Box, deren Zeitraum JETZT läuft —
     * {@code null}, wenn keine liest (Entwurf, Lücke oder erst geplant). Lebenszyklus und
     * „liefert Daten“ sind bewusst KEINE Felder: „aktiv“ ist eine Beobachtung aus dem
     * Herzschlag (IP-14) und wird hier nicht geraten.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Datenquelle(
            UUID id,
            String kennzeichen,
            String name,
            UUID anlage,
            String protokoll,
            String adresse,
            List<Integer> geraeteIds,
            String netz,
            boolean mehrereLeser,
            boolean steuerquelle,
            boolean vergleichsquelle,
            int kadenzS,
            Instant archiviertAm,
            Box zustaendigeBox,
            List<Zeitraum> zeitraeume) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Liste(List<Datenquelle> datenquellen) {}

    /**
     * {@code POST}: eine neue Quelle (Entwurf). {@code device_id} ist die gewählte Box — mit ihr
     * prüft die Schnittstelle schon beim Anlegen die Regeln, die ohne Prüfung von der Box
     * entscheidbar sind (Eindeutigkeit je Box, Doppel-Lesen), damit kein Entwurf entsteht, den
     * keine Box je lesen dürfte. {@code vergleich_bestaetigt} beantwortet die Rückfrage
     * „als Vergleichsquelle anlegen?“.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlegen(
            String name,
            String protokoll,
            String adresse,
            List<Integer> geraeteIds,
            String netz,
            Boolean mehrereLeser,
            Boolean steuerquelle,
            Integer kadenzS,
            UUID deviceId,
            Boolean vergleichBestaetigt) {}

    /**
     * {@code PUT}: die bearbeitbaren Felder, ganz (fehlend = leer bzw. nein). Protokoll,
     * Adresse, Ein-Leser-Eigenschaft und Steuerquelle ändern sich nur, solange keine Box die
     * Quelle je gelesen hat oder vorgemerkt ist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bearbeiten(
            String name,
            String protokoll,
            String adresse,
            List<Integer> geraeteIds,
            String netz,
            Boolean mehrereLeser,
            Boolean steuerquelle,
            Integer kadenzS) {}

    /**
     * {@code POST …/{id}/assignments}: „ab {@code effective_from} liest {@code device_id}“.
     * {@code effective_from} auf die volle Minute mit Versatz; fehlend = jetzt (auf die Minute
     * abgerundet).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zuweisen(UUID deviceId, OffsetDateTime effectiveFrom, Boolean vergleichBestaetigt) {}

    /** Das Urteil „erlaubt“ mit dem Satz des Vertrags und der Quelle danach. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zugewiesen(String urteil, String text, String hinweis, boolean vergleichsquelle,
            Datenquelle datenquelle) {}

    /**
     * {@code POST …/{id}/reachability-check}: EIN Lese-Schritt von GENAU {@code device_id} an die
     * Adresse der Quelle (Host und Port kommen von der Quelle, nie aus der Anfrage).
     * {@code unit_id} ist die Modbus-Geräte-ID; {@code register} ist bei SunSpec-Modbus mit
     * 40000 (Kennung „SunS“) vorbelegt und bei Modbus TCP Pflicht.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Pruefen(
            UUID deviceId,
            Integer unitId,
            Integer register,
            String registerKind,
            String dataType,
            String wordOrder) {}

    /**
     * Das Ergebnis einer Prüfung. {@code ergebnis} ist „ok“, eine Fehlerklasse des Vertrags
     * (§7) oder — ohne Wertung — ein Wort des Prüf-Kanals ({@code rate_limited},
     * {@code not_supported}, {@code invalid_request}) bzw. {@code box_meldet_sich_nicht}.
     * {@code gewertet}: zählt sie für eine Zuständigkeit (und steht sie im Protokoll)?
     * {@code antwort} ist die rohe Antwort der Box, fehlt, wenn sie nicht geantwortet hat.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Pruefergebnis(
            Box box,
            String adresse,
            String ergebnis,
            boolean gewertet,
            String text,
            Instant zeitpunkt,
            long dauerMs,
            ProbeResult antwort) {}

    /** Wer einen Eintrag geschrieben hat — im Akteur-Vokabular von AP-03. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Urheber(String name, String rolle, String art) {}

    /** Ein Eintrag des Protokolls der Quelle, jüngster zuerst. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record ProtokollEintrag(
            long id,
            String art,
            Box box,
            String ergebnis,
            JsonNode alt,
            JsonNode neu,
            Instant giltAb,
            Urheber urheber,
            Instant zeitpunkt) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Protokoll(List<ProtokollEintrag> eintraege) {}
}
