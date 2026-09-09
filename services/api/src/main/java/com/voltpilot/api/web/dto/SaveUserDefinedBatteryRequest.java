package com.voltpilot.api.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Was der Batterie-Anschluss speichert (P5 Ebene 1, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b): eine Batterie = ihr Broker + ihre
 * Feld-Zuordnung.
 *
 * <p><b>Hier steht bewusst KEINE Bean-Validation über die Form hinaus</b> - die
 * {@link com.voltpilot.api.web.dto.SaveSelfBuildRequest}-Disziplin: was eine
 * Zuordnung darf (Ziel-Kanal, Topic-Filter, Wertepfad, Aggregat, Skalierung,
 * Haltbarkeit, die LAN-Regel) entscheidet
 * {@link com.voltpilot.api.components.UserDefinedBatteryDefinition} an EINER
 * Stelle. Zwei Vokabulare für dieselbe Frage wären genau die Doppeldeutigkeit,
 * die dieses Modell beseitigt.
 *
 * @param socDerivation der ANDOCKPUNKT für die SoC-Ableitung (Ebene 2, P5b).
 *     Heute ist nur {@code direct} gebaut - „die Quelle liefert einen echten
 *     Ladestand". Die rechnenden Methoden ({@code ocv_curve},
 *     {@code coulomb}) werden BENANNT abgelehnt, nicht still gespeichert: eine
 *     gespeicherte Methode, die niemand ausführt, wäre eine Zusage ohne Werk.
 */
public record SaveUserDefinedBatteryRequest(
        @Size(max = 200) String label,
        @NotNull @Valid Broker broker,
        @NotNull @Valid List<MappingRequest> mappings,
        Integer publishIntervalS,
        @Valid SocDerivationRequest socDerivation,
        @Size(max = 200) String note) {

    /** Wo der MQTT-Broker im Netz des Kunden steht. */
    public record Broker(
            @Size(max = 253) String host,
            Integer port) {}

    /** Eine Feld-Zuordnung, wie sie eine Zeile des Assistenten schickt. */
    public record MappingRequest(
            @Size(max = 64) String channel,
            @Size(max = 200) String topic,
            @Size(max = 200) String path,
            @Size(max = 16) String aggregate,
            @Size(max = 16) String valueType,
            Double scale,
            Double offset,
            Double sentinel,
            Integer staleS,
            @Size(max = 16) List<String> trueValues,
            @Size(max = 16) List<String> falseValues) {}

    /** Wie der Ladestand entsteht (Ebene 2). */
    public record SocDerivationRequest(@Size(max = 32) String method) {}
}
