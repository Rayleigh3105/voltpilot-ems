package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Bezugsgrößen-Schnittstelle (UEMS AP-09 IP-5, {@code /api/v1/bezugsgroessen}).
 *
 * <p>snake_case wie der Bezugsdaten-Vertrag ({@code docs/contracts/v2/bezugsdaten.md}) und die
 * übrigen UEMS-Schnittstellen; die Wörter (Wertart, Einheit, Periodenart, Geltungsbereich-Art,
 * Vorgang, Status, Herkunft) sind die Vokabulare des Vertrags. Beträge reisen als DEZIMALTEXT.
 */
public final class BezugsgroesseDto {
    private BezugsgroesseDto() {}

    /**
     * {@code POST /api/v1/bezugsgroessen} und {@code PUT …/{id}}: die ganze Bezugsgröße. Beim
     * Anlegen darf {@code kennzeichen} fehlen (der Server vergibt BZ-0001 …, M2), beim Ändern nicht.
     * {@code periode_art} gibt es genau beim Periodenwert. {@code geltung_id} ist die ID des
     * Objekts (Unternehmen, Standort, Gebäude/Bereich, Messstelle).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anfrage(
            String kennzeichen,
            String name,
            String wertart,
            String einheit,
            String periodeArt,
            String geltungArt,
            String geltungId) {}

    /** Eine Bezugsgröße. {@code hat_werte} sagt, ob M1 greift und ob sie löschbar ist (M6). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bezugsgroesse(
            UUID id,
            String kennzeichen,
            String name,
            String wertart,
            String einheit,
            String periodeArt,
            String geltungArt,
            UUID geltungId,
            String geltungName,
            boolean hatWerte,
            OffsetDateTime archiviertAm,
            OffsetDateTime angelegtAm) {}

    /** {@code GET /api/v1/bezugsgroessen}: archivierte eingeschlossen, nach Kennzeichen. */
    public record Liste(List<Bezugsgroesse> bezugsgroessen) {}

    /** Wer eine Fassung eingetragen oder freigegeben hat — im Akteur-Vokabular von AP-03, ohne Subject. */
    public record Person(String name, String rolle, String art) {}

    /**
     * Die Herkunft EINER Fassung (Invariante 7): woher sie kam ({@code art} aus dem Vokabular
     * {@code herkunft_art}), ob sie von Hand eingetragen wurde, und bei einem Import Datei-Kennung,
     * Zeile sowie das Gelieferte (Text und Einheit, U1).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Herkunft(
            String art,
            boolean vonHand,
            String importKennung,
            Integer importZeile,
            String geliefertText,
            String geliefertEinheit) {}

    /**
     * Eine Fassung, wie sie gespeichert ist ({@code status} = das Wort bei Entstehen), plus
     * {@code stand} — die Lesart der Regel {@code fassung} („wirksam“, „wirksam bis Fassung 2“,
     * „zurueckgenommen“); {@code null}, solange die Kette Vier-Augen-Fassungen trägt (IP-7).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Fassung(
            int fassung,
            String vorgang,
            String status,
            String stand,
            String betrag,
            Integer ersetztFassung,
            String begruendung,
            List<String> kennzeichen,
            Herkunft herkunft,
            Person urheber,
            Person freigeber,
            OffsetDateTime eingetragenAm) {}

    /**
     * Ein Wert = ein Schlüssel (Periode bzw. Zeitpunkt) mit seinen Fassungen. {@code wirksamer_betrag}
     * ist {@code null} nach einer Rücknahme — nie 0 — und solange {@code stand_offen}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wert(
            LocalDate periodeVon,
            LocalDate periodeBis,
            OffsetDateTime zeitpunkt,
            String zeitzone,
            String wirksamerBetrag,
            Integer wirksameFassung,
            boolean standOffen,
            List<Fassung> fassungen) {}

    /** {@code GET /api/v1/bezugsgroessen/{id}/werte}: der Zeitraum, die Lesart und die Werte. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Werte(
            UUID bezugsgroesseId,
            String kennzeichen,
            String wertart,
            String einheit,
            String periodeArt,
            LocalDate von,
            LocalDate bis,
            String fassungen,
            List<Wert> werte) {}
}
