package com.voltpilot.api.web.dto;

import com.voltpilot.api.uems.StandortLesemodell.Adresse;
import com.voltpilot.api.uems.StandortLesemodell.Lage;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import java.time.LocalDate;

/**
 * „Ort berichtigen" (vp-standort-konzept §6.1/§6.6, B1/B3/B6): EIN Schreibweg für Adresse und
 * Kartenpunkt statt dreien — {@code PUT /api/v1/sites/{id}/ort}. Schreibt Adresse und Lage des
 * Standorts, den Punkt DIESER Anlage und (aus dem Land abgeleitet, B6) die Gebotszone in einer
 * Transaktion; nie ein Datum (das ist eine Korrektur, kein Umzug — {@code AnlageUmzugService}
 * trägt „gültig ab").
 *
 * <p>„Umzug" (E1 = B, §7): {@code POST .../ort/umzug} ist der EIGENE Weg für eine wirkliche
 * Adressänderung statt einer Berichtigung — ein neuer Standort entsteht still mit der neuen
 * Adresse (er heißt wie die Anlage), die Anlage gehört ihm ab dem Umzugstag über den
 * vorhandenen Zuordnungsweg ({@code AnlageUmzugService}); der bisherige Standort bleibt
 * unverändert (anders als {@link Anfrage}, die ihn in-place berichtigt — ein Umzug betrifft nur
 * DIESE Anlage, nie ihre Geschwister am alten Standort).
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

    /**
     * Der Rumpf von {@code POST .../ort/umzug}: dieselben Felder wie {@link Anfrage}, dazu der
     * Umzugstag — fehlend = heute (in der Zeitzone des BISHERIGEN Standorts); nie in der Zukunft
     * (E1 = B, Lesart 1: der Punkt der Anlage hat keine Gültigkeit und wechselt beim Speichern).
     */
    public record UmzugAnfrage(Adresse adresse, Lage lage, LocalDate gueltigAb) {}

    /**
     * @param site die Anlage mit ihrem neuen Punkt und ihrer neuen Gebotszone
     * @param neuerStandort der still angelegte Standort (Lesemodell, nach dem Umzug: trägt die Anlage)
     * @param umzug dieselbe Form wie {@code PUT .../standort} (die Zuordnung, {@code bisher} nennt
     *     den bisherigen Standort) — das Portal setzt dieselben Folgen-Sätze wie bei „Gehört zu"
     *     ({@code folgenKarte}), keine zweite Sprache für dieselbe Sache. Danach prüft das Portal
     *     selbst (wie bei „Zuordnung korrigieren"), ob der bisherige Standort jetzt leer ist und
     *     bietet das Archivieren an.
     * @param boxZugestellt ob die Steuerlogik-Bündel mit Sonnenbezug neu gebaut und zugestellt wurden
     * @param wetterNachholungAngestossen ob der neue Punkt mehr als 2 km entfernt lag und das
     *     gespeicherte Wetter der Anlage deshalb verworfen und neu angefordert wurde
     */
    public record UmzugErgebnis(SiteDto site, StandortAmStichtag neuerStandort, AnlageUmzugDto.Umzug umzug,
            boolean boxZugestellt, boolean wetterNachholungAngestossen) {}
}
