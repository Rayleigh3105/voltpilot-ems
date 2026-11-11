package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;

/**
 * Der 30-Tage-Probelauf (Alerting Scheibe 2, Konzept §6.4, §6.8 Entwurf 1: "die Überwachung zeigt,
 * was sie gemeldet HÄTTE, bevor sie scharf ist"): spielt denselben Zustandsautomaten wie
 * {@link UeberwachungsService#werte} - {@code normal → ausstehend → aktiv → erholend → normal},
 * dieselbe Hysterese aus {@link BedingungsPruefung} - über eine BEREITS VORLIEGENDE historische
 * Reihe nach, statt live zu lesen. Rein, ohne Datenbank; {@link ProbelaufRepository} liefert die
 * Reihe.
 *
 * <p>Die Reihe ist in {@code schrittS}-Schritten äquidistant (die Rückschau liest
 * {@code telemetry_v2_rollup_15m}, also 900 s) - "Dauer" und "Erholdauer" wirken deshalb nur in
 * Vielfachen dieses Schritts, nicht sekundengenau wie am Live-Takt; das ist die ehrliche Grenze
 * der Datengrundlage, keine zweite Zustandsmaschine mit eigenen Regeln.
 */
final class ProbelaufSimulation {

    record Punkt(Instant zeit, WerteLeser.Lesung lesung) {}

    record Ergebnis(int ausgeloest, Instant zuletzt, long gesamtdauerS) {
        static final Ergebnis NICHTS = new Ergebnis(0, null, 0);
    }

    private ProbelaufSimulation() {
    }

    static Ergebnis simulieren(List<Punkt> reihe, JsonNode bedingung) {
        if (reihe.isEmpty()) {
            return Ergebnis.NICHTS;
        }
        long dauerS = bedingung.path("dauer_s").asLong(300);
        long erholenS = bedingung.path("erholen_s").asLong(300);

        String zustand = "normal";
        Instant seit = null;
        Instant aktivSeit = null;
        int ausgeloest = 0;
        Instant zuletzt = null;
        long gesamtdauerS = 0;

        for (Punkt p : reihe) {
            BedingungsPruefung.Erfuellung e = BedingungsPruefung.pruefen(bedingung, p.lesung());
            switch (zustand) {
                case "normal" -> {
                    if (e.ausgeloest()) {
                        zustand = "ausstehend";
                        seit = p.zeit();
                    }
                }
                case "ausstehend" -> {
                    if (!e.ausgeloest()) {
                        zustand = "normal";
                    } else if (p.zeit().getEpochSecond() - seit.getEpochSecond() >= dauerS) {
                        zustand = "aktiv";
                        ausgeloest++;
                        zuletzt = p.zeit();
                        aktivSeit = p.zeit();
                    }
                }
                case "aktiv" -> {
                    if (!e.nochAktiv()) {
                        zustand = "erholend";
                        seit = p.zeit();
                        gesamtdauerS += p.zeit().getEpochSecond() - aktivSeit.getEpochSecond();
                    }
                }
                case "erholend" -> {
                    if (e.nochAktiv()) {
                        zustand = "aktiv"; // Rückfall in der Erholdauer: dieselbe Meldung (§6.4 Nr. 4)
                        aktivSeit = p.zeit();
                    } else if (p.zeit().getEpochSecond() - seit.getEpochSecond() >= erholenS) {
                        zustand = "normal";
                    }
                }
                default -> {
                    // unerreicht
                }
            }
        }
        if ("aktiv".equals(zustand) && aktivSeit != null) {
            // Am Ende des Fensters noch AKTIV (nie in "erholend" übergegangen): die Dauer bis zum
            // letzten Punkt zählt mit. Ein Ende in "erholend" hat seine Dauer bereits beim Übergang
            // aktiv->erholend oben verbucht - hier nochmal addieren wäre eine Doppelzählung.
            gesamtdauerS += reihe.get(reihe.size() - 1).zeit().getEpochSecond() - aktivSeit.getEpochSecond();
        }
        return new Ergebnis(ausgeloest, zuletzt, gesamtdauerS);
    }
}
