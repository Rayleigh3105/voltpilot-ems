package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Der Dienst neben der API (Steuerlogik Stufe 2, zweiter Teil; {@code edge-app/core/cmd/vp-logik-dienst}): er liest
 * eine Logik mit denselben Lesern wie die Box, prüft sie nach dem Vertrag ({@code docs/contracts/v2/steuerlogik.md})
 * und baut das Artefakt im Bündelformat {@code steuerlogik} samt Hash. Die API liest die Sprache nirgends selbst -
 * sie fragt nur diesen Dienst, so wird die Sprache nirgends ein zweites Mal anders gelesen.
 */
public interface SteuerlogikDienst {

    /** Ort der Anlage für Uhrzeit und Sonnenstand; Breite und Länge dürfen fehlen. */
    record Ort(String zeitzone, BigDecimal breite, BigDecimal laenge) {}

    /**
     * Was die API für ein Artefakt mitgibt: den Text, wie er kam, die Identität, den Ort und den Registry-Inhalt der
     * Anlage (wie die Box ihn bekommt; der Dienst liest daraus die Geräte für die Proben, {@code null} = keiner).
     */
    record Auftrag(String text, UUID logikId, int fassung, Instant gebautAm, Ort ort, String registry) {}

    /** Das gebaute Artefakt und der Prüfbericht. */
    record Artefakt(JsonNode artefakt, JsonNode bericht) {}

    /**
     * Liest, prüft und baut. Eine unlesbare oder von der Prüfung gesperrte Logik und ein nicht erreichbarer Dienst
     * sind eine {@link SteuerlogikDienstException} mit Grund und deutschem Satz.
     */
    Artefakt artefakt(Auftrag auftrag);
}
