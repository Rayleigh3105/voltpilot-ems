package com.voltpilot.api.web.dto;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Gebäude/Bereich-Schreibrouten (UEMS AP-02 IP-5) — camelCase wie
 * {@code /api/v1/standorte}; Art, Nutzung und Zustand als CODES ({@code gebaeude},
 * {@code buero}, {@code aktiv}), nie als Kundenwort. Die Anfrage wird streng gelesen
 * ({@code OrtController}): ein Feld, das es an der Route nicht gibt, ist 400.
 */
public final class OrtDto {
    private OrtDto() {}

    /**
     * {@code POST /api/v1/standorte/{id}/orte}. {@code elternId}: das Gebäude, an dem ein
     * Bereich hängt — fehlend (oder die ID des Standorts) = direkt am Standort.
     * {@code kurzzeichen} fehlend = automatisch (G-1 …, B-1 …). {@code gueltigAb} fehlend =
     * heute in der Zeitzone des Standorts. {@code flaecheM2}: optional die erste Fläche, ab
     * demselben Tag. {@code baujahr} nur am Gebäude.
     */
    public record Anlegen(
            String art,
            String name,
            String kurzzeichen,
            UUID elternId,
            LocalDate gueltigAb,
            List<String> nutzung,
            Integer baujahr,
            String notiz,
            Integer flaecheM2) {}

    /**
     * {@code PUT /api/v1/orte/{id}}: die einfachen Felder (§4.3: ohne Gültigkeit, sofort
     * wirksam, Protokoll alt → neu), ganz — fehlend = leer. Woran der Ort hängt, ändert
     * nur das Verschieben (IP-12), seine Fläche {@code PUT …/flaeche}.
     */
    public record Bearbeiten(
            String name,
            String kurzzeichen,
            List<String> nutzung,
            Integer baujahr,
            String notiz) {}

    /** {@code PUT /api/v1/orte/{id}/flaeche}: ganze m² ab einem Tag (E3); fehlend = heute. */
    public record Flaeche(Integer m2, LocalDate gueltigAb) {}

    /** Das nächste freie Kurzzeichen für ein Gebäude oder einen Bereich; der Zähler bleibt stehen. */
    public record Vorschlag(String kurzzeichen) {}

    /** Eine Zuordnung an den Elternknoten; {@code zustand}: gueltig · geplant · beendet. */
    public record Zuordnung(
            UUID elternId,
            String elternArt,
            String elternName,
            LocalDate gueltigAb,
            LocalDate gueltigBis,
            String zustand) {}

    /** Eine Bezugsfläche; {@code gueltigBis} ist der letzte Tag, einschließlich. */
    public record FlaechenStand(int m2, LocalDate gueltigAb, LocalDate gueltigBis, String zustand) {}

    /**
     * Wie weit ein „gültig ab“ vom Eintragstag entfernt ist (E2: erlaubt, aber sichtbar):
     * {@code art} rueckwirkend · ab_heute · geplant; {@code abzeichen} nur rückwirkend
     * („rückwirkend (14 Tage)“).
     */
    public record Rueckwirkung(String art, long tage, String abzeichen) {}

    /**
     * Ein Gebäude oder Bereich nach dem Schreiben. {@code standortId}: der Standort, an dessen
     * Baum der Ort heute hängt (sonst der seines ersten Tages). {@code zuordnungen} und
     * {@code flaechen}: die wirksamen Intervalle, nach Beginn. {@code rueckwirkung} gehört zu
     * dem „gültig ab“, das dieser Vorgang eingetragen hat — {@code null} beim Bearbeiten
     * (einfache Felder gelten ab sofort). Gebäude und Bereiche tragen keine Zeitzone: sie
     * erben die des Standorts (Regel 11, A16).
     */
    public record Ort(
            UUID id,
            String art,
            String kurzzeichen,
            String name,
            List<String> nutzung,
            Integer baujahr,
            String notiz,
            String zustand,
            UUID standortId,
            List<Zuordnung> zuordnungen,
            List<FlaechenStand> flaechen,
            Rueckwirkung rueckwirkung) {}
}
