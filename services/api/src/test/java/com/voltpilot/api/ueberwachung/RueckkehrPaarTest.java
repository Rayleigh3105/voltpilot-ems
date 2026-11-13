package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

/**
 * Kunden-Alarmierung P0: Schwelle und Rückkehrschwelle als Paar, und die Vorschau, die sagt, wann sie nichts
 * nachrechnen kann. Nachgestellt ist der Labor-Fall vom 13.11.2026: Börsenpreis „über 5 ct/kWh“ mit der alten
 * Rückkehr 7,6 - die Meldung öffnete und schloss im selben Takt und öffnete gleich wieder.
 */
class RueckkehrPaarTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static ObjectNode b(String text) {
        try {
            return (ObjectNode) JSON.readTree(text);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void einVerdrehtesPaarUeberWirdAbgelehnt() {
        assertThatThrownBy(() -> UeberwachungAnlegenService.paarPruefen(
                b("{\"art\":\"ueber\",\"schwelle\":5,\"rueckkehr\":7.6,\"dauer_s\":300,\"erholen_s\":300}")))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("400")
                .hasMessageContaining("unter der Schwelle");
    }

    @Test
    void einVerdrehtesPaarUnterWirdAbgelehnt() {
        assertThatThrownBy(() -> UeberwachungAnlegenService.paarPruefen(
                b("{\"art\":\"unter\",\"schwelle\":20,\"rueckkehr\":15}")))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("über der Schwelle");
    }

    @Test
    void periodeFolgtIhrerRichtung() {
        assertThatThrownBy(() -> UeberwachungAnlegenService.paarPruefen(
                b("{\"art\":\"periode\",\"richtung\":\"unter\",\"schwelle\":100,\"rueckkehr\":95}")))
                .isInstanceOf(ResponseStatusException.class);
        assertThatCode(() -> UeberwachungAnlegenService.paarPruefen(
                b("{\"art\":\"periode\",\"richtung\":\"unter\",\"schwelle\":100,\"rueckkehr\":105}")))
                .doesNotThrowAnyException();
    }

    @Test
    void ausserhalbPrueftBeideGrenzen() {
        assertThatThrownBy(() -> UeberwachungAnlegenService.paarPruefen(
                b("{\"art\":\"ausserhalb\",\"schwelle_unten\":30,\"schwelle_oben\":10}")))
                .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> UeberwachungAnlegenService.paarPruefen(
                b("{\"art\":\"ausserhalb\",\"schwelle_unten\":10,\"schwelle_oben\":30,\"rueckkehr_unten\":5}")))
                .isInstanceOf(ResponseStatusException.class);
        assertThatCode(() -> UeberwachungAnlegenService.paarPruefen(
                b("{\"art\":\"ausserhalb\",\"schwelle_unten\":10,\"schwelle_oben\":30,\"rueckkehr_unten\":12,\"rueckkehr_oben\":28}")))
                .doesNotThrowAnyException();
    }

    @Test
    void gleicheWerteSindKeinVerdrehtesPaar() {
        assertThatCode(() -> UeberwachungAnlegenService.paarPruefen(b("{\"art\":\"ueber\",\"schwelle\":5,\"rueckkehr\":5}")))
                .doesNotThrowAnyException();
    }

    @Test
    void dieVorgabeLiegtAufDerRichtigenSeiteUndOhneRechenrest() {
        ObjectNode ueber = UeberwachungAnlegenService.vorgabenAnwenden(b("{\"art\":\"ueber\",\"schwelle\":8}"));
        assertThat(ueber.path("rueckkehr").asDouble()).isEqualTo(7.6);
        assertThat(ueber.path("rueckkehr").toString()).isEqualTo("7.6");

        // Negative Schwelle (Einspeisung, negativer Preis): vorher lag die Vorgabe -9,5 ÜBER der Schwelle -10.
        ObjectNode negativ = UeberwachungAnlegenService.vorgabenAnwenden(b("{\"art\":\"ueber\",\"schwelle\":-10}"));
        assertThat(negativ.path("rueckkehr").asDouble()).isEqualTo(-10.5);
        assertThatCode(() -> UeberwachungAnlegenService.paarPruefen(negativ)).doesNotThrowAnyException();

        // „periode“ mit Richtung „unter“: vorher wie „über“ unter die Schwelle gelegt.
        ObjectNode periode = UeberwachungAnlegenService.vorgabenAnwenden(
                b("{\"art\":\"periode\",\"richtung\":\"unter\",\"schwelle\":100}"));
        assertThat(periode.path("rueckkehr").asDouble()).isEqualTo(105.0);
        assertThatCode(() -> UeberwachungAnlegenService.paarPruefen(periode)).doesNotThrowAnyException();
    }

    @Test
    void eineReiheOhneBekanntenWertIstKeineVorschau() {
        Instant t = Instant.parse("2026-11-13T12:00:00Z");
        List<ProbelaufSimulation.Punkt> preis = List.of(
                new ProbelaufSimulation.Punkt(t, WerteLeser.Lesung.unbekannt()),
                new ProbelaufSimulation.Punkt(t.plusSeconds(900), WerteLeser.Lesung.unbekannt()));
        assertThat(ProbelaufSimulation.hatBekannteWerte(preis)).isFalse();
        assertThat(ProbelaufSimulation.hatBekannteWerte(List.of())).isFalse();
        assertThat(ProbelaufSimulation.hatBekannteWerte(List.of(
                new ProbelaufSimulation.Punkt(t, WerteLeser.Lesung.zahl(6.3, "ct/kWh", t))))).isTrue();
    }
}
