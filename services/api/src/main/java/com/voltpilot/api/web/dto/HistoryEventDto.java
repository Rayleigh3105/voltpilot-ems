package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

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
 *       Börsenpreise (gemessen an der gespeicherten Preisreihe), bei denen die
 *       Einspeisung dieser Anlage wirklich Geld kostet.</li>
 *   <li>{@code keine-verguetung} - dieselbe negative Preislage, aber die
 *       Anlage hat § 51a EEG (Solarspitzengesetz): ihre sonst feste
 *       Einspeisevergütung ist in diesen Viertelstunden auf 0 geklemmt, kein
 *       echter negativer Satz (Konzept {@code vp-fahrplan-eigenverbrauch-konzept}
 *       §4.7/§9, Scheibe S4). Kein {@code value}/{@code unit} - der auffällige
 *       Fakt ist das Ausbleiben der Vergütung, keine Zahl.</li>
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
 *   <li>{@code netzbetreiber}, {@code direktvermarkter}, {@code nicht-bereit} -
 *       die Vorgaben einer Erzeugeranlage (UEMS EZ-9, EW-12 A): wer die Anlage
 *       begrenzt oder gesteuert hat und wann eine Einheit für den
 *       Direktvermarkter nicht bereit war. Quelle sind die abgeleiteten
 *       Vorgaben aus {@code erzeuger_vorgabe} (EZ-7), keine neue Messung; die
 *       Einzelheiten stehen in {@link Vorgabe}.</li>
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
 * @param vorgabe die Vorgabe hinter einem Ereignis der Arten {@code netzbetreiber},
 *                {@code direktvermarkter} und {@code nicht-bereit}; sonst {@code null}
 *                und dann nicht in der Antwort (die anderen Arten bleiben bytegleich)
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
        List<Fact> facts,
        @JsonInclude(JsonInclude.Include.NON_NULL) Vorgabe vorgabe) {

    /** Ein Ereignis ohne Vorgabe (alle Arten vor EZ-9). */
    public HistoryEventDto(String type, Instant start, Instant end, String text, BigDecimal value,
            String unit, boolean planned, long minutes, int count, int days, List<Fact> facts) {
        this(type, start, end, text, value, unit, planned, minutes, count, days, facts, null);
    }

    /** Ein einzelnes Fenster ohne eigene Zahl (Lücke, stilles Gerät). */
    public HistoryEventDto(String type, Instant start, Instant end, String text) {
        this(type, start, end, text, null, null, false,
                Duration.between(start, end).toMinutes(), 1, 1, List.of());
    }

    /** Ein Fakt mit Bezeichnung und fertig formatiertem Wert, z. B. „Speicher leer" / „02:45". */
    public record Fact(String label, String value) {
    }

    /**
     * <b>Die Vorgabe hinter einem Ereignis</b> (UEMS EZ-9) - im Tag genau eine
     * Vorgabe oder eine Datenlücke mit weiteren Wechseln, ab der Woche das
     * Bündel eines Tages bzw. Monats. {@code start}/{@code end} des Ereignisses
     * sind auf den Zeitraum geschnitten; den wirklichen Beginn und das Ende
     * trägt dieses Feld. Unbekannt ist {@code null}, nie 0.
     *
     * @param id             die Vorgabe ({@code GET …/erzeuger/vorgaben/{id}}); {@code null} bei
     *                       einer Lücke und im Bündel
     * @param urheber        {@code netzbetreiber}, {@code direktvermarkter} bzw. {@code anlage}
     *                       („nicht bereit“ meldet die Einheit selbst)
     * @param art            die Art aus EZ-7 ({@code p_begrenzung}, {@code abschaltung},
     *                       {@code q_vorgabe}, {@code dv_aktivierung}, {@code dv_stopp},
     *                       {@code nicht_bereit}); {@code null} bei Lücke und Bündel
     * @param teNr           die Einheit; {@code null} = die ganze Anlage
     * @param einheitName    ihr Name aus dem Aufbau
     * @param beginn         der wirkliche Beginn (kann vor dem Zeitraum liegen); im Bündel {@code null}
     * @param beginnGenau    über „seit“ genau datiert
     * @param ende           das wirkliche Ende; {@code null} = läuft oder Bündel
     * @param laeuft         die Vorgabe läuft noch (belegt bis zur letzten Lesung, in der sie galt)
     * @param vorgabeProzent die kleinste Vorgabe in % der installierten Leistung
     * @param vorgabeW       die kleinste Vorgabe in W (beim Direktvermarkter der Abruf)
     * @param bindung        {@code bindend} (die Anlage folgte ihr: sie war die wirksame Grenze),
     *                       {@code nicht_bindend} (eine andere Grenze war strenger) oder {@code null}
     * @param wertEur        die Euro-Schätzung der nicht erzeugten Energie im Zeitraum; {@code null}
     *                       ohne Preisgrundlage
     * @param unvollstaendig wie viele davon Datenlücken haben (im Tag 0 oder 1)
     * @param luecken        wie viele Datenlücken mit weiteren Wechseln darin liegen
     * @param weitereWechsel deren weitere Wechsel zusammen; {@code null} = unbekannt (Neustart) oder
     *                       keine Lücke
     * @param gruende        die Gründe für „nicht bereit“ ({@code stoerung}, {@code gasspeicher_leer}, …)
     */
    public record Vorgabe(
            UUID id,
            String urheber,
            String art,
            Integer teNr,
            String einheitName,
            Instant beginn,
            boolean beginnGenau,
            Instant ende,
            boolean laeuft,
            BigDecimal vorgabeProzent,
            BigDecimal vorgabeW,
            String bindung,
            BigDecimal wertEur,
            int unvollstaendig,
            int luecken,
            Integer weitereWechsel,
            List<String> gruende) {
    }
}
