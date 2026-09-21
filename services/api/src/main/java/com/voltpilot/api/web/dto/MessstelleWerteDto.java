package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Die Antwort des Lese-Modells „Werte je Messstelle“ (UEMS AP-08 IP-9,
 * {@code GET /api/v1/messstellen/{kennzeichen}/werte}) — snake_case wie die Messstellen-Schnittstelle.
 *
 * <p><b>Jedes Feld steht immer da, auch leer ({@code null}).</b> Eine Menge verlässt die Route nie
 * ohne ihren Zustand, ihre Abdeckung und ihre Kennzeichen; ein Feld, das „meistens leer“ ist, fehlt
 * darum trotzdem nicht. {@code null} heißt „nicht bekannt“ oder „nicht gebildet“ — nie 0.
 */
public final class MessstelleWerteDto {
    private MessstelleWerteDto() {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Werte(
            Messstelle messstelle,
            String raster,
            String von,
            String bis,
            String zeitzone,
            String zeitzoneHerkunft,
            Integer version,
            List<Quelle> quellen,
            List<Wert> werte,
            String zuordnung) {}

    /** Die Messstelle und ihre Hauptgröße — jede Zahl der Antwort steht in {@code einheit}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Messstelle(UUID id, String kennzeichen, String name, String art, String groesse,
            String richtung, String einheit, String wertart) {}

    /** Eine FÜHRENDE Bindung der Hauptgröße, die den Zeitraum berührt — nur sie liefert Werte. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Quelle(UUID id, UUID komponente, String kanal, String herleitung, String anteil,
            String gueltigAb, String gueltigBis) {}

    /**
     * Ein Schritt des Rasters.
     *
     * @param zustand das Wort des Ergebnis-Zustands-Vertrags (vollständig · unvollständig · keine
     *     Werte · mit Ersatzwert) — gespeichert als {@code menge_zustand}; {@code null} NUR zusammen mit
     *     {@code grund}
     * @param fassung {@code vorlaeufig} | {@code endgueltig} — gespeichert als {@code zustand}; eine
     *     andere Aussage als {@code zustand}
     * @param grund warum der Schritt keine Zahl trägt, obwohl die Anfrage gültig ist
     *     ({@code MessstelleWerteRegeln.OhneZahl}); {@code null}, wenn er aus der Speicherklasse kommt
     * @param herkunft die Hülle {@code {satz, fehlt}} nach {@code bilanzwert-herkunft.schema.json} (AP-10 IP-12) an
     *     jeder BERECHNETEN Zahl; {@code null} heißt „nicht berechnet“ — ein gemessener Schritt oder einer ohne Zahl
     * @param version die Version, deren Zahl der Schritt zeigt — ohne Anfrage die neueste (AP-08 IP-18)
     * @param versionen die NAHT für die Portal-Fläche „Versionen“ am Wert (AP-08 IP-18): wie viele Versionen die
     *     Periode hat (ab 2 gibt es eine Historie unter {@code …/werte/versionen}); {@code null}, wo der Schritt keine
     *     eigene Periode hat (die Stunde) oder noch nicht gebildet ist
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Wert(
            String von,
            String bis,
            String beschriftung,
            Long stunden,
            String tagesdauer,
            BigDecimal menge,
            BigDecimal mittel,
            BigDecimal min,
            BigDecimal max,
            String zustand,
            List<String> kennzeichen,
            Integer erhalten,
            Integer erwartet,
            Integer abdeckungProzent,
            String fassung,
            String endgueltigAb,
            Integer version,
            String gebildetAus,
            UUID quelle,
            String grund,
            List<Ereignis> ereignisse,
            Map<String, Object> herkunft,
            Integer versionen) {}

    /**
     * Die Versions-Historie EINER Periode (AP-08 IP-18, {@code GET …/werte/versionen}): je Version der Wert, der
     * vorher dastand, der neue, und wer ihn wann warum geändert hat. Version 1 ist die Zahl der Verdichtung — ohne
     * Entscheidung. {@code grund} (ein Wort von {@code MessstelleWerteRegeln.OhneZahl}) steht nur, wenn die Periode
     * keine Versionen hat, weil sie dieser Messstelle nicht gehört oder noch nicht gebildet ist.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Historie(
            Messstelle messstelle,
            String raster,
            String von,
            String bis,
            String zeitzone,
            String zeitzoneHerkunft,
            String grund,
            List<Version> versionen) {}

    /**
     * Eine Version der Periode.
     *
     * @param wertAlt was vorher dastand (Version n − 1, genau so, wie {@code version=n-1} ihn zeigt); an Version 1
     *     {@code null}
     * @param wertNeu diese Version, genau so, wie {@code version=n} sie zeigt
     * @param gebildetAm wann die Zeile geschrieben wurde (Version 1: von der Verdichtung)
     * @param nachgezogenAm eine vorläufige Version wächst mit ihrer Grundlage (IP-17) — wann zuletzt; sonst {@code null}
     * @param anlass die Fassung des Vorgangs, die die Version auslöste; an Version 1 {@code null}
     * @param entscheidungen wer wann warum — alle Fassungen, die diese Version gegenüber der vorigen ausmachen
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Version(
            int version,
            Wert wertAlt,
            Wert wertNeu,
            String gebildetAm,
            String nachgezogenAm,
            Anlass anlass,
            List<Entscheidung> entscheidungen) {}

    /** Kennung und Fassung eines Ersatzwerts ({@code EW-…}) oder einer Korrektur ({@code K-…}). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Anlass(String kennung, int fassung) {}

    /**
     * Eine Entscheidung: eine Fassung eines Vorgangs mit ihrem Urheber, ihrem Zeitpunkt und dem Text, den der Mensch
     * DAZU geschrieben hat (anlegende Fassung: die Begründung, jede weitere: ihr Grund).
     *
     * @param warum {@code null} = keiner geschrieben; dann nennt {@code fehlt} „warum“ — nie ein erfundener Grund
     * @param fehlt was an der Entscheidung nicht bekannt ist ({@code warum} · {@code fassung}), sonst leer
     * @param angelegt an einer späteren Fassung (Freigabe, Rücknahme) die anlegende Fassung des Vorgangs mit IHRER
     *     Begründung und IHREM Urheber; an Fassung 1 {@code null}
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Entscheidung(
            String vorgang,
            String kennung,
            int fassung,
            String status,
            String methode,
            String art,
            Urheber wer,
            String wann,
            String warum,
            String beleg,
            List<String> fehlt,
            Angelegt angelegt) {}

    /** Der Urheber einer Fassung, wie er gespeichert ist ({@code actor_name}, {@code actor_rolle}, {@code actor_art}). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Urheber(String name, String rolle, String art) {}

    /** Die anlegende Fassung eines Vorgangs — was eingetragen bzw. vorgeschlagen wurde, von wem, wann, warum. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Angelegt(Urheber wer, String wann, String warum, String beleg) {}

    /** Ein Verweis auf eine Meldung des Ereignis-Vertrags — Kennung, Art, Zeit; der Inhalt bleibt dort. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Ereignis(UUID id, String art, String von, String bis) {}
}
