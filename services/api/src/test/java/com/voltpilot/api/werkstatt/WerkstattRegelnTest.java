package com.voltpilot.api.werkstatt;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.Ipv4Netz;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln der Werkstatt: die geschlossene Liste der Prüfungen gegen
 * ihren Vektor und das LAN-Netz nach Entscheid 6a.
 */
class WerkstattRegelnTest {

    private static final List<Ipv4Netz> WARTUNG = List.of(Ipv4Netz.parse("10.10.16.0/20"),
            Ipv4Netz.parse("10.10.32.0/24"));

    /** Der Vektor, den auch das Portal liest; eine eigene Liste hier wäre eine zweite Wahrheit. */
    @Test
    void diePruefungenSindDieDesVektors() throws Exception {
        JsonNode v = new ObjectMapper().readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "werkstatt-pruefungen.json")));
        List<String> ids = new ArrayList<>();
        v.path("pruefungen").forEach(p -> ids.add(p.path("id").asText()));
        assertThat(ids).isNotEmpty().isEqualTo(WerkstattPruefungen.ALLE);
    }

    @Test
    void fehlendUndUnbekanntInDerReihenfolgeDerRegel() {
        assertThat(WerkstattPruefungen.fehlend(List.of("neustart", "root_passwort")))
                .containsExactly("notfall_schluessel", "tunnel_status", "anmeldeprobe", "host_schluessel",
                        "fenster_zu", "lan_netz");
        assertThat(WerkstattPruefungen.fehlend(WerkstattPruefungen.ALLE)).isEmpty();
        assertThat(WerkstattPruefungen.unbekannt(List.of("neustart", "zz", "aa", "zz"))).containsExactly("aa", "zz");
    }

    @Test
    void einUnueblichesPrivatesNetzGilt() {
        LanNetz lan = LanNetz.parse(" 10.213.0.1/24 ", WARTUNG);
        assertThat(lan.text()).isEqualTo("10.213.0.1/24");
        assertThat(lan.boxAdresse()).isEqualTo("10.213.0.1");
        assertThat(lan.netz()).hasToString("10.213.0.0/24");
        assertThat(LanNetz.parse(LanNetz.VORSCHLAG, WARTUNG).text()).isEqualTo(LanNetz.VORSCHLAG);
        assertThat(LanNetz.parse("172.20.7.1/24", WARTUNG).text()).isEqualTo("172.20.7.1/24");
        assertThat(LanNetz.parse("192.168.213.1/28", WARTUNG).text()).isEqualTo("192.168.213.1/28");
    }

    @Test
    void uebelicheHeimnetzeUndDieNetzeDesWartungsserversNicht() {
        assertThatThrownBy(() -> LanNetz.parse("192.168.1.1/24", WARTUNG))
                .hasMessageContaining("übliches Netz von Heimroutern");
        assertThatThrownBy(() -> LanNetz.parse("192.168.178.2/24", WARTUNG))
                .hasMessageContaining("192.168.178.0/24");
        assertThatThrownBy(() -> LanNetz.parse("192.168.0.1/16", WARTUNG))
                .hasMessageContaining("übliches Netz");
        assertThatThrownBy(() -> LanNetz.parse("10.10.17.1/24", WARTUNG))
                .hasMessageContaining("Wartungsservers");
        assertThatThrownBy(() -> LanNetz.parse("10.10.0.1/16", WARTUNG))
                .hasMessageContaining("Wartungsservers");
    }

    @Test
    void formLageUndHostAdresse() {
        assertThatThrownBy(() -> LanNetz.parse("10.213.0.1", WARTUNG)).hasMessageContaining("Präfix");
        assertThatThrownBy(() -> LanNetz.parse("", WARTUNG)).hasMessageContaining("keine Adresse");
        assertThatThrownBy(() -> LanNetz.parse(null, WARTUNG)).hasMessageContaining("keine Adresse");
        assertThatThrownBy(() -> LanNetz.parse("10.213.0.256/24", WARTUNG)).hasMessageContaining("keine Adresse");
        assertThatThrownBy(() -> LanNetz.parse("10.213.0.1/8", WARTUNG)).hasMessageContaining("/16 und /28");
        assertThatThrownBy(() -> LanNetz.parse("10.213.0.1/30", WARTUNG)).hasMessageContaining("/16 und /28");
        assertThatThrownBy(() -> LanNetz.parse("10.213.0.0/24", WARTUNG)).hasMessageContaining("Host-Adresse");
        assertThatThrownBy(() -> LanNetz.parse("10.213.0.255/24", WARTUNG)).hasMessageContaining("Host-Adresse");
        assertThatThrownBy(() -> LanNetz.parse("100.64.0.1/24", WARTUNG)).hasMessageContaining("kein privates");
        assertThatThrownBy(() -> LanNetz.parse("172.15.255.1/24", WARTUNG)).hasMessageContaining("kein privates");
    }
}
