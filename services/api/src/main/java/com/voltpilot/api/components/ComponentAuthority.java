package com.voltpilot.api.components;

/**
 * WER die Geräte-Konfiguration EINER Anlage besitzt (Einheitsmodell Stufe 1,
 * Konzept vp-komponenten-einheit-h2 §4.2.3/§7.2).
 *
 * <p><b>Genau ein Zustand je Anlage, nie je Gerät.</b> Eine Anlage ist entweder
 * box-verwaltet (die Box ist die Wahrheit, {@code :8484} bearbeitet weiter) oder
 * portal-verwaltet (das Portal ist das Soll, die Box wendet an und meldet die
 * angewandte Revision). Gemischt gibt es nicht - das wäre genau die Grauzone,
 * aus der zwei Schreiber auf derselben Konfiguration entstehen.
 *
 * <p><b>Der Bestand bleibt unangetastet.</b> Die Migration setzt jede beim
 * Deploy existierende Anlage auf {@link #BOX}; der Spalten-Default {@link
 * #PORTAL} greift nur für Anlagen, die danach entstehen. Die Übernahme des
 * Bestands ist ausdrücklich Stufe 2.
 */
public final class ComponentAuthority {

    /** Die Box ist die Wahrheit (der Bestandsfall, und der sichere Default). */
    public static final String BOX = "box";

    /** Das Portal ist das Soll; die Box leitet ihre lokalen Dateien daraus ab. */
    public static final String PORTAL = "portal";

    private ComponentAuthority() {
    }

    /**
     * Liest einen gespeicherten Wert. Alles, was nicht exakt {@link #PORTAL}
     * ist - {@code null}, leer, ein Wert aus einer neueren Fassung -, ist
     * {@link #BOX}: die sichere Richtung ist die, die nichts verändert.
     */
    public static String of(String raw) {
        return PORTAL.equals(raw) ? PORTAL : BOX;
    }

    /** Ob diese Anlage im Portal bearbeitbar ist. */
    public static boolean isPortalManaged(String raw) {
        return PORTAL.equals(of(raw));
    }
}
