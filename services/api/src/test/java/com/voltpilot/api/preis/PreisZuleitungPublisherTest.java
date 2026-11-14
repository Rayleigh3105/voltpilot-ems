package com.voltpilot.api.preis;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die DRAHT-FORM des Preis-Dokuments (Vertrag
 * {@code docs/contracts/v2/mqtt-price-current.schema.json}) - ein REINER
 * Test, er braucht keinen Broker. Topic- und Payload-Identität müssen
 * übereinstimmen (Projektregel), der Preis ist der nackte Börsenpreis in
 * ct/kWh, und ein negativer Preis ist ein Preis.
 */
class PreisZuleitungPublisherTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    @Test
    void dokumentTraegtJedesVertragsfeldMitTopicIdentitaet() throws Exception {
        Instant slotStart = Instant.parse("2026-11-14T11:00:00Z");
        Instant slotEnd = Instant.parse("2026-11-14T11:15:00Z");
        byte[] raw = PreisZuleitungPublisher.document(TENANT, SITE, DEVICE,
                new PreisZuleitung.PricePoint(slotStart, slotEnd, -4.2), "DE-LU",
                Instant.parse("2026-11-14T11:00:10Z"));
        JsonNode doc = new ObjectMapper().readTree(new String(raw, StandardCharsets.UTF_8));

        assertThat(doc.path("schema_version").asText()).isEqualTo("1.0");
        assertThat(doc.path("tenant_id").asText()).isEqualTo(TENANT.toString());
        assertThat(doc.path("site_id").asText()).isEqualTo(SITE.toString());
        assertThat(doc.path("device_id").asText()).isEqualTo(DEVICE.toString());
        assertThat(doc.path("generated_at").asText()).isEqualTo("2026-11-14T11:00:10Z");
        assertThat(doc.path("slot_start").asText()).isEqualTo("2026-11-14T11:00:00Z");
        assertThat(doc.path("slot_end").asText()).isEqualTo("2026-11-14T11:15:00Z");
        assertThat(doc.path("price_ct_kwh").asDouble()).isEqualTo(-4.2);
        assertThat(doc.path("unit").asText()).isEqualTo("ct/kWh");
        assertThat(doc.path("bidding_zone").asText()).isEqualTo("DE-LU");

        // Vollständigkeit gegen den Vertrag: genau die required-Felder, nichts Fremdes.
        List<String> felder = List.of("schema_version", "tenant_id", "site_id", "device_id",
                "generated_at", "slot_start", "slot_end", "price_ct_kwh", "unit", "bidding_zone");
        doc.fieldNames().forEachRemaining(f -> assertThat(felder).contains(f));
        felder.forEach(f -> assertThat(doc.has(f)).as(f).isTrue());

        assertThat(PreisZuleitungPublisher.priceTopic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/price");
    }
}
