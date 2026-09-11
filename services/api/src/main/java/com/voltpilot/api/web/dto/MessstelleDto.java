package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.LocalDate;
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
     * Eine Messstelle. {@code orte} und {@code elektrische_stellung} tragen ihre Zuordnungen
     * (AP-04 IP-7) — alle wirksamen Intervalle nach Beginn, aufgehobene nicht. Bis IP-13 (Quellen)
     * sind {@code fuehrende_quelle} und {@code vergleichsquellen} immer leer und {@code kadenz_s}
     * leer. Eine gemessene Messstelle ohne Ort ist ehrlich ein Entwurf mit {@code fehlt: ["ort"]}.
     * {@code lebenszyklus} und {@code fehlt} leitet {@code MessstelleRegeln.lebenszyklus} aus den
     * gespeicherten Eingängen ab.
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
            List<OrtZuordnung> orte,
            List<StellungZuordnung> elektrischeStellung,
            Integer kadenzS,
            String lebenszyklus,
            List<String> fehlt,
            String notiz,
            OffsetDateTime angehaltenAb,
            OffsetDateTime archiviertAm) {}

    /**
     * Ein Ort mit Gültigkeit wie {@code $defs/ortZuordnung}: {@code ort_art} unternehmen · standort ·
     * gebaeude · bereich, {@code kennzeichen} das Kurzzeichen des Orts ({@code U} = das
     * Unternehmen); {@code gueltig_bis} ist der LETZTE gültige Tag, {@code null} = offen.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record OrtZuordnung(String ortArt, String kennzeichen, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /**
     * Die elektrische Stellung mit Gültigkeit wie {@code $defs/stellungZuordnung}: {@code anlage}
     * ist die ID der Anlage, {@code unterzaehler_von} das heutige Kennzeichen der Bezug-Messstelle
     * (nur bei „Unterzähler“).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StellungZuordnung(
            String anlage, String stellung, String unterzaehlerVon, LocalDate gueltigAb, LocalDate gueltigBis) {}

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

    /**
     * {@code PUT …/{id}/ort}: der Ort ab dem Tag {@code gueltig_ab} — sein Kurzzeichen oder
     * {@code U} (das Unternehmen, nur berechnet). Das laufende Intervall endet am Vortag.
     * {@code korrektur: true} ersetzt statt dessen das Intervall, das an {@code gueltig_ab}
     * beginnt (das alte bleibt aufgehoben lesbar). {@code grund} steht im Protokoll.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record OrtAendern(String kennzeichen, LocalDate gueltigAb, Boolean korrektur, String grund) {}

    /**
     * {@code PUT …/{id}/stellung}: Anlage + Stellung (+ „Unterzähler von“ als Kennzeichen der
     * Bezug-Messstelle) ab dem Tag {@code gueltig_ab}; {@code korrektur} und {@code grund} wie beim Ort.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StellungAendern(UUID anlage, String stellung, String unterzaehlerVon, LocalDate gueltigAb,
            Boolean korrektur, String grund) {}

    /**
     * {@code GET …/{id}/standort?am=}: der Stand der Zuordnungen an einem Tag. {@code ort},
     * {@code pfad}, {@code standort} und {@code grund} sind die Verortung des Ortsbaum-Vertrags
     * (Familie {@code messstelle_standort}: verortet · am_unternehmen · nicht_verortet ·
     * ort_nicht_im_baum); dazu die Art des Orts, die ID des Standorts und die Stellung an dem Tag.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record StandortAm(LocalDate am, String ort, String ortArt, List<String> pfad, String standort,
            UUID standortId, String grund, StellungZuordnung elektrischeStellung) {}
}
