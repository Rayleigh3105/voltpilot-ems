package com.voltpilot.api.components;

/**
 * DIE NAMENS-REGEL: ein vom Menschen vergebener Name wird nie von einem
 * abgeleiteten überschrieben.
 *
 * <p>Sie ist die Java-Hälfte der Label-Hygiene (Migration V20260812000000, Konzept
 * {@code vp-entity-alias-k1}), deren Invariante lautet: {@code label != NULL}
 * heißt „von einem Menschen vergeben". Die Schreibwege der Einheitsmodell-Stufen
 * 1 und 2 hielten sie nicht ein - sie schrieben den Modellnamen der Vorlage bzw.
 * den vom GERÄT gemeldeten Quellennamen ungefragt in dieselbe Spalte. Am
 * 20.08.2026 kostete das auf der Anlage Pilsting/Herzogau die Kundennamen
 * („beim neu hinzufügen sind die Aliase jetzt weg").
 *
 * <p>Rein und ohne Abhängigkeiten - das {@code Tagesprotokoll}-Muster; die
 * Datenbank-Hälfte ist {@code COALESCE(NULLIF(?, ''), label)}, also „null oder
 * leer heißt: nichts ändern".
 */
public final class ComponentLabels {

    private ComponentLabels() {
    }

    /**
     * Der Name, der geschrieben werden DARF.
     *
     * @param stored  der gespeicherte Name ({@code null} = die Zeile trägt keinen)
     * @param typed   was ein MENSCH gerade eingegeben hat ({@code null}/leer = nichts)
     * @param derived der ABGELEITETE Vorschlag: der Modellname der Vorlage, der
     *                von der Box gemeldete Quellenname. Er darf einen
     *                vorhandenen Namen nur FÜLLEN, nie ersetzen.
     * @return der zu schreibende Name, oder {@code null} = „nichts ändern"
     */
    public static String toWrite(String stored, String typed, String derived) {
        if (!blank(typed)) {
            return typed.trim();
        }
        if (!blank(stored)) {
            return null; // der Mensch hat schon entschieden - nichts ändern
        }
        return blank(derived) ? null : derived.trim();
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
