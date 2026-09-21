package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die Gemeinsame Steuerung einer Anlage (UEMS AP-15 IP-5; Vertrag {@code docs/contracts/v2/steuerungsverbund.md} §6).
 * Wörter sind die des Vokabulars {@code SteuerungsverbundVokabular} — Codes, keine Kundensätze; die Kundenfläche
 * (IP-23/IP-24) übersetzt sie.
 */
public final class GemeinsameSteuerungDto {

    private GemeinsameSteuerungDto() {}

    /**
     * Der Zustand. Ohne Gemeinsame Steuerung: {@code eingerichtet = false}, {@code zustand = nicht_eingerichtet}, alle
     * anderen Felder leer — die Anlage merkt nichts (I6). {@code zustand} ist die Stufe ({@code erklaert} …
     * {@code anteile_aktiv}, {@code angehalten}) oder {@code aufgeloest} (keine wirksamen Mitglieder mehr).
     *
     * @param fehlt           was zum {@code naechsterSchritt} fehlt — je Bedingung ein Wort des Ablehnungs-Vokabulars
     * @param warnungFuehrung Z1/W2 — nur OHNE Gemeinsame Steuerung: führende Box und Speicher-Box fallen auseinander
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Zustand(boolean eingerichtet, String zustand, String stufe, Long epoche, UUID netzanschlussId,
            List<Mitglied> mitglieder, String naechsterSchritt, List<Befund> fehlt, WarnungFuehrung warnungFuehrung) {}

    /** Ein wirksames Mitglied: Box, Rolle ({@code fuehrt} · {@code steuert_mit}), Messpunkt (Datenquelle, wahlfrei). */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Mitglied(UUID boxId, String rolle, UUID messpunktId, OffsetDateTime gueltigAb,
            OffsetDateTime bestaetigtAm) {}

    /** Ein Grund aus dem Ablehnungs-Vokabular; {@code boxId} bzw. {@code richtung} nur, wo er daran hängt. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Befund(String wort, UUID boxId, String richtung) {}

    /**
     * Z1 (W2): die Anlage hat keine Gemeinsame Steuerung, und ihre führende Box ist nicht die Box des Speichers —
     * Flows gehen an die eine, der Fahrplan an die andere. Wort {@code fuehrende_box_ist_nicht_speicher_box}.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record WarnungFuehrung(String wort, UUID fuehrendeBoxId, UUID speicherBoxId) {}

    /** Ein gewünschtes Mitglied aus {@code PUT {"mitglieder": […]}} — Mandant und Anlage kommen nie aus dem Körper. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record MitgliedWunsch(UUID boxId, String rolle, UUID messpunktId) {}
}
