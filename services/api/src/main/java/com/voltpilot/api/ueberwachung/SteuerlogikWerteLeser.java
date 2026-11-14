package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.steuerlogik.SteuerlogikService;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Der {@code steuerlogik}-Leser (Steuerlogik Stufe 3, Bericht 8.5 und 17.5): "Störung einer Logik" ab Werk
 * eingeschaltet an jeder Anlage mit einer scharfen Logik. Liest GENAU die Störungen, die die Karte der Logik zeigt
 * ({@link SteuerlogikService#karten}) - nie eine eigene Abfrage: die Box lehnt die Fassung ab, die Logik läuft auf der
 * Box nicht (sie hält an), die Box schaltet nicht nach ihr, die Lage ist eine Störung, ein Fühler hat keinen Wert, ein
 * Gerät bekommt keinen Wunsch. Ausgenommen sind die Pause, die ein Mensch gewollt hat, und die Box, die sich nicht
 * meldet - die meldet schon {@code box.erreichbar}.
 *
 * <p>Mehrere Logiken an einer Anlage fassen sich zu EINEM Urteil zusammen: gestört, sobald eine es ist; der Satz
 * nennt die erste mit ihrem Namen.
 */
@Component
public class SteuerlogikWerteLeser implements WerteLeser {

    static final String FELD_STOERUNG = "stoerung";
    public static final String IN_ORDNUNG = "in_ordnung";
    public static final String STOERUNG = "stoerung";

    /** Keine Störung im Sinne der Meldung: gewollt angehalten, oder die Box ist weg (meldet box.erreichbar). */
    static final Set<String> KEINE_MELDUNG = Set.of("pausiert", "keine_meldung");

    private final SteuerlogikService logiken;

    public SteuerlogikWerteLeser(SteuerlogikService logiken) {
        this.logiken = logiken;
    }

    @Override
    public Lesung lese(WerteKatalog.Eintrag eintrag, Bezug bezug, Instant jetzt) {
        if (!"anlage".equals(bezug.art()) || !FELD_STOERUNG.equals(eintrag.leser().feld())) {
            return Lesung.unbekannt();
        }
        List<SteuerlogikService.Karte> karten;
        try {
            karten = logiken.karten(bezug.id());
        } catch (SteuerlogikService.Abgelehnt e) {
            return Lesung.unbekannt();
        }
        if (karten.isEmpty()) {
            return Lesung.unbekannt();
        }
        for (SteuerlogikService.Karte k : karten) {
            for (SteuerlogikService.Stoerung s : k.stoerungen()) {
                if (!KEINE_MELDUNG.contains(s.code())) {
                    return Lesung.zustand(STOERUNG, jetzt, "Logik „" + k.fassung().name() + "“: " + s.text());
                }
            }
        }
        return Lesung.zustand(IN_ORDNUNG, jetzt);
    }
}
