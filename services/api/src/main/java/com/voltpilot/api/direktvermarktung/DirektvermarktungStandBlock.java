package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Stand;
import java.time.Instant;
import java.time.format.DateTimeParseException;

/**
 * Liest den Herzschlag-Block {@code direktvermarktung} (Vertrag
 * {@code docs/contracts/v2/direktvermarktung-zustellung.md} §5, Vektoren
 * {@code direktvermarktung-zustellung-vectors.json}) in die Spiegel-Zeile {@code direktvermarktung_stand}.
 * Tolerant beim Lesen (unbekannte Felder und Wörter werden überlesen), und Unbekannt ist keine Null: ein
 * fehlendes Feld bleibt NULL, nie 0.
 */
public final class DirektvermarktungStandBlock {

    /** Der gelesene Block: die Spiegel-Zeile plus Lage, Partner und Fingerabdruck. */
    public record Block(String partner, String lage, int revision, String zugangFingerabdruck, Stand stand) {}

    private DirektvermarktungStandBlock() {}

    /** Liest den Block; {@code null}, wenn der Herzschlag keinen trägt (dann bleibt der Stand stehen). */
    public static Block lies(JsonNode block) {
        if (block == null || block.isNull() || !block.isObject()) {
            return null;
        }
        JsonNode tunnel = block.path("tunnel");
        JsonNode werte = block.path("werte");
        Stand stand = new Stand(
                zeit(tunnel.path("oben_seit")), zeit(tunnel.path("handshake_am")),
                text(tunnel.path("gegenstelle")),
                zeit(block.path("letzte_abfrage_am")), zahl(block.path("abfragen_je_minute")),
                zeit(block.path("letzte_schreibung_am")), ganz(block.path("vorgabe_pct")),
                zeit(block.path("lebenszeichen_am")),
                ganz(werte.path("einspeisung_w")), ganz(werte.path("erzeugung_w")),
                ganz(werte.path("netzbetreiber_pct")), ganz(werte.path("referenz_w")), null);
        return new Block(block.path("partner").asText(""), block.path("lage").asText(""),
                block.path("revision").asInt(0), text(block.path("zugang_fingerabdruck")), stand);
    }

    /**
     * Die grobe Nachführung des Anschluss-Zustands aus der Lage der Box (Vertrag §5, Tabelle
     * {@code zustand_aus_lage} der Vektoren); {@code null} = der Zustand bleibt stehen (auch für ein
     * unbekanntes, zukünftiges Lage-Wort - tolerant lesen heißt nie raten).
     */
    public static String zustandAusLage(String lage) {
        return switch (lage) {
            case "baut_auf" -> DirektvermarktungRepository.VERBINDET;
            case "tunnel_oben" -> DirektvermarktungRepository.WARTET_AUF_PARTNER;
            case "verbunden", "vorgabe_aktiv", "abgelaufen" -> DirektvermarktungRepository.VERBUNDEN;
            case "tunnel_unten", "zugang_ungueltig" -> DirektvermarktungRepository.GESTOERT;
            default -> null;
        };
    }

    private static Instant zeit(JsonNode n) {
        if (n == null || !n.isTextual() || n.asText().isBlank()) return null;
        try {
            return Instant.parse(n.asText());
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static String text(JsonNode n) {
        return n != null && n.isTextual() && !n.asText().isBlank() ? n.asText() : null;
    }

    private static Integer ganz(JsonNode n) {
        return n != null && n.isNumber() ? n.intValue() : null;
    }

    private static Double zahl(JsonNode n) {
        return n != null && n.isNumber() ? n.doubleValue() : null;
    }
}
