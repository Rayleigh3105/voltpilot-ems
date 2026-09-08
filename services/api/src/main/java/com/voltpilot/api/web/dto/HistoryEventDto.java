package com.voltpilot.api.web.dto;

import java.time.Instant;

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
 */
public record HistoryEventDto(
        String type,
        Instant start,
        Instant end,
        String text) {
}
