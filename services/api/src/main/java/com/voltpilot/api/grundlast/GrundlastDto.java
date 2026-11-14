package com.voltpilot.api.grundlast;

import java.time.LocalDate;
import java.util.List;

/**
 * Antwort von {@code GET /api/v1/sites/{siteId}/grundlast} – die Zahlen der Karte „Grundlast“ im Verlauf
 * und der Kachel im Cockpit (Bedienkonzept Privatkunde §5, Variante A). Watt sind ungerundet bis auf ganze
 * Watt; die Anzeige rundet auf 10 W. Vertrag: {@code docs/contracts/openapi.yaml} → {@code Grundlast}.
 *
 * @param z der Zeitraum: {@code tag | woche | monat | jahr | aktuell} (aktuell = die letzten 14 Nächte)
 * @param von erste Nacht des Zeitraums (Datum)
 * @param bis letzte Nacht des Zeitraums (Datum, eingeschlossen)
 * @param hausverbrauchGemessen ob die Anlage je einen Hausverbrauch gemessen hat; {@code false} = weder
 *     Karte noch Kachel
 * @param typischW die typische Nacht (Median), {@code null} unter der Mindestzahl gewerteter Nächte
 * @param gewertet gewertete Nächte des Zeitraums
 * @param mindestens so viele gewertete Nächte braucht die Zahl (Tag 1, sonst 3)
 * @param luecken Nächte nach Messbeginn, die zu wenige Messwerte hatten
 * @param naechte je Nacht (nicht im Jahr)
 * @param monate je Monat (nur im Jahr)
 * @param kwhAmTag typische Nacht × 24 h
 * @param anteil Grundlast über die gemessene Dauer ÷ Verbrauch derselben Dauer (0..1, ungeklemmt)
 * @param vorperiodeW die typische Nacht des Zeitraums davor (Vornacht, Vorwoche, Vormonat, Vorjahr; bei
 *     {@code aktuell}: dieselben 14 Nächte einen Monat früher)
 * @param stufe die deutlichste Stufe im Monat, sonst {@code null}
 * @param teile je Unterzähler (leer ohne Unterzähler oder ohne typische Nacht)
 * @param rest „übriger Haushalt“, {@code null} ohne Teile
 */
public record GrundlastDto(String z, LocalDate von, LocalDate bis, boolean hausverbrauchGemessen, Double typischW,
        int gewertet, int mindestens, int luecken, List<NachtDto> naechte, List<MonatDto> monate, Double kwhAmTag,
        Double anteil, Double vorperiodeW, StufeDto stufe, List<TeilDto> teile, RestDto rest) {

    /**
     * Eine Nacht.
     *
     * @param status {@code gewertet | luecke | vorher | offen}
     * @param w Nachtwert (nur bei {@code gewertet})
     */
    public record NachtDto(LocalDate datum, String status, Double w) {}

    /** Ein Monat der Jahresansicht ({@code monat} = {@code JJJJ-MM}); {@code w == null} unter 7 Nächten. */
    public record MonatDto(String monat, Double w, int gewertet) {}

    /** Ab {@code seit} liegt die Grundlast deutlich anders als davor. */
    public record StufeDto(LocalDate seit, Double vorherW, Double nachherW) {}

    /** Ein Unterzähler (oder ein anderer gemessener Teil an der Wurzel) und seine Leistung in der Nacht. */
    public record TeilDto(String entityId, String label, String typLabel, boolean unterzaehler, Double w) {}

    /**
     * Der Rest.
     *
     * @param grund {@code teil_ohne_wert | teile_mehr_als_haus}, wenn es keine Zahl gibt
     */
    public record RestDto(Double w, String grund) {}
}
