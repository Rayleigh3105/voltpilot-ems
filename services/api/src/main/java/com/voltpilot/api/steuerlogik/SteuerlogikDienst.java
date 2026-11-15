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

    /**
     * Das Ergebnis der Prüfung ohne Artefakt (Stufe 4, Ansicht "Text"): lesbar mit kanonischer Form und Bericht - der
     * Bericht trägt {@code meldungen}, je Befund, Probe und Hinweis mit der Zeile im Text -, oder unlesbar mit dem
     * Satz des Lesers und seiner Meldung an der Zeile.
     */
    record Geprueft(boolean lesbar, String message, String kanonisch, JsonNode bericht, JsonNode meldungen) {}

    /**
     * Prüft einen Text mit denselben Regeln wie Box und Artefakt ({@code POST /pruefe}); die Geräte der Proben aus dem
     * Registry-Inhalt der Anlage. Ein nicht erreichbarer Dienst ist eine {@link SteuerlogikDienstException}.
     */
    Geprueft pruefe(String text, String registry);

    /**
     * Was eine Logik an der Anlage lesen und schalten kann ({@code POST /quellen}): feste Quellen, Fühler und Signale
     * eigener Modbus-Geräte, je Gerät die Ausgänge, die die Box ausführt - aus dem Registry-Inhalt der Anlage.
     */
    JsonNode quellen(String registry);

    /** Ein Baustein, wie die API ihn dem Dienst gibt: seine Kennung und sein Text (Stufe 5). */
    record BausteinText(String id, String text) {}

    /**
     * Liest Bausteine für eine Anlage ({@code POST /bausteine}): je Baustein Name, Satz, Lücken mit dem Vorschlag
     * der Anlage und ob jedes Gerät und jeder Fühler ein Gegenüber hat ({@code passt}); ein unlesbarer Baustein
     * kommt mit {@code lesbar: false} und Satz. Ein nicht erreichbarer Dienst ist eine
     * {@link SteuerlogikDienstException}.
     */
    JsonNode bausteine(List<BausteinText> bausteine, String registry);

    /**
     * Füllt einen Baustein für eine Anlage ({@code POST /baustein}): Lücken, Satz, die Logik als Text, ihr
     * Prüfbericht und die Proben nach der Uhrzeit ({@code verhalten}, "So verhält sie sich"); {@code vollstaendig}
     * sagt, ob sie sich so speichern lässt. Ein unlesbarer Baustein ist eine {@link SteuerlogikDienstException} mit
     * Grund {@link SteuerlogikDienstException#BAUSTEIN}.
     */
    JsonNode baustein(String text, JsonNode fuellung, String registry);

    /**
     * Macht aus dem Text einer Logik einen Baustein ({@code POST /baustein/aus-logik}): Geräte und Fühler werden
     * Lücken, ihre Kennungen bleiben in der Anlage. Antwort: {@code baustein} (der Text), {@code name}, {@code satz},
     * {@code luecken}. Ein Satz, der eine unbekannte Lücke nennt, ist eine {@link SteuerlogikDienstException} mit
     * Grund {@link SteuerlogikDienstException#BAUSTEIN}.
     */
    JsonNode ausLogik(String text, String name, String beschreibung, String satz);
}
