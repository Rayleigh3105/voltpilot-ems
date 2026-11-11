package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.ueberwachung.ProbelaufSimulation.Ergebnis;
import com.voltpilot.api.ueberwachung.ProbelaufSimulation.Punkt;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Der 30-Tage-Probelauf rein (§6.4, §6.8 Entwurf 1): derselbe Zustandsautomat wie
 * {@code UeberwachungsServiceTest}, aber über eine fertige historische Reihe statt live gelesen.
 */
class ProbelaufSimulationTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long SCHRITT_S = 900; // 15 Minuten, wie telemetry_v2_rollup_15m

    private static JsonNode b(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** {@code werte[i]} ist der Wert zum Schritt i (900 s Abstand, erster Schritt = {@code start}). */
    private static List<Punkt> reihe(Instant start, double... werte) {
        List<Punkt> out = new ArrayList<>();
        for (int i = 0; i < werte.length; i++) {
            out.add(new Punkt(start.plusSeconds(i * SCHRITT_S), WerteLeser.Lesung.zahl(werte[i], "kW", null)));
        }
        return out;
    }

    @Test
    void ohneJemalsUeberDerSchwelleLoestNieEtwasAus() {
        Instant start = Instant.parse("2026-09-01T00:00:00Z");
        JsonNode bedingung = b("{\"art\":\"ueber\",\"schwelle\":120,\"rueckkehr\":114,\"dauer_s\":900}");

        Ergebnis e = ProbelaufSimulation.simulieren(reihe(start, 50, 60, 55, 70), bedingung);

        assertThat(e).isEqualTo(Ergebnis.NICHTS);
    }

    @Test
    void zaehltGenauEinmalWennDieSchwelleLangGenugUeberschrittenBleibt() {
        Instant start = Instant.parse("2026-09-01T00:00:00Z");
        // dauer_s = 1800 (zwei Schritte): erst nach dem ZWEITEN Schritt über der Schwelle ausgelöst.
        JsonNode bedingung = b("{\"art\":\"ueber\",\"schwelle\":120,\"rueckkehr\":114,\"dauer_s\":1800,\"erholen_s\":900}");

        Ergebnis e = ProbelaufSimulation.simulieren(reihe(start, 50, 130, 131, 132, 50), bedingung);

        assertThat(e.ausgeloest()).isEqualTo(1);
        // "ausstehend" seit Index 1 (130); die Dauer (1800 s = 2 Schritte) ist am Index 3 erreicht
        // (Index 3 - Index 1 = 2 Schritte): dort wird ausgelöst, nicht beim ersten Überschreiten.
        assertThat(e.zuletzt()).isEqualTo(start.plusSeconds(3 * SCHRITT_S));
    }

    @Test
    void einKurzerAusschlagUnterDerDauerLoestNichtAus() {
        Instant start = Instant.parse("2026-09-01T00:00:00Z");
        JsonNode bedingung = b("{\"art\":\"ueber\",\"schwelle\":120,\"rueckkehr\":114,\"dauer_s\":1800}");

        // Nur EIN Schritt über der Schwelle - die Dauer (zwei Schritte) wird nie erreicht.
        Ergebnis e = ProbelaufSimulation.simulieren(reihe(start, 50, 130, 50, 50), bedingung);

        assertThat(e.ausgeloest()).isEqualTo(0);
    }

    @Test
    void zweiGetrennteUeberschreitungenZaehlenZweimalMitGesamtdauer() {
        Instant start = Instant.parse("2026-09-01T00:00:00Z");
        JsonNode bedingung = b("{\"art\":\"ueber\",\"schwelle\":120,\"rueckkehr\":100,\"dauer_s\":0,\"erholen_s\":0}");

        // Jeder Block braucht ZWEI Schritte über der Schwelle (dauer_s=0 löst erst am Schritt NACH
        // dem Erkennen aus, wie am Live-Takt: "ausstehend" prüft die Dauer erst beim nächsten Tick).
        // Zwischen den Blöcken ZWEI Schritte unter der Rückkehr: der erste räumt "erholend" nach
        // "normal" (sonst zählte ein sofortiger Rückfall als dieselbe Meldung, §6.4 Nr. 4, nicht als
        // zweite) - erst der zweite Block darf dann neu auslösen.
        Ergebnis e = ProbelaufSimulation.simulieren(reihe(start, 130, 130, 50, 50, 130, 130, 50), bedingung);

        assertThat(e.ausgeloest()).isEqualTo(2);
        assertThat(e.zuletzt()).isEqualTo(start.plusSeconds(5 * SCHRITT_S));
        // Jeder Block ist genau EINEN Schritt lang "aktiv" (von seinem Auslöse-Schritt bis zum
        // räumenden Schritt) - zweimal ein Schritt macht die Gesamtdauer.
        assertThat(e.gesamtdauerS()).isEqualTo(2 * SCHRITT_S);
    }

    @Test
    void nochAktivAmEndeDesFenstersZaehltBisZumLetztenPunkt() {
        Instant start = Instant.parse("2026-09-01T00:00:00Z");
        JsonNode bedingung = b("{\"art\":\"ueber\",\"schwelle\":120,\"rueckkehr\":114,\"dauer_s\":0,\"erholen_s\":900}");

        Ergebnis e = ProbelaufSimulation.simulieren(reihe(start, 130, 131, 132), bedingung);

        assertThat(e.ausgeloest()).isEqualTo(1);
        // Ausgelöst bei Index 1 (die Dauer von 0 s ist am Tick NACH dem Erkennen schon erfüllt);
        // das Fenster endet bei Index 2, immer noch aktiv -> genau ein Schritt Gesamtdauer.
        assertThat(e.gesamtdauerS()).isEqualTo(SCHRITT_S);
    }

    @Test
    void unbekannteWerteLoesenNieEtwasAusUnbekanntIstKeineNull() {
        Instant start = Instant.parse("2026-09-01T00:00:00Z");
        JsonNode bedingung = b("{\"art\":\"ueber\",\"schwelle\":120,\"dauer_s\":0}");
        List<Punkt> reihe = List.of(new Punkt(start, WerteLeser.Lesung.unbekannt()),
                new Punkt(start.plusSeconds(SCHRITT_S), WerteLeser.Lesung.unbekannt()));

        Ergebnis e = ProbelaufSimulation.simulieren(reihe, bedingung);

        assertThat(e).isEqualTo(Ergebnis.NICHTS);
    }

    @Test
    void eineLeereReiheLoestNichtsAus() {
        assertThat(ProbelaufSimulation.simulieren(List.of(), b("{\"art\":\"ueber\",\"schwelle\":5}")))
                .isEqualTo(Ergebnis.NICHTS);
    }
}
