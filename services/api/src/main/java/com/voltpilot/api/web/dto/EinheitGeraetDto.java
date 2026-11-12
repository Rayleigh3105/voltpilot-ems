package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * S5 (vp-mastr-mehrere-einheiten-konzept §5.1): die Geräte-Zuordnung einer
 * Anlage - jede bestehende Zuordnung einer PV-{@code register_einheit} zu
 * einem Messpunkt oder einer Erzeugungseinheit, dazu jedes PV-fähige Gerät,
 * das noch frei ist (für den Zuordnen-Dialog). Reine Anzeige - keine
 * Berechnung hängt an dieser Zuordnung.
 */
public record EinheitGeraetDto(List<Zeile> zuordnungen, List<Kandidat> freieGeraete) {

    /** Eine bestehende Zuordnung: welches Gerät speist welche Einheit. */
    public record Zeile(UUID id, UUID einheitId, UUID geraetId, String art, String bezeichnung) {
    }

    /** Ein noch nicht zugeordnetes PV-fähiges Gerät der Anlage. */
    public record Kandidat(UUID id, String art, String bezeichnung, BigDecimal nennleistungKw) {
    }
}
