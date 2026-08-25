package com.voltpilot.api.cockpit;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Welches Profil-PRESET für die KUNDEN-Fläche gilt (Anwendungs-Programm
 * Stufe 4, Scout {@code vp-portal-zielbild-anwendungen} §3.5 / Captain-Entscheid
 * E1) — rein, ohne Datenbank, ohne Spring, ohne Uhr (das
 * {@code Tagesprotokoll}/{@code FleetPflege}-Muster).
 *
 * <p><b>Warum es die Frage überhaupt gibt.</b> Ein Profil ({@code site.profil},
 * Stufe 2) hängt an der ANLAGE — eine Organisation darf eine Privat- und eine
 * Gewerbe-Anlage besitzen (§3.1 Schärfung 3). Das Portfolio-Cockpit hängt am
 * KUNDEN. Für seine Preset-Schicht (und für die Tonalität seiner Geld-Zahlen)
 * muss deshalb aus N Anlagen-Profilen EINES werden.
 *
 * <p><b>Die Regel: das häufigste GESETZTE Profil gewinnt.</b> Anlagen ohne
 * Profil zählen gar nicht mit — sie sind keine Stimme für irgendetwas, und
 * jede Bestandsanlage hat {@code NULL}. Ein GLEICHSTAND ergibt {@code null}:
 * eine Flotte, die zur Hälfte privat und zur Hälfte gewerblich ist, hat keine
 * Mehrheit, und eine geratene wäre genau die Behauptung, die dieses Haus
 * vermeidet. {@code null} heißt dann „kein Preset" — die Fläche steht auf dem
 * VoltPilot-Standard, byte-identisch zum Zustand vor dieser Stufe.
 *
 * <p><b>⚠ Das Preset ist NIE ein Signal der Ableitung</b> (E3, unverändert):
 * es ordnet die Fläche und wählt die Wortwahl beim Geld. WELCHE Anwendungen
 * eine Flotte hat, bleibt die Vereinigung dessen, was auf den Anlagen läuft.
 */
public final class PortfolioPreset {

    private PortfolioPreset() {
    }

    /**
     * Das Mehrheits-Profil einer Flotte, oder {@code null} (kein gesetztes
     * Profil, oder ein Gleichstand). Die Eingabe ist die {@code profil}-Spalte
     * je Anlage, {@code null}-Einträge eingeschlossen.
     */
    public static String mehrheitsProfil(List<String> profile) {
        if (profile == null || profile.isEmpty()) {
            return null;
        }
        Map<String, Integer> stimmen = new LinkedHashMap<>();
        for (String p : profile) {
            if (p == null || p.isBlank()) {
                continue;
            }
            stimmen.merge(p.trim(), 1, Integer::sum);
        }
        String fuehrend = null;
        int best = 0;
        boolean gleichstand = false;
        for (Map.Entry<String, Integer> e : stimmen.entrySet()) {
            if (e.getValue() > best) {
                best = e.getValue();
                fuehrend = e.getKey();
                gleichstand = false;
            } else if (e.getValue() == best) {
                gleichstand = true;
            }
        }
        return gleichstand ? null : fuehrend;
    }
}
