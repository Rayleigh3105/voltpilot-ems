package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * <b>Ein Ereignis im Verlauf</b> (Feature F6 des Historie-Konzepts
 * {@code data/vp-historie-konzept-t4}) - der Marker, der einen Ausreißer im
 * Diagramm ERKLÄRT, statt ihn nur zu zeigen. Additiv auf {@link HistoryDto},
 * damit ein älterer Client unverändert weiterläuft.
 *
 * <p>Anders als das {@link ProtocolEventDto Tagesprotokoll} (nur Tag, die
 * gewöhnlichen Ereignisse eines Tages als Liste) gibt es diese Spur in
 * <b>jedem</b> Zeitraum und sie enthält ausschließlich das <b>Auffällige</b>:
 *
 * <ul>
 *   <li>{@code negativpreis} - zusammenhängendes Fenster negativer
 *       Börsenpreise (gemessen an der gespeicherten Preisreihe).</li>
 *   <li>{@code abregelung} - vom Optimierer EINGEPLANTE PV-Abregelung
 *       ({@code schedule.curtail_kw}). Das ist eine Plan-Aussage, kein
 *       Messwert - der Text sagt es.</li>
 *   <li>{@code netzgrenze} - eine vom Gerät gemeldete §-14a-Netzgrenze
 *       ({@code telemetry.grid_limit_kw}). Nur Tag und Woche, siehe
 *       {@link com.voltpilot.api.history.Ereignisse#evaluatesGridLimit}.</li>
 *   <li>{@code netzladen} - der Speicher wurde aus dem Netz geladen
 *       (gemessene Viertelstunde: Ladung über der PV-Erzeugung bei
 *       gleichzeitigem Netzbezug).</li>
 *   <li>{@code abendverkauf} - der Fahrplan hat abends Energie VERKAUFT,
 *       erzählt mit der Nacht, die darauf folgte (Prognose gegen gemessene
 *       Last, leerer Speicher, Netzbezug). Nur im Tages-Zeitraum; jeder Satz
 *       ein persistierter Fakt, ein fehlender Fakt lässt seinen Satz weg.</li>
 *   <li>{@code datenluecke} - eine Fehlstelle in der Messreihe.</li>
 *   <li>{@code geraet-still} - die Messreihe bricht ab und es kam nichts mehr
 *       nach: das Gerät meldet sich nicht.</li>
 * </ul>
 *
 * <p><b>{@code text} ist die Aussage ohne Zeitangabe</b> (deutsch,
 * serverseitig formatiert wie im Tagesprotokoll) - die Zeit steht in
 * {@code start}/{@code end} und wird von der Oberfläche zeitraumgerecht davor
 * gesetzt. {@code end} ist exklusiv.
 *
 * <p><b>Die eine Zahl steht zusätzlich als Feld</b> (Konzept
 * {@code data/vp-verlauf-ereignisse-k1}): die Oberfläche zeigt je Ereignis
 * ein Wort und eine Zahl, statt sie aus dem Satz zu lesen. {@code value} ist
 * ungerundet, gerundet wird nur zur Anzeige.
 *
 * <p><b>Gebündelt ab der Woche:</b> im Tag ist jedes Ereignis ein Fenster;
 * in Woche und Monat fasst ein Ereignis die Fenster EINES Tages und einer Art
 * zusammen, im Jahr die eines Monats. {@code start} ist dann der Beginn des
 * ersten, {@code end} das Ende des letzten Fensters; {@code minutes} ist die
 * Summe der Fenster, nicht der Abstand von {@code start} bis {@code end}.
 *
 * @param value   die eine Zahl in {@code unit}: tiefster Börsenpreis
 *                ({@code ct/kWh}), geplante oder geladene bzw. verkaufte Energie
 *                ({@code kWh}), niedrigste gemeldete Netzgrenze ({@code kW});
 *                {@code null} bei Lücken und stillem Gerät (dort zählt die Dauer)
 * @param unit    {@code ct/kWh}, {@code kWh}, {@code kW} oder {@code null}
 * @param planned {@code true}, wenn das Ereignis aus dem Fahrplan stammt
 *                (Abregelung, Abendverkauf) und keine Messung ist
 * @param minutes Summe der Dauer aller Fenster in Minuten
 * @param count   Zahl der Fenster (1 im Tag)
 * @param days    Zahl der Tage mit einem Fenster (1 im Tag)
 * @param facts   die Fakten des Abendverkaufs als Liste; sonst leer
 */
public record HistoryEventDto(
        String type,
        Instant start,
        Instant end,
        String text,
        BigDecimal value,
        String unit,
        boolean planned,
        long minutes,
        int count,
        int days,
        List<Fact> facts) {

    /** Ein einzelnes Fenster ohne eigene Zahl (Lücke, stilles Gerät). */
    public HistoryEventDto(String type, Instant start, Instant end, String text) {
        this(type, start, end, text, null, null, false,
                Duration.between(start, end).toMinutes(), 1, 1, List.of());
    }

    /** Ein Fakt mit Bezeichnung und fertig formatiertem Wert, z. B. „Speicher leer" / „02:45". */
    public record Fact(String label, String value) {
    }
}
