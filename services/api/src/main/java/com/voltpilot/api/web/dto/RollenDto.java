package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Die DTOs der geraeteseitigen Rollen-Zuordnung (Konzept vp-agg-konzept2-f3 §2.3 „verwenden als",
 * vp-agg-konzept3-r8): der massgebliche Wert einer Geraete-Rolle ({@code pv}, {@code consumer}, {@code grid}) und der
 * kanonische, ueber alle Geraete zusammengefasste Rollen-Wert der Anlage. Kundentexte kommen erst
 * im Frontend — hier keine. snake_case in der Schnittstelle wie {@code MessstelleFormelDto}.
 */
public final class RollenDto {

    private RollenDto() {}

    /**
     * Ein zugeordneter Wert: ENTWEDER ein nativer Kanal ({@code art = messkanal}, {@code capability})
     * ODER ein Gesamtwert / eine berechnete Messstelle ({@code art = gesamtwert},
     * {@code quell_messstelle_id}). {@code name} ist ein Anzeigename des Werts.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wert(String art, String capability, UUID quellMessstelleId, String name) {}

    /** Der Anfrage-Koerper von {@code PUT …/komponenten/{entityId}/rollen/{role}}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Eingabe(String art, String capability, UUID quellMessstelleId) {}

    /** Anlage: Summenwert an allen gelesenen Geräten; ersetzen bestätigt den Austausch des Netzwerts. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnlageEingabe(String art, UUID quellMessstelleId, boolean ersetzen) {}

    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record AnlageAntwort(List<GeraetRolle> geraete) {}

    /**
     * Der massgebliche Rollen-Wert eines Geraets ({@code zugeordnet == null} = keine Zuordnung, das
     * Cockpit bleibt beim Rueckfall {@code telemetry.pv_power_kw}).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GeraetRolle(UUID entityId, String role, Wert zugeordnet) {}

    /**
     * Die Antwort auf ein Zuordnen: der jetzt massgebliche Wert und — beim Konfliktfall
     * (is_primary-Semantik) — der abgeloeste vorige Wert ({@code null}, wenn keiner abgeloest wurde).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record ZuordnungAntwort(Wert zugeordnet, Wert abgeloest) {}

    /**
     * Der Beitrag EINES Geraets zum kanonischen Rollen-Wert — ehrlich benannt: {@code liefernd}
     * mit {@code wert}, oder stumm mit {@code grund} ({@code kein_wert} · {@code veraltet} ·
     * {@code unvollstaendig} · {@code archiviert} · {@code kein_geraet}). Nie eine stille Teilsumme.
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record GeraetBeitrag(UUID entityId, String name, String art, Double wert, boolean liefernd,
            String grund) {}

    /**
     * {@code GET …/rollen/{role}}: der kanonische Rollen-Wert der Anlage — die (benannte) Summe der
     * liefernden Geraete-Zuordnungen. {@code zuordnung_vorhanden = false} heisst: keine Zuordnung,
     * das Cockpit faellt auf {@code telemetry.pv_power_kw} zurueck. {@code unvollstaendig} = mind.
     * ein zugeordnetes Geraet liefert gerade nicht (in {@code geraete} benannt).
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record KanonischerWert(String role, boolean zuordnungVorhanden, Double wert, String einheit,
            boolean unvollstaendig, List<GeraetBeitrag> geraete, OffsetDateTime stand) {}
}
