package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Formen der Messstellen-Schnittstelle (UEMS AP-04 IP-3, {@code /api/v1/messstellen}).
 *
 * <p>Anders als der Rest der API in snake_case: die Antwort IST eine Messstelle nach
 * {@code docs/contracts/v2/messstelle.schema.json} — dieselben Feldnamen, dieselben Wörter —
 * plus vier Felder der Schnittstelle ({@code id}, {@code fehlt}, {@code angehalten_ab},
 * {@code archiviert_am}). {@code MessstelleApiTest} hält die Antwort ohne diese vier am Schema
 * fest.
 */
public final class MessstelleDto {
    private MessstelleDto() {}

    /** Eine Messgröße wie {@code $defs/groesse} des Vertrags. */
    public record Groesse(String groesse, String richtung, String einheit, String wertart) {}

    /**
     * Eine Messstelle. Bis IP-7 (Ort, Stellung) und IP-13 (Quellen) sind {@code orte},
     * {@code elektrische_stellung}, {@code fuehrende_quelle} und {@code vergleichsquellen} immer
     * leer und {@code kadenz_s} leer — deshalb ist eine gemessene Messstelle hier ehrlich ein
     * Entwurf mit {@code fehlt: ["ort"]}. {@code lebenszyklus} und {@code fehlt} leitet
     * {@code MessstelleRegeln.lebenszyklus} aus den gespeicherten Eingängen ab.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Messstelle(
            UUID id,
            String schemaVersion,
            String kennzeichen,
            String name,
            String art,
            String medium,
            Groesse hauptgroesse,
            List<Object> fuehrendeQuelle,
            List<Object> vergleichsquellen,
            List<Nebengroesse> nebengroessen,
            List<Object> orte,
            List<Object> elektrischeStellung,
            Integer kadenzS,
            String lebenszyklus,
            List<String> fehlt,
            String notiz,
            OffsetDateTime angehaltenAb,
            OffsetDateTime archiviertAm) {}

    /** Eine Nebengröße wie {@code $defs/nebengroesse}: aktiv oder archiviert (einzeln oder mit der Messstelle). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Nebengroesse(
            String groesse,
            String richtung,
            String einheit,
            String wertart,
            String lebenszyklus,
            List<Object> fuehrendeQuelle,
            List<Object> vergleichsquellen) {}

    /**
     * Die Liste als Objekt, nicht als nacktes Array: das Register (IP-4) ergänzt Filter,
     * Stichtag und {@code teilansicht} (AP-03), ohne die Form zu brechen.
     */
    public record Liste(List<Messstelle> messstellen) {}

    /** Das nächste automatische Kennzeichen — der Zähler bewegt sich erst beim Speichern. */
    public record Vorschlag(String kennzeichen) {}

    /**
     * {@code POST /api/v1/messstellen}. {@code kennzeichen} leer (fehlend oder {@code null}) =
     * automatisch; {@code name} leer = fehlt noch (Entwurf). Art, Medium und Hauptgröße sind
     * danach nie mehr änderbar.
     */
    public record Anlegen(
            String kennzeichen,
            String name,
            String art,
            String medium,
            Groesse hauptgroesse,
            List<Groesse> nebengroessen,
            String notiz) {}

    /** {@code PUT /api/v1/messstellen/{id}}: die drei änderbaren Felder, ganz (fehlend = leer). */
    public record Bearbeiten(String kennzeichen, String name, String notiz) {}

    /**
     * {@code POST …/anhalten|fortsetzen|archivieren}. {@code zeitpunkt} auf die Minute mit
     * Versatz (E2), fehlend = jetzt; {@code grund} frei, steht im Änderungsprotokoll.
     */
    public record Uebergang(OffsetDateTime zeitpunkt, String grund) {}
}
