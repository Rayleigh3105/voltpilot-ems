package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;

/**
 * NW-6 im Kleinen, die ingest-Naht (AP-14 IP-18): Nimmt die echte Datenannahme die Umschläge des
 * Dauerläufers an, und reicht sie genau das weiter, was {@code DauerlaeuferWriterNahtTest}
 * (timescale-writer) dem Writer über Redpanda schickt? Rein, ohne Docker. NICHT durchlaufen: der
 * MQTT-Transport und das Senden nach Redpanda ({@link MeasurementIngestHandler}).
 */
class DauerlaeuferVorlageAnnahmeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VORLAGE =
            Path.of("../../tools/edge-simulator/abnahme/dauerlaeufer-nw6.json");
    /** Der Eingang, den auch die Writer- und die api-Hälfte annehmen: zwei Sekunden nach der Messzeit. */
    private static final Duration EINGANG = Duration.ofSeconds(2);

    @Test
    void dieDatenannahmeReichtJedenUmschlagDesDauerlaeufersUnveraendertWeiter() throws Exception {
        byte[] bytes = Files.readAllBytes(VORLAGE);
        String summe = Files.readString(Path.of(VORLAGE + ".sha256"), StandardCharsets.UTF_8).strip();
        assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)))
                .as("Vorlage von Hand geändert? `make abnahme` in tools/edge-simulator").isEqualTo(summe);
        JsonNode vorlage = MAPPER.readTree(bytes);

        MeasurementSamplesValidator annahme = new MeasurementSamplesValidator(MAPPER, Messzeitregel.E13);
        int gezaehlt = 0;
        for (JsonNode z : vorlage.path("zustellungen")) {
            JsonNode n = z.path("nutzlast");
            Instant eingang = Instant.parse(n.path("observed_at").asText()).plus(EINGANG);
            // Der Draht des Simulators ist kompaktes JSON (uems_dauerlaeufer.draht).
            Annahme<MeasurementRawEvent> a = annahme.annehmen(z.path("topic").asText(),
                    MAPPER.writeValueAsString(n), eingang);
            assertThat(a.ablehnungen()).as(z.path("topic").asText()).isEmpty();
            MeasurementRawEvent e = a.weiter();
            assertThat(e).isNotNull();
            // Genau die Felder, die DauerlaeuferWriterNahtTest.ereignis setzt — nur event_id ist neu.
            assertThat(e.schema_version()).isEqualTo("1.0");
            assertThat(e.tenant_id()).hasToString(n.path("tenant_id").asText());
            assertThat(e.site_id()).hasToString(n.path("site_id").asText());
            assertThat(e.device_id()).hasToString(n.path("device_id").asText());
            assertThat(e.catalog_version()).isEqualTo(n.path("catalog_version").asText());
            assertThat(e.sequence()).isEqualTo(n.path("sequence").asLong());
            assertThat(e.observed_at()).isEqualTo(Instant.parse(n.path("observed_at").asText()));
            assertThat(e.ingested_at()).isEqualTo(eingang);
            assertThat(e.source_topic()).isEqualTo(z.path("topic").asText());
            assertThat(e.samples()).isEqualTo(n.path("samples"));
            assertThat(e.dropped_samples()).isZero();
            assertThat(e.gap()).isFalse();
            gezaehlt++;
        }
        assertThat(gezaehlt).as("beide Boxen, fünf Takte").isEqualTo(10);
    }
}
