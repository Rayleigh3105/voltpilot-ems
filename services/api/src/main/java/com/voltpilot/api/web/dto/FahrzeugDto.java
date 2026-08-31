package com.voltpilot.api.web.dto;

import com.voltpilot.api.verbraucher.Steuerart;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * Die FAHRZEUGE einer Anlage (Verbrauchsmanagement v1 / P7): je Ladekarte, die
 * hier schon einmal geladen hat, eine Zeile - mit dem Namen und der Steuerart,
 * sobald der Kunde sie vergeben hat.
 *
 * <p>⚠ Es ist EINE Liste, nicht zwei. „Gesehen" und „benannt" sind derselbe
 * Gegenstand in zwei Zuständen; sie zu trennen hieße, dieselbe Karte in zwei
 * Listen zu führen und die Fläche entscheiden zu lassen, welche gilt.
 */
public record FahrzeugDto(List<Eintrag> fahrzeuge) {

    /**
     * Eine Ladekarte.
     *
     * @param tagRef  der PSEUDONYM der Box - kein Klartext-IdTag, und
     *                ausdrücklich NICHT der Bezug aus dem OCPP-Journal (den
     *                pfeffert die Cloud beim Ingest ein zweites Mal, er ist für
     *                dieselbe Karte ein anderer Wert)
     * @param name    der Kundenname; {@code null} = gesehen, nicht benannt
     * @param steuerart die projizierte Steuerart; {@code null} = kein Profil,
     *                die Karte fährt die Bahn ihrer Säule
     * @param ersteSichtungAm wann diese Anlage die Karte zuerst gesehen hat
     * @param letzteSichtungAm und wann zuletzt - das „hat gestern geladen"
     * @param letzterLadepunkt die Kennung der Säule von zuletzt; {@code null} =
     *                nicht gemeldet, nie eine erfundene
     * @param laedt   {@code true}, solange die Karte GERADE lädt - aus dem
     *                Herzschlag, nicht aus der Sichtungszeit geraten
     */
    public record Eintrag(String tagRef, String name, Steuerart steuerart,
            BigDecimal mindestleistungKw, Instant ersteSichtungAm, Instant letzteSichtungAm,
            String letzterLadepunkt, boolean laedt) {}

    /**
     * Ein Profil, wie es zur BOX reist (das Wire-Gegenstück zu
     * {@code charging-config.vehicle_profiles[]}).
     *
     * <p>⚠ Es trägt eine QUELLE und nie ein Ziel - siehe
     * {@code FahrzeugSteuerart}. {@code minKw == null} heißt „das Profil äußert
     * sich nicht" und die Zahl der Säule gilt, nie 0.
     */
    public record VehicleProfileDto(String tagRef, String name, String source, Double minKw) {}

    /** Die ehrliche Leere: diese Anlage hat noch keine Karte gesehen. */
    public static FahrzeugDto leer() {
        return new FahrzeugDto(List.of());
    }
}
