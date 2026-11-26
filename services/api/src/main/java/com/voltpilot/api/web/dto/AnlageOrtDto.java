package com.voltpilot.api.web.dto;

import com.voltpilot.api.uems.StandortLesemodell.Adresse;
import com.voltpilot.api.uems.StandortLesemodell.Lage;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;

/**
 * „Ort berichtigen" (vp-standort-konzept §6.1/§6.6, B1/B3/B6): EIN Schreibweg für Adresse und
 * Kartenpunkt statt dreien — {@code PUT /api/v1/sites/{id}/ort}. Schreibt Adresse und Lage des
 * Standorts, den Punkt DIESER Anlage und (aus dem Land abgeleitet, B6) die Gebotszone in einer
 * Transaktion; nie ein Datum (das ist eine Korrektur, kein Umzug — {@code AnlageUmzugService}
 * trägt „gültig ab").
 */
public final class AnlageOrtDto {

    private AnlageOrtDto() {}

    /**
     * Der Rumpf: die Adresse setzt den Pin (ein gewählter Vorschlag), der Pin fein ziehen ändert
     * nie die Adresse — der Client löst beides auf und schickt IMMER den fertigen Punkt mit;
     * der Server sucht nie selbst nach einer Adresse.
     */
    public record Anfrage(Adresse adresse, Lage lage) {}

    /**
     * @param site die Anlage mit ihrem neuen Punkt und ihrer neuen Gebotszone
     * @param standort der Standort mit seiner neuen Adresse und Lage (Lesemodell, wie {@code GET
     *     /api/v1/standorte/{id}})
     * @param boxZugestellt ob die Steuerlogik-Bündel mit Sonnenbezug neu gebaut und zugestellt wurden
     * @param wetterNachholungAngestossen ob der neue Punkt mehr als 2 km entfernt lag und das
     *     gespeicherte Wetter der Anlage deshalb verworfen und neu angefordert wurde
     */
    public record Ergebnis(SiteDto site, StandortAmStichtag standort, boolean boxZugestellt,
            boolean wetterNachholungAngestossen) {}
}
