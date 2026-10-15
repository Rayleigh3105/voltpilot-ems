package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.ueberwachung.BedingungsPruefung.Erfuellung;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * Die Bedingungsprüfung rein (Alerting Scheibe 2, §6.4 Nr. 2-4, §9): Dauer/Rückkehrschwelle-
 * Hysterese für Zahlenwerte, additiv neben der zustand-Bedingung aus Scheibe 1.
 */
class BedingungsPruefungTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode b(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static WerteLeser.Lesung zahl(double wert) {
        return WerteLeser.Lesung.zahl(wert, "kW", Instant.now());
    }

    @Test
    void ueberLoestErstAbDerSchwelleAusUndBleibtBisZurRueckkehrschwelleAktiv() {
        JsonNode bedingung = b("{\"art\":\"ueber\",\"schwelle\":120,\"rueckkehr\":114}");

        // Weit unter der Rückkehrschwelle: ganz normal, nie ausgelöst, nicht einmal in der Totzone.
        assertThat(BedingungsPruefung.pruefen(bedingung, zahl(100.0))).isEqualTo(new Erfuellung(false, false));
        Erfuellung ausgeloest = BedingungsPruefung.pruefen(bedingung, zahl(120.1));
        assertThat(ausgeloest.ausgeloest()).isTrue();
        assertThat(ausgeloest.nochAktiv()).isTrue();
        // In der Totzone zwischen Rückkehr und Schwelle: nicht mehr AUSGELÖST (keine neue Dauer-Zählung),
        // aber NOCH AKTIV (kein Rückfall in den Normalzustand) - das ist die Hysterese.
        Erfuellung totzone = BedingungsPruefung.pruefen(bedingung, zahl(117.0));
        assertThat(totzone.ausgeloest()).isFalse();
        assertThat(totzone.nochAktiv()).isTrue();
        Erfuellung geklaert = BedingungsPruefung.pruefen(bedingung, zahl(113.9));
        assertThat(geklaert.ausgeloest()).isFalse();
        assertThat(geklaert.nochAktiv()).isFalse();
    }

    @Test
    void unterSpiegeltDieRichtungDerHysterese() {
        JsonNode bedingung = b("{\"art\":\"unter\",\"schwelle\":10,\"rueckkehr\":10.5}");

        Erfuellung ausgeloest = BedingungsPruefung.pruefen(bedingung, zahl(9.9));
        assertThat(ausgeloest.ausgeloest()).isTrue();
        assertThat(ausgeloest.nochAktiv()).isTrue();
        Erfuellung totzone = BedingungsPruefung.pruefen(bedingung, zahl(10.2));
        assertThat(totzone.ausgeloest()).isFalse();
        assertThat(totzone.nochAktiv()).isTrue();
        Erfuellung geklaert = BedingungsPruefung.pruefen(bedingung, zahl(10.6));
        assertThat(geklaert.nochAktiv()).isFalse();
    }

    @Test
    void ohneEigeneRueckkehrSchwelleSindBeideStufenIdentisch() {
        JsonNode bedingung = b("{\"art\":\"ueber\",\"schwelle\":5}");

        Erfuellung e = BedingungsPruefung.pruefen(bedingung, zahl(5.5));
        assertThat(e.ausgeloest()).isEqualTo(e.nochAktiv()).isTrue();
    }

    @Test
    void ausserhalbPrueftBeideGrenzenMitEigenerRueckkehr() {
        JsonNode bedingung = b("{\"art\":\"ausserhalb\",\"schwelle_unten\":35,\"schwelle_oben\":55,"
                + "\"rueckkehr_unten\":37,\"rueckkehr_oben\":53}");

        assertThat(BedingungsPruefung.pruefen(bedingung, zahl(45)).ausgeloest()).isFalse();
        assertThat(BedingungsPruefung.pruefen(bedingung, zahl(30)).ausgeloest()).isTrue();
        assertThat(BedingungsPruefung.pruefen(bedingung, zahl(60)).ausgeloest()).isTrue();
        // Innerhalb der Totzone (36, zwischen 35 und 37): nicht mehr ausgelöst, aber noch aktiv.
        Erfuellung totzone = BedingungsPruefung.pruefen(bedingung, zahl(36));
        assertThat(totzone.ausgeloest()).isFalse();
        assertThat(totzone.nochAktiv()).isTrue();
    }

    @Test
    void keineDatenIstEinEigenerZustandUnbekanntIstKeineNull() {
        JsonNode bedingung = b("{\"art\":\"keine_daten\"}");

        assertThat(BedingungsPruefung.pruefen(bedingung, WerteLeser.Lesung.unbekannt()).ausgeloest()).isTrue();
        assertThat(BedingungsPruefung.pruefen(bedingung, zahl(1.0)).ausgeloest()).isFalse();
    }

    @Test
    void zustandWertetNurBekannteZieleAlsErfuellt() {
        JsonNode bedingung = b("{\"art\":\"zustand\",\"ziel\":[\"nicht_erreichbar\"]}");

        assertThat(BedingungsPruefung.pruefen(bedingung, WerteLeser.Lesung.zustand("nicht_erreichbar", Instant.now()))
                .ausgeloest()).isTrue();
        assertThat(BedingungsPruefung.pruefen(bedingung, WerteLeser.Lesung.zustand("erreichbar", Instant.now()))
                .ausgeloest()).isFalse();
        // Unbekannt ist keine Null (§6.1 Nr. 4): zählt nie als erfüllt, auch wenn "unbekannt" zufällig im Ziel stünde.
        assertThat(BedingungsPruefung.pruefen(bedingung, WerteLeser.Lesung.unbekannt()).ausgeloest()).isFalse();
    }

    @Test
    void eineUnbekannteBedingungsartLoestNieEtwasAus() {
        JsonNode bedingung = b("{\"art\":\"periode\"}"); // spätere Scheibe, hier noch nicht gebaut

        assertThat(BedingungsPruefung.pruefen(bedingung, zahl(999)).ausgeloest()).isFalse();
    }
}
