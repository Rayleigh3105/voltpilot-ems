package com.voltpilot.api.anlagencheck;

import java.time.LocalDate;
import java.util.List;

/**
 * Antwort von {@code GET /api/v1/sites/{id}/anlagen-check}: die Kachel „Solaranlage" ({@link #kachel}, immer die
 * letzten 7 bzw. 14 abgeschlossenen Tage) und die Karte „Erzeugung nach Einheiten" ({@link #zeitraum}, folgt dem
 * Zeitraum des Verlaufs). Zahlen ungerundet; das Portal rundet nur zur Anzeige.
 *
 * @param pv {@code false}: die Anlage erzeugt keinen Solarstrom - keine Kachel, keine Karte
 * @param modus {@code einheiten} (mindestens zwei Einheiten mit gemessenem Gerät) oder {@code ganze_anlage}
 * @param ohneGeraet Namen der PV-Einheiten, die im Einheiten-Modus mangels gemessenem Gerät nicht verglichen werden
 */
public record AnlagenCheckDto(boolean pv, String modus, UrteilDto kachel, ZeitraumDto zeitraum,
        List<String> ohneGeraet) {

    /**
     * @param gesamt {@code wie_erwartet}, {@code weniger}, {@code messwerte_fehlen}, {@code zu_wenig_sonne},
     *     {@code noch_zu_frueh}
     * @param sonnenTage gewertete Sonnentage (ohne abgeregelte)
     */
    public record UrteilDto(String gesamt, LocalDate von, LocalDate bis, int fensterTage, int sonnenTage,
            int abgeregelteTage, List<EinheitDto> einheiten) {}

    /**
     * @param gemessenKwh in der Kachel: über die gewerteten Tage; in der Karte: über alle Tage des Zeitraums
     * @param verhaeltnis gemessen ÷ erwartet über die gewerteten Tage, {@code null} ohne Urteil
     * @param zustand {@code wie_erwartet}, {@code weniger}, {@code fehlt}, {@code offen}
     */
    public record EinheitDto(String id, String name, Double gemessenKwh, Double erwartetKwh, Double verhaeltnis,
            String zustand, LocalDate keineWerteSeit, LocalDate wenigerSeit, int gewerteteTage) {}

    /**
     * @param z der Zeitraum ({@code tag}, {@code woche}, {@code monat}, {@code jahr})
     * @param von erster Tag des Zeitraums
     * @param bis letzter Tag des Zeitraums
     * @param bisAbgeschlossen letzter abgeschlossener Tag im Zeitraum; {@code null}: noch keiner (heute)
     * @param gesamt das Urteil über den Zeitraum; {@code null} für einen einzelnen Tag
     * @param eimer {@code tag} oder {@code monat} (Jahr)
     */
    public record ZeitraumDto(String z, LocalDate von, LocalDate bis, LocalDate bisAbgeschlossen,
            Double gemessenKwh, Double erwartetKwh, String gesamt, int sonnenTage, int abgeregelteTage,
            List<EinheitDto> einheiten, String eimer, List<SaeuleDto> saeulen) {}

    /** Eine Säule: Beginn des Eimers und die gemessenen kWh je Einheit in der Reihenfolge von {@code einheiten}. */
    public record SaeuleDto(LocalDate start, List<Double> kwh) {}
}
