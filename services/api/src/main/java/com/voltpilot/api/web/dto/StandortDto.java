package com.voltpilot.api.web.dto;

import com.voltpilot.api.uems.StandortLesemodell.Adresse;
import com.voltpilot.api.uems.StandortLesemodell.Lage;
import java.util.List;

/**
 * Die Anfragen der Standort-Schreibrouten (UEMS AP-02 IP-4, {@code /api/v1/standorte}).
 * Die Antwort ist der Standort in der Form des Lesemodells ({@code StandortAmStichtag}, heute).
 * camelCase wie das Lesemodell; Adresse und Lage haben dieselbe Form wie dort.
 */
public final class StandortDto {
    private StandortDto() {}

    /**
     * {@code POST} und {@code PUT}: die Stammdaten des Standorts (§4.1). Beim Anlegen sind
     * {@code kurzzeichen} (fehlt: automatisch ST-n, E8) und {@code zeitzone} (fehlt: die
     * Vorgabe des Unternehmens) optional, die Adresse ist Pflicht (Straße, Ort, Land; die
     * PLZ optional, im Format je Land). {@code PUT} schreibt die ganze Menge: ein fehlendes
     * Feld ist leer — {@code kurzzeichen} und {@code zeitzone} sind dort Pflicht, die Adresse
     * nur, solange der Standort kein Entwurf ist (E10). {@code nutzung} sind Codes des
     * geschlossenen Vokabulars (E4), die erste ist die Hauptnutzung.
     */
    public record Stammdaten(
            String name,
            String kurzzeichen,
            Adresse adresse,
            String zeitzone,
            List<String> nutzung,
            String notiz,
            Lage lage) {}

    /** {@code POST …/wiederherstellen}: optional ein neuer Name — das Umbenennen im selben Dialog. */
    public record Wiederherstellen(String name) {}

    /** {@code GET …/kurzzeichen-vorschlag}: das Kurzzeichen, das ein neuer Standort jetzt bekäme. */
    public record Vorschlag(String kurzzeichen) {}
}
