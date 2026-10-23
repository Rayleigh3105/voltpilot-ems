package com.voltpilot.api.chargers;

/**
 * „Box hat übernommen" (Konzept k1 „Gewählt ist nicht geladen", Regel 4,
 * 23.10.2026; Vertrag {@code docs/contracts/ladepunkt-quelle-echo.md}): der
 * Vergleich der WAHL je Säule ({@code site_charge_point_allowlist}, die das
 * retained Dokument trägt) mit dem ECHO der Box im Herzschlag.
 *
 * <p>Verglichen wird die gespeicherte BAHN, nicht die Ladequelle des Kunden:
 * welche Bahn „Günstig" fährt, entscheidet {@code SteuerartProjektion.bahnAus}
 * an einer Stelle - dieser Vergleich folgt jeder Änderung dort von selbst.
 *
 * <p>Dreiwertig: {@code null} heißt „nicht bekannt" (eine ältere Box meldet
 * nichts, oder es gibt keine Wahl je Säule) - nie „übernommen".
 */
public final class QuellenEcho {

    /** Toleranz für die Mindestleistung (kW): die Box rundet nicht, der Kunde wählt in 0,1. */
    static final double KW_TOLERANZ = 0.05;

    private QuellenEcho() {
    }

    /** Was die Box für eine Säule fährt; {@code source} aus dem geschlossenen Vokabular. */
    public record Echo(String source, Double minKw, Boolean storageRelease) {}

    /** Was der Kunde für eine Säule gewählt hat; {@code source} null = keine Wahl je Säule. */
    public record Wunsch(String source, Double minKw, boolean storageRelease) {}

    /** {@code true} übernommen, {@code false} weicht ab, {@code null} unbekannt. */
    public static Boolean uebernommen(Wunsch wunsch, Echo echo) {
        if (wunsch == null || wunsch.source() == null || echo == null || echo.source() == null) {
            return null;
        }
        if (!wunsch.source().equals(echo.source())) {
            return false;
        }
        if ("sonne_zuerst".equals(wunsch.source()) && wunsch.minKw() != null && wunsch.minKw() > 0) {
            if (echo.minKw() == null || Math.abs(echo.minKw() - wunsch.minKw()) > KW_TOLERANZ) {
                return false;
            }
        }
        if ("nur_sonne".equals(wunsch.source())) {
            return wunsch.storageRelease() == Boolean.TRUE.equals(echo.storageRelease());
        }
        return true;
    }
}
