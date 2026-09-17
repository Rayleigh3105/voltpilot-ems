package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen des Zählerwechsels (UEMS AP-04 IP-17) — EIN Vorgang, zwei Einstiege:
 * {@code POST /api/v1/messstellen/{id}/quellen/wechsel} („Zähler wechseln“ an der Quelle-Karte)
 * und {@code POST /api/v1/geraete/{id}/austausch} („Gerät austauschen“ am Gerät). Beide schicken
 * dieselbe Anfrage und bekommen dieselbe Antwort; sie unterscheiden sich nur darin, WOHER das alte
 * Gerät kommt — aus der führenden Quelle der Messstelle oder unmittelbar aus dem Pfad.
 *
 * <p>snake_case wie die übrigen UEMS-Schnittstellen, Zeitpunkte mit Versatz (Europe/Berlin) und auf
 * die Minute (E2).
 */
public final class ZaehlerwechselDto {
    private ZaehlerwechselDto() {}

    /**
     * Das Kästchen, das kommt. Jedes Feld darf fehlen: {@code einbau_kennzeichen} vergibt dann der
     * Server (z. B. {@code GR-4.2}), Hersteller, Typ und Bezeichnung übernimmt er vom Vorgänger —
     * die {@code seriennummer} NIE: sie ist die des alten Kästchens und wird nie erfunden
     * ({@code null} heißt „nicht erhoben“).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record NeuesGeraet(
            String einbauKennzeichen,
            String hersteller,
            String typ,
            String seriennummer,
            String bezeichnung) {}

    /**
     * Wie das neue Gerät antwortet. Fehlt das Feld ganz, bleibt die Verbindung des Vorgängers —
     * „gleiche Datenquelle und Geräte-ID“ (§5.5), und dann entsteht auch KEINE neue
     * Komponenten-Fassung.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verbindung(UUID datenquelle, Integer geraeteId) {}

    /**
     * Die Anfrage beider Einstiege. {@code zeitpunkt} fehlend = jetzt; die Vergangenheit ist
     * erlaubt und wird „rückwirkend“ markiert, die Zukunft „angekündigt“ (E2). Die Ablesestände
     * sind optional: {@code endstand_vorgaenger} landet an der Bindung, die endet,
     * {@code anfangsstand} an der, die beginnt. {@code einstellungen_uebernehmen} fehlend = true
     * (die Vorgabe des Dialogs: „Einstellungen übernommen“).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wechsel(
            OffsetDateTime zeitpunkt,
            NeuesGeraet neuesGeraet,
            Verbindung verbindung,
            MessstelleQuelleDto.Stand endstandVorgaenger,
            MessstelleQuelleDto.Stand anfangsstand,
            Boolean einstellungenUebernehmen,
            String grund,
            List<UUID> kartenUebernommen,
            List<Ablesestand> ablesestaende,
            List<UUID> bestaetigteBindungen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Berichtigung(OffsetDateTime bisher, OffsetDateTime zeitpunkt, String grund) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Berichtigt(UUID vorgaenger, UUID nachfolger, OffsetDateTime bisher,
            OffsetDateTime zeitpunkt, String satz) {}

    /** Optionaler Stand je führender Bindung; auch mehrere Zählwerke derselben Karte sind eindeutig. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Ablesestand(UUID bindung, MessstelleQuelleDto.Stand endstand,
            MessstelleQuelleDto.Stand anfangsstand) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Karte(UUID id, Integer steckplatz, String bezeichnung, String typ, String seriennummer) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Folge(UUID bindung, UUID karte, UUID komponente, UUID messstelle, String kennzeichen,
            String groesse, String richtung, String rolle, String einheit, boolean zaehlerstand) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorschau(OffsetDateTime zeitpunkt, List<Karte> karten, List<Folge> folgen) {}

    /** Ein Einbau der Antwort: das Gerät an der Stelle (GR-4) und das konkrete Kästchen (Z-5a). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einbau(
            UUID id,
            String geraet,
            String einbau,
            String seriennummer,
            OffsetDateTime eingebautAm,
            OffsetDateTime ausgebautAm) {}

    /**
     * Was am Gerät geschah. {@code verbindung_neu} sagt, ob Datenquelle oder Geräte-ID sich
     * geändert haben — nur dann bekommt die Komponente eine neue Fassung (§5.5).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GeraetWechsel(Einbau alt, Einbau neu, boolean verbindungNeu) {}

    /** Eine Größe einer Messstelle, die auf das neue Gerät umgezogen ist. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Bindung(
            UUID messstelle,
            String kennzeichen,
            String groesse,
            String richtung,
            String rolle,
            MessstelleQuelleDto.Quelle beendet,
            MessstelleQuelleDto.Quelle neu) {}

    /** Eine Einstellungs-Fassung, die auf den neuen Einbau übernommen wurde. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Einstellung(UUID id, String art, UUID komponente, String kanal, String anwendung) {}

    /**
     * Die Antwort beider Einstiege (201). {@code komponenten} sind die Komponenten, deren Speisung
     * mitgewandert ist; {@code marken} zählt, in wie vielen Komponenten-Verläufen die Marke „Zähler
     * gewechselt“ steht — sie ist ein isolierter Zusatz und lässt den Wechsel nie scheitern, also
     * ist eine kleinere Zahl als {@code komponenten} ehrlich und kein Fehler des Vorgangs.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Vorgang(
            GeraetWechsel geraet,
            List<UUID> komponenten,
            List<Bindung> bindungen,
            List<Einstellung> einstellungen,
            int marken,
            MessstelleQuelleDto.Rueckwirkung rueckwirkung,
            List<String> hinweise) {}
}
