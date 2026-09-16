package com.voltpilot.api.measurement;

import java.util.Map;
import java.util.Set;

/**
 * Die Katalogwörter eines Messkanals in den Wörtern des Messstellen-Vertrags
 * ({@code docs/contracts/v2/messstelle.md} §2) — genau die Eingänge, die
 * {@code MessstelleRegeln.passung} für eine Quellenbindung braucht (Größe, Richtung, Einheit,
 * Wertart des Messwerts).
 *
 * <p>Die Tabelle wohnt in {@code catalog/measurement-points/README.md} („Größe und Richtung“);
 * {@code MesskanalAbbildungTest} hält diese Konstanten zeichengleich an ihr fest, der
 * Katalog-Test {@code test_semantics.py} beweist sie eindeutig und vollständig. Ein Katalogwort
 * ohne Vertragswort (dort „—“) ergibt {@code null}: ein solcher Messwert speist keine
 * Messstelle — nie ein geratenes Nachbarwort.
 */
public final class MesskanalAbbildung {

    private MesskanalAbbildung() {}

    /** {@code quantity} → Vertrags-Größe. */
    public static final Map<String, String> GROESSE = Map.of(
            "active_energy", "Wirkenergie",
            "active_power", "Wirkleistung",
            "reactive_energy", "Blindenergie",
            "apparent_power", "Scheinleistung",
            "soc", "Ladestand");

    /** {@code direction} → Vertrags-Richtung. */
    public static final Map<String, String> RICHTUNG = Map.of(
            "import", "Bezug",
            "export", "Abgabe",
            "generation", "Erzeugung",
            "charge", "Laden",
            "discharge", "Entladen",
            "charge_discharge", "Laden / Entladen",
            "import_export", "richtungslos",
            "none", "richtungslos");

    /**
     * Die Wertarten eines Messwerts (AP-07 E12, {@code messwert-herkunft.schema.json}). Der
     * Katalog kennt zusätzlich {@code event} und {@code none} — beide sind keine Wertart.
     */
    public static final Set<String> WERTARTEN = Set.of("counter", "gauge", "state", "bitfield", "text");

    public static String groesse(String quantity) {
        return quantity == null ? null : GROESSE.get(quantity);
    }

    public static String richtung(String direction) {
        return direction == null ? null : RICHTUNG.get(direction);
    }

    /** Die Wertart der Quelle aus {@code aggregation_kind}; {@code null}, wenn es keine ist. */
    public static String wertart(String aggregationKind) {
        return aggregationKind != null && WERTARTEN.contains(aggregationKind) ? aggregationKind : null;
    }
}
