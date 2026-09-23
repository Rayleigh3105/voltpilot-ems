package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * Der Schalter des Wetter-Archivs (UEMS AP-17 IP-12b): ausgeliefert AN, im Testlauf AUS; Quelle und Adresse sind
 * gitops-Werte mit Vorgabe Open-Meteo-Archiv. Und der Leser des Archivs: ein Tag ohne Wert fehlt — nie 0.
 */
class WetterArchivWiringTest {

    @Test
    @SuppressWarnings("unchecked")
    void derSchalterIstAusgeliefertAnUndImTestlaufAus() throws IOException {
        Map<String, Object> yml;
        try (InputStream in = Files.newInputStream(Path.of("src/main/resources/application.yml"))) {
            yml = new Yaml().load(in);
        }
        Map<String, Object> w = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) yml
                .get("voltpilot")).get("uems")).get("wetter-archiv");
        assertThat(w.get("enabled")).isEqualTo("${VOLTPILOT_UEMS_WETTER_ARCHIV_ENABLED:true}");
        assertThat(w.get("quelle")).isEqualTo("${VOLTPILOT_UEMS_WETTER_ARCHIV_QUELLE:open-meteo}");
        assertThat(w.get("basis-url"))
                .isEqualTo("${VOLTPILOT_UEMS_WETTER_ARCHIV_BASIS_URL:https://archive-api.open-meteo.com}");
        assertThat(w.get("schluessel")).isEqualTo("${VOLTPILOT_UEMS_WETTER_ARCHIV_SCHLUESSEL:}");
        assertThat(Files.readString(Path.of("pom.xml")))
                .contains("<voltpilot.uems.wetter-archiv.enabled>false</voltpilot.uems.wetter-archiv.enabled>");
    }

    @Test
    void einTagOhneWertFehltNie0() throws IOException {
        var doc = new ObjectMapper().readTree("""
                {"daily":{"time":["2026-10-01","2026-10-02","2026-10-03"],
                          "temperature_2m_mean":[5.2,null,-1.4]}}""");
        assertThat(OpenMeteoWetterArchiv.lesen(doc)).containsExactly(
                Map.entry(LocalDate.parse("2026-10-01"), new BigDecimal("5.2")),
                Map.entry(LocalDate.parse("2026-10-03"), new BigDecimal("-1.4")));
    }

    @Test
    void dasKennzeichenNenntQuelleUndAbrufzeitInDerZoneDesStandorts() {
        assertThat(WetterArchivAbruf.kennzeichen("Open-Meteo-Archiv", java.time.Instant.parse("2027-11-01T05:10:00Z"),
                java.time.ZoneId.of("Europe/Berlin")))
                .isEqualTo("Temperatur von VoltPilot bezogen (Open-Meteo-Archiv, abgerufen am 01.11.2027 06:10)");
    }
}
