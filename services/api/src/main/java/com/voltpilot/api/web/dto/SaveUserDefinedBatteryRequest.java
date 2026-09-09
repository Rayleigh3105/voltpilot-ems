package com.voltpilot.api.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Was der Batterie-Anschluss speichert (P5 Ebene 1 + P5b Ebene 2, Konzept
 * {@code vp-deye-diybms-luecke-l5} §3.2b): eine Batterie = ihr Broker, ihre
 * Feld-Zuordnung und - seit P5b - wie aus diesen Rohwerten ihr Ladestand
 * entsteht.
 *
 * <p><b>Hier steht bewusst KEINE Bean-Validation über die Form hinaus</b> - die
 * {@link com.voltpilot.api.web.dto.SaveSelfBuildRequest}-Disziplin: was eine
 * Zuordnung darf (Ziel-Kanal, Topic-Filter, Wertepfad, Aggregat, Skalierung,
 * Haltbarkeit, die LAN-Regel) und was eine Ableitung braucht (Eingänge,
 * Kennlinien, Kapazität, Anker) entscheidet
 * {@link com.voltpilot.api.components.UserDefinedBatteryDefinition} an EINER
 * Stelle. Zwei Vokabulare für dieselbe Frage wären genau die Doppeldeutigkeit,
 * die dieses Modell beseitigt.
 *
 * @param socDerivation die SoC-Ableitung (Ebene 2, P5b). Alle drei Methoden
 *     sind gebaut: {@code direct} übernimmt einen gemessenen Ladestand,
 *     {@code ocv_curve} rechnet ihn aus der Spannungskennlinie,
 *     {@code coulomb} zählt ihn ab einem Anker. Fehlt der Block ganz, gilt
 *     {@code direct}, falls {@code soc_pct} zugeordnet ist - sonst hat die
 *     Batterie keinen Ladestand, und das ist ein legitimer Zustand.
 * @param binding die SPEISER-BINDUNG (P6): wozu diese Batterie in der Anlage
 *     gehört. Fehlt der Block, bleibt sie UNGEBUNDEN - ein Topologie-Knoten mit
 *     eigenen Messwerten, der nicht in die Energiebilanz eingeht. Eine Bindung
 *     entsteht nie von selbst (Captain-Entscheid E6).
 */
public record SaveUserDefinedBatteryRequest(
        @Size(max = 200) String label,
        @NotNull @Valid Broker broker,
        @NotNull @Valid List<MappingRequest> mappings,
        Integer publishIntervalS,
        @Valid SocDerivationRequest socDerivation,
        @Valid BindingRequest binding,
        @Size(max = 200) String note) {

    /**
     * Wozu diese Batterie gehört (P6).
     *
     * @param mode {@code unbound} | {@code feeds_inverter} | {@code standalone}
     * @param inverterEntityId der Hybrid-Wechselrichter, dessen Speicher-Knoten
     *     sie speist - nur bei {@code feeds_inverter}, und dort Pflicht
     */
    public record BindingRequest(
            @Size(max = 32) String mode,
            @Size(max = 64) String inverterEntityId) {}

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

    /**
     * Wie der Ladestand entsteht (Ebene 2).
     *
     * @param method {@code direct} | {@code ocv_curve} | {@code coulomb}
     * @param preferDirect ob eine FRISCHE Messung die Rechnung schlägt
     *     (Vorgabe {@code true} - die Auswahl-Logik aus §3.2b). Nur der
     *     Vergleichsbetrieb schaltet sie ab.
     * @param template die Kurven-VORLAGE, aus der die Stützpunkte kommen, wenn
     *     keine eigenen dastehen (heute {@code diybms-176s-nmc})
     * @param holdS wie lange ein eingefrorener Ladestand noch gehalten wird,
     *     bevor er ABWESEND ist und eine Zählung einen neuen Anker braucht
     */
    public record SocDerivationRequest(
            @Size(max = 32) String method,
            Boolean preferDirect,
            @Size(max = 64) String template,
            Integer holdS,
            @Valid SocInputsRequest inputs,
            @Valid SocParamsRequest params) {}

    /**
     * Welcher KANAL welche Rolle spielt. Jedes Feld ist optional; fehlt es,
     * gilt der gleichnamige Standard-Kanal.
     */
    public record SocInputsRequest(
            @Size(max = 64) String soc,
            @Size(max = 64) String cellMin,
            @Size(max = 64) String cellMax,
            @Size(max = 64) String voltage,
            @Size(max = 64) String current,
            @Size(max = 64) String power) {}

    /**
     * Die Rechenwerte. Eine Kennlinie ist eine Liste von Paaren
     * {@code [Zellspannung in V, Ladestand in %]}.
     */
    public record SocParamsRequest(
            @Size(max = 64) List<List<Double>> curveCharge,
            @Size(max = 64) List<List<Double>> curveDischarge,
            Integer cellsInSeries,
            Boolean conservativeMin,
            Double roundPct,
            Double capacityKwh,
            Double efficiencyPct,
            Double nominalVoltageV,
            Double refTempC,
            @Valid SocAnchorRequest anchor,
            @Valid SocRecalibrateRequest recalibrate) {}

    /** Der Startpunkt einer Ladungszählung. */
    public record SocAnchorRequest(Double socPct, @Size(max = 40) String at) {}

    /** Die Rekalibrierung an den Spannungs-Endpunkten (voll / leer). */
    public record SocRecalibrateRequest(
            Double fullCellMv,
            Double fullSocPct,
            Double emptyCellMv,
            Double emptySocPct) {}
}
