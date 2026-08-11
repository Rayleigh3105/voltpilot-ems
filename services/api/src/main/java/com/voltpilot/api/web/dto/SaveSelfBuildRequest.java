package com.voltpilot.api.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Was die Selbstbau-Tür speichert (Einheitsmodell Stufe 3, Konzept
 * vp-modbus-baukasten-k6 §2.2/§2.3): ein Gerät = seine Verbindung + seine
 * Kanäle.
 *
 * <p><b>Hier steht bewusst KEINE Bean-Validation über die Form hinaus.</b> Was
 * ein Kanal darf - Adressbereich, Datentyp, Mindestabstand, Kanalzahl, die
 * LAN-Regel - entscheidet {@link com.voltpilot.api.components.SelfBuildDefinition},
 * und zwar an EINER Stelle: dieselben Regeln beantworten auch das „Jetzt lesen"
 * und die Vorschau. Zwei Vokabulare für dieselbe Frage wären genau die
 * Doppeldeutigkeit, die dieses Modell beseitigt. Die Annotationen hier decken
 * nur, was ohne Sachkenntnis entschieden werden kann (Anwesenheit, Länge).
 *
 * <p>Ebenso fehlt der {@code slug} eines Kanals mit Absicht: der Kunde vergibt
 * einen KLARTEXT-Namen, die Kennung leitet der Server ab. Getippte Kennungen
 * wären eine zweite Wahrheit über denselben Messwert.
 */
public record SaveSelfBuildRequest(
        @Size(max = 200) String label,
        @NotNull @Valid Connection connection,
        @NotNull @Valid List<ChannelRequest> channels,
        @Size(max = 200) String note) {

    /** Wo das Gerät im Netz des Kunden steht. */
    public record Connection(
            @Size(max = 253) String host,
            Integer port,
            Integer unitId) {}

    /** Ein Messwert, wie ihn die Kanal-Zeile des Assistenten schickt. */
    public record ChannelRequest(
            @Size(max = 120) String label,
            @Size(max = 16) String unit,
            @Size(max = 16) String registerKind,
            Integer address,
            @Size(max = 16) String dataType,
            @Size(max = 16) String wordOrder,
            Double scale,
            Double offset,
            Integer minReadIntervalS) {}
}
