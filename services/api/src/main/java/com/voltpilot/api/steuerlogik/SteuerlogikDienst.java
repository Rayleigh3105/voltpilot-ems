package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
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
     * Gestellte Werte einer Logik: ihr Stand und je Kennung der Wert in der Form des Dokuments ({@code "72 °C"},
     * {@code "on"}, {@code "06:00"}, ein Wort, ein Zeitplan).
     */
    record Werte(long stand, Map<String, JsonNode> werte) {

        public static final Werte KEINE = new Werte(0, Map.of());
    }

    /**
     * Was die API für ein Artefakt mitgibt: den Text, wie er kam, die Identität, den Ort und den Registry-Inhalt der
     * Anlage (wie die Box ihn bekommt; der Dienst liest daraus die Geräte für die Proben, {@code null} = keiner).
     * Stufe 3: {@code scharf} baut das Artefakt einer scharfen Logik, {@code werte} reisen im Bündel ({@code null} =
     * keine, das Bündel bleibt wie in Stufe 2); {@code werteBehalten} gilt für eine neue Fassung - ein Wert, der
     * nicht mehr passt, fällt auf seine Vorgabe zurück und steht in {@link Artefakt#verworfen()}, statt die Fassung
     * abzulehnen (Bericht 8.9).
     */
    record Auftrag(String text, UUID logikId, int fassung, Instant gebautAm, Ort ort, String registry,
            boolean scharf, Werte werte, boolean werteBehalten) {

        public Auftrag(String text, UUID logikId, int fassung, Instant gebautAm, Ort ort, String registry) {
            this(text, logikId, fassung, gebautAm, ort, registry, false, null, false);
        }
    }

    /** Ein gestellter Wert, den eine neue Fassung nicht übernimmt, mit dem Grund. */
    record Verworfen(String kennung, String grund) {}

    /**
     * Das gebaute Artefakt und der Prüfbericht; dazu die Werte, die das Bündel trägt ({@code null} ohne), und die,
     * die eine neue Fassung verworfen hat.
     */
    record Artefakt(JsonNode artefakt, JsonNode bericht, Werte werte, List<Verworfen> verworfen) {

        public Artefakt(JsonNode artefakt, JsonNode bericht) {
            this(artefakt, bericht, null, List.of());
        }
    }

    /**
     * Liest, prüft und baut. Eine unlesbare oder von der Prüfung gesperrte Logik und ein nicht erreichbarer Dienst
     * sind eine {@link SteuerlogikDienstException} mit Grund und deutschem Satz.
     */
    Artefakt artefakt(Auftrag auftrag);
}
