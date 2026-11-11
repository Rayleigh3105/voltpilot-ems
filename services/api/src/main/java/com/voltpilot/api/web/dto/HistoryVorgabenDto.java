package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * <b>Die Vorgaben einer Erzeugeranlage „Nach Art“</b> (UEMS EZ-9, Konzept vp-erzeuger-wago-konzept §4.5, EW-12 A) -
 * wie oft und wie lange Netzbetreiber und Direktvermarkter im Zeitraum geregelt haben und wie oft eine Einheit für den
 * Direktvermarkter nicht bereit war. Additiv auf {@link HistoryDto}; {@code null} für jede Anlage ohne
 * Anlagensteuerung.
 *
 * <p><b>Gezählt hat EZ-7</b> ({@code VorgabenZaehlung}): eine Vorgabe zählt einmal in jedem Abschnitt, den sie berührt,
 * mit ihrem Anteil an Dauer und geschätzter Energie darin; je Urheber ist die Dauer vereinigt. Darum steht die Zahl des
 * ganzen Zeitraums hier, statt sie aus den Ereignissen (je Tag gebündelt) zu summieren - eine Vorgabe über Mitternacht
 * wäre dort zweimal gezählt.
 *
 * @param verarbeitetBis bis wohin der Vorgaben-Läufer die Anlage ausgewertet hat; {@code null} = noch nie
 * @param zaehlung       je Art der ganze Zeitraum ({@code periode} null) samt den Einheiten, im Jahr dazu je Monat
 */
public record HistoryVorgabenDto(Instant verarbeitetBis, List<Zaehlung> zaehlung) {

    /**
     * Eine Zeile der Zählung.
     *
     * @param periode        {@code null} = der ganze Zeitraum; {@code JJJJ-MM} = ein Monat (nur im Jahr)
     * @param type           {@code netzbetreiber}, {@code direktvermarkter} oder {@code nicht-bereit}
     * @param teNr           {@code null} = die ganze Anlage (beim Netzbetreiber und Direktvermarkter) bzw. alle
     *                       Einheiten zusammen (bei „nicht bereit“); sonst die Einheit
     * @param einheitName    ihr Name aus dem Aufbau
     * @param anzahl         Vorgaben, die den Abschnitt berühren
     * @param minutes        ihre Dauer darin; je Urheber vereinigt, „nicht bereit“ über die Einheiten summiert
     * @param energyKwh      geschätzt nicht erzeugte Energie darin; {@code null} = keine Schätzung bekannt
     * @param wertEur        deren Euro-Schätzung zu den Preisen der Anlage; {@code null} ohne Preisgrundlage
     * @param ohneSchaetzung wie viele Vorgaben keine Energie-Schätzung haben
     * @param unvollstaendig wie viele Vorgaben Datenlücken haben
     * @param arten          die Anzahl je Art aus EZ-7 ({@code p_begrenzung}, {@code abschaltung},
     *                       {@code q_vorgabe}, {@code dv_aktivierung}, {@code dv_stopp}, {@code nicht_bereit})
     * @param luecken        Datenlücken mit weiteren Wechseln, die im Abschnitt beginnen
     * @param weitereWechsel deren weitere Wechsel zusammen; {@code null} = keine Lücke oder eine Zahl unbekannt
     */
    public record Zaehlung(
            String periode,
            String type,
            Integer teNr,
            String einheitName,
            int anzahl,
            long minutes,
            BigDecimal energyKwh,
            BigDecimal wertEur,
            int ohneSchaetzung,
            int unvollstaendig,
            Map<String, Integer> arten,
            int luecken,
            Integer weitereWechsel) {
    }
}
