package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.Properties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.YamlPropertiesFactoryBean;
import org.springframework.core.io.ClassPathResource;

/**
 * Die Messzeit-Plausibilität der Datenannahme (E13) steht an EINER Stelle in {@code application.yml}
 * und ist dieselbe wie im Vertrag: {@link Messzeitregel#E13} = die Konfiguration = {@code regeln} von
 * {@code events-vocabulary-vectors.json} und {@code messwert-herkunft-vectors.json}; und jeder Fall des
 * Herkunftsvertrags wird von der Datenannahme genauso beurteilt wie von
 * {@code services/api .../uems/MesswertHerkunft} (Schritt 1 „Zeit“).
 */
class MesszeitregelTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path V2 = Path.of("../../docs/contracts/v2");

    @Test
    void dieGrenzenSindDieDesVertragsUndStehenEinmalInDerKonfiguration() throws Exception {
        for (String datei : new String[] {"events-vocabulary-vectors.json", "messwert-herkunft-vectors.json"}) {
            JsonNode regeln = MAPPER.readTree(Files.readString(V2.resolve(datei))).path("regeln");
            assertThat(regeln.path("zukunft_hoechstens_s").asLong()).as(datei)
                    .isEqualTo(Messzeitregel.E13.zukunftHoechstensS());
            assertThat(regeln.path("vergangenheit_hoechstens_s").asLong()).as(datei)
                    .isEqualTo(Messzeitregel.E13.vergangenheitHoechstensS());
        }
        YamlPropertiesFactoryBean yaml = new YamlPropertiesFactoryBean();
        yaml.setResources(new ClassPathResource("application.yml"));
        Properties p = yaml.getObject();
        assertThat(Long.parseLong(p.getProperty("voltpilot.datenannahme.zukunft-hoechstens-s")))
                .isEqualTo(Messzeitregel.E13.zukunftHoechstensS());
        assertThat(Long.parseLong(p.getProperty("voltpilot.datenannahme.vergangenheit-hoechstens-s")))
                .isEqualTo(Messzeitregel.E13.vergangenheitHoechstensS());
    }

    @Test
    void genauAufDerGrenzeWirdAngenommen() {
        Instant eingang = Instant.parse("2026-10-20T08:15:00Z");
        Messzeitregel r = Messzeitregel.E13;
        assertThat(r.pruefe(eingang.plusSeconds(300), eingang)).isEmpty();
        assertThat(r.pruefe(eingang.plusSeconds(301), eingang))
                .contains(new Messzeitregel.Abweichung(Ereignisart.CLOCK_AHEAD, 301));
        assertThat(r.pruefe(eingang.minusSeconds(7_776_000), eingang)).isEmpty();
        assertThat(r.pruefe(eingang.minusSeconds(7_776_001), eingang))
                .contains(new Messzeitregel.Abweichung(Ereignisart.TOO_OLD, 7_776_001));
    }

    /** Jeder Fall mit Lieferung: abgewiesen wegen der Zeit genau dann, wenn der Herkunftsvertrag es sagt. */
    @Test
    void dieZeitFaelleDesHerkunftsvertragsGeltenAuchInDerDatenannahme() throws Exception {
        JsonNode cases = MAPPER.readTree(Files.readString(V2.resolve("messwert-herkunft-vectors.json")))
                .path("cases");
        int zeitfaelle = 0;
        int gesehen = 0;
        for (JsonNode c : cases) {
            JsonNode l = c.path("input").path("lieferung");
            if (!l.isObject()) {
                continue;
            }
            gesehen++;
            Instant messzeit = OffsetDateTime.parse(l.path("wert").path("messzeit").asText()).toInstant();
            Instant eingang = OffsetDateTime.parse(l.path("eingangszeit").asText()).toInstant();
            Optional<Messzeitregel.Abweichung> a = Messzeitregel.E13.pruefe(messzeit, eingang);
            String grund = c.path("expected").path("grund").asText("");
            if (grund.equals("clock_ahead") || grund.equals("too_old")) {
                zeitfaelle++;
                JsonNode ereignis = c.path("expected").path("ereignisse").get(0);
                String feld = grund.equals("clock_ahead") ? "vor_s" : "alter_s";
                assertThat(a).as(c.path("name").asText()).isPresent();
                assertThat(a.get().art().code()).as(c.path("name").asText()).isEqualTo(grund);
                assertThat(a.get().sekunden()).as(c.path("name").asText())
                        .isEqualTo(ereignis.path(feld).asLong());
            } else {
                assertThat(a).as(c.path("name").asText()).isEmpty();
            }
        }
        assertThat(gesehen).as("Fälle mit Lieferung").isGreaterThanOrEqualTo(10);
        assertThat(zeitfaelle).as("clock_ahead + too_old").isGreaterThanOrEqualTo(2);
    }
}
