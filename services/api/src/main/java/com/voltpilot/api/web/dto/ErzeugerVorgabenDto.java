package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * UEMS EZ-7: die Formen der Vorgaben einer Erzeugeranlage (Konzept vp-erzeuger-wago-konzept §4.6, EW-8 A, EW-12 A) —
 * wer wann wie lange die Anlage begrenzt oder gesteuert hat. Snake-Case wie {@link AnlagensteuerungDto};
 * „unbekannt“ ist null, nie abwesend und nie 0.
 */
public final class ErzeugerVorgabenDto {
    private ErzeugerVorgabenDto() {}

    /**
     * Eine Vorgabe. {@code teNr} null = die ganze Anlage; {@code ende} null = läuft (belegt bis {@code gesehenBis}).
     * {@code energieKwh} ist die geschätzt nicht erzeugte Energie nach {@code methode} (null = ohne Grundlage, 0 nur
     * bei „nicht bindend“), {@code wertEur} ihre Euro-Schätzung zu den Preisen der Anlage (null ohne Preisgrundlage).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorgabe(
            UUID id,
            UUID geraetId,
            Integer teNr,
            String einheitName,
            String urheber,
            String art,
            OffsetDateTime beginn,
            boolean beginnGenau,
            OffsetDateTime ende,
            boolean endeGenau,
            OffsetDateTime gesehenBis,
            long dauerS,
            BigDecimal vorgabeProzent,
            BigDecimal vorgabeW,
            BigDecimal istMittelW,
            BigDecimal verfuegbarMittelW,
            BigDecimal energieKwh,
            String methode,
            BigDecimal wertEur,
            String kanal,
            String bindung,
            boolean unvollstaendig,
            boolean neustart,
            Integer zaehlerBeginn,
            Integer zaehlerEnde,
            List<String> gruende) {}

    /** Eine Datenlücke, über die der Zähler des Urhebers mehr Vorgaben zählt, als gesehen wurden. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Luecke(
            UUID id,
            UUID geraetId,
            String urheber,
            OffsetDateTime beginn,
            OffsetDateTime ende,
            Integer weitereWechsel,
            boolean neustart,
            Integer zaehlerVorher,
            Integer zaehlerNachher) {}

    /** {@code GET /api/v1/sites/{siteId}/erzeuger/vorgaben}: die Chronik im Zeitraum. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Chronik(
            UUID siteId,
            OffsetDateTime von,
            OffsetDateTime bis,
            OffsetDateTime verarbeitetBis,
            List<Vorgabe> vorgaben,
            List<Luecke> luecken) {}

    /** Ein Rohwert am Beginn oder Ende einer Vorgabe, in der Sprache des Bilds. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Rohwert(
            String pointKey,
            String feld,
            Integer teNr,
            BigDecimal wert,
            String wort,
            String text,
            List<AnlagensteuerungDto.Bit> bits) {}

    /** Eine Probe eines Rohsignals im Zeitraum der Vorgabe. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Signal(String pointKey, OffsetDateTime gemessenAm, BigDecimal wert, String qualitaet) {}

    /**
     * {@code GET …/erzeuger/vorgaben/{vorgabeId}}: die Vorgabe mit den Rohsignalen, die sie erklären — am Beginn und am
     * Ende — und den Proben in ihrem Zeitraum (± 60 s; nur, solange die Messwerte aufbewahrt sind, höchstens
     * {@code 500}; {@code signaleGekuerzt} = es gab mehr).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Detail(
            Vorgabe vorgabe,
            List<Rohwert> rohBeginn,
            List<Rohwert> rohEnde,
            List<Signal> signale,
            boolean signaleGekuerzt) {}

    /**
     * Eine Gruppe der Zählung: Urheber, Art und Einheit (null = ganze Anlage). {@code anzahl} zählt jede Vorgabe, die
     * den Abschnitt berührt; {@code dauerS} nur ihren Anteil darin; {@code energieKwh}/{@code wertEur} summieren die
     * bekannten Schätzungen (null, wenn keine), {@code ohneSchaetzung} zählt die ohne.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Gruppe(
            String urheber,
            String art,
            Integer teNr,
            int anzahl,
            long dauerS,
            BigDecimal energieKwh,
            BigDecimal wertEur,
            int ohneSchaetzung,
            int unvollstaendig) {}

    /**
     * Je Urheber über alle Arten, nur Vorgaben der ganzen Anlage: {@code dauerS} ist die Vereinigung (überlappende
     * Arten desselben Urhebers zählen einmal) — die Zahl der Kachel „Wer hat heute geregelt?“.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record JeUrheber(
            String urheber,
            int anzahl,
            long dauerS,
            BigDecimal energieKwh,
            BigDecimal wertEur) {}

    /** Ein Tag oder Monat (Europe/Berlin) der Zählung. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Abschnitt(
            String periode,
            OffsetDateTime beginn,
            OffsetDateTime ende,
            List<Gruppe> gruppen,
            List<JeUrheber> jeUrheber) {}

    /** {@code GET …/erzeuger/vorgaben/zaehlung}: „Nach Art“ je Tag oder Monat. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zaehlung(
            UUID siteId,
            String raster,
            String von,
            String bis,
            OffsetDateTime verarbeitetBis,
            List<Abschnitt> abschnitte) {}

    /** {@code GET …/erzeuger/vorgaben/heute}: der heutige Tag (Europe/Berlin) bis jetzt und was gerade läuft. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Heute(
            UUID siteId,
            String tag,
            OffsetDateTime abgerufenAm,
            OffsetDateTime verarbeitetBis,
            List<Gruppe> gruppen,
            List<JeUrheber> jeUrheber,
            List<Vorgabe> laufend) {}
}
