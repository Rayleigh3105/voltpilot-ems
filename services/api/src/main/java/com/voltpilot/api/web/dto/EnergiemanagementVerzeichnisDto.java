package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * UEMS AP-19 IP-8: das Verzeichnis (VZ1–VZ4, G1, G4) — jede Entscheidung und jeder Nachweis mit seinen Trägern und dem
 * Ort des Originals, gruppiert nach Gegenstand. Gelesen über die Dienste der Quellen, nichts kopiert; keine Zahl über
 * das Ganze.
 */
public final class EnergiemanagementVerzeichnisDto {
    private EnergiemanagementVerzeichnisDto() {}

    /**
     * Eine Zeile — die Ausgabe der Operation {@code verzeichnis_zeile} (VZ2): {@code nr} ist Fassung oder Nr.,
     * {@code ort} eine der drei Stufen mit Zeile ({@code in_voltpilot · wortlaut_original_beim_kunden · verweis}),
     * {@code ort_satz} ihr Wort, beim Original des Kunden mit „: &lt;Ablage&gt;“. Was die Quelle nicht trägt, bleibt
     * {@code null} — nie „fehlt“.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zeile(String gruppe, String art, String kennzeichen, String titel, Integer nr, String entschiedenVon,
            String eingetragenVon, LocalDate tag, String pruefsumme, String ort, String gruppeWort, String ortSatz) {}

    /** Eine Zeile des Zuschnitts (§3.2): der Teil des Gegenstands und seine Stufe als Wort (G1). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zuschnitt(String teil, String stufe) {}

    /**
     * Eine der elf Gruppen (VZ3) in der Reihenfolge des Vokabulars {@code verzeichnis_gruppe}; ohne Zeile steht
     * {@code satz} „Hier ist noch nichts festgehalten.“ und {@code zuschnitt} nennt, wie der Gegenstand geführt wird.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Gruppe(String gruppe, String gruppeWort, List<Zuschnitt> zuschnitt, String satz, List<Zeile> zeilen) {}

    /** Die Filter der Anfrage, so wie sie gewirkt haben; {@code person_name} ist der Name der gewählten Person. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Filter(String gruppe, LocalDate von, LocalDate bis, UUID person, String personName) {}

    /**
     * {@code GET /api/v1/energiemanagement/verzeichnis}: der Stichtag des Abrufs (in der Zeitzone des Unternehmens),
     * der Verantwortungs-Satz, die Filter und die Gruppen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Verzeichnis(OffsetDateTime stichtag, String verantwortung, Filter filter, List<Gruppe> gruppen) {}
}
