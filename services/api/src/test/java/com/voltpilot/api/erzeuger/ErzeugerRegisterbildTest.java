package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeuger.ErzeugerRegisterbild.Bit;
import com.voltpilot.api.erzeuger.ErzeugerRegisterbild.Feld;
import com.voltpilot.api.erzeuger.ErzeugerRegisterbild.Wort;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Docker: der Java-Zwilling sagt dasselbe wie die Katalogquelle des Erzeuger-Registerbilds — Abschnitte,
 * Felder, Arten, Einheiten, Vokabular und Bits Zeichen für Zeichen (UEMS EZ-6).
 */
class ErzeugerRegisterbildTest {

    private static final Path QUELLE = Path.of("..", "..", "catalog", "measurement-points", "sources", "voltpilot",
            "erzeuger-registerbild-v1.json");

    @Test
    void derZwillingIstDieKatalogquelle() throws Exception {
        JsonNode quelle = new ObjectMapper().readTree(Files.readString(QUELLE));
        assertThat(quelle.path("family").asText()).isEqualTo(ErzeugerRegisterbild.FAMILIE);
        assertThat(quelle.path("registerbild").path("max_einheiten").asInt()).isEqualTo(ErzeugerRegisterbild.MAX_EINHEITEN);
        List<Feld> erwartet = new ArrayList<>();
        for (JsonNode f : quelle.path("felder")) {
            List<Wort> vokabular = new ArrayList<>();
            f.path("vokabular").forEach(w -> vokabular.add(new Wort(w.path("wert").asInt(), w.path("wort").asText(),
                    w.path("text").asText())));
            List<Bit> bits = new ArrayList<>();
            f.path("bits").forEach(b -> bits.add(new Bit(b.path("bit").asInt(), b.path("wort").asText(),
                    b.path("text").asText())));
            erwartet.add(new Feld(f.path("abschnitt").asText(), f.path("feld").asText(),
                    f.path("aggregation_kind").asText(), f.path("unit").isNull() ? null : f.path("unit").asText(),
                    vokabular, bits));
        }
        assertThat(ErzeugerRegisterbild.FELDER).containsExactlyElementsOf(erwartet);
    }

    @Test
    void dieSchluesselEinesBildsFolgenDerZahlDerEinheiten() {
        List<String> gore = ErzeugerRegisterbild.punkte(3);
        assertThat(gore).hasSize(26 + 3 * 7).doesNotHaveDuplicates()
                .startsWith("erzeuger.kopf.te_anzahl")
                .contains("erzeuger.a.p_nvp_w", "erzeuger.nb.n_p_prozent", "erzeuger.dv.d_soll_w",
                        "erzeuger.wirkung.quelle_p", "erzeuger.te[1].t_zustand", "erzeuger.te[3].t_e")
                .doesNotContain("erzeuger.te[4].t_zustand");
        assertThat(ErzeugerRegisterbild.punkte(2)).hasSize(26 + 2 * 7).endsWith("erzeuger.te[2].t_e");
        assertThat(ErzeugerRegisterbild.punkte(10)).contains("erzeuger.te[10].t_p_ist_w");
        assertThatThrownBy(() -> ErzeugerRegisterbild.punkte(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ErzeugerRegisterbild.punkte(11)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void einSchluesselNenntFeldUndEinheitFremdeBleibenLeer() {
        assertThat(ErzeugerRegisterbild.feld("erzeuger.te[2].t_p_ist_w")).get()
                .extracting(Feld::abschnitt, Feld::feld, Feld::einheit).containsExactly("te[*]", "t_p_ist_w", "W");
        assertThat(ErzeugerRegisterbild.teNr("erzeuger.te[10].t_e")).contains(10);
        assertThat(ErzeugerRegisterbild.teNr("erzeuger.a.p_nvp_w")).isEmpty();
        assertThat(ErzeugerRegisterbild.feld("erzeuger.a.p_nvp_w")).get().extracting(Feld::einheit).isEqualTo("W");
        assertThat(ErzeugerRegisterbild.feld("erzeuger.te[11].t_e")).isEmpty();
        assertThat(ErzeugerRegisterbild.feld("erzeuger.te[0].t_e")).isEmpty();
        assertThat(ErzeugerRegisterbild.feld("erzeuger.te[*].t_e")).isEmpty();
        assertThat(ErzeugerRegisterbild.feld("erzeuger.a.t_e")).isEmpty();
        assertThat(ErzeugerRegisterbild.feld("wago.pm495.karte[1].frequency")).isEmpty();
    }

    @Test
    void zustandUndBitfeldSprechenNurIhrVokabular() {
        Feld quelle = ErzeugerRegisterbild.feld("erzeuger.wirkung.quelle_p").orElseThrow();
        assertThat(ErzeugerRegisterbild.wort(quelle, 1)).get().extracting(Wort::wort).isEqualTo("netzbetreiber");
        // EZ-1 Lesart 6: außerhalb des Vokabulars ist kein Wort — der Rohwert bleibt.
        assertThat(ErzeugerRegisterbild.wort(quelle, 9)).isEmpty();
        Feld nBits = ErzeugerRegisterbild.feld("erzeuger.nb.n_bits").orElseThrow();
        // Bit 0, 1 und 2 gesetzt, dazu ein unbekanntes Bit 12: es fehlt, nie geraten.
        assertThat(ErzeugerRegisterbild.gesetzt(nBits, 0b1_0000_0000_0111L)).extracting(Bit::wort)
                .containsExactly("vorgabe_gueltig", "verbindung_steht", "wirkleistung_begrenzt");
    }
}
