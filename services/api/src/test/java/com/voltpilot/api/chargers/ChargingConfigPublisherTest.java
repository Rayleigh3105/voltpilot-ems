package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die DRAHT-FORM der Lastmanagement-Konfiguration (Kontrakt
 * {@code docs/contracts/mqtt-charging-config.schema.json}) - ein REINER Test,
 * er braucht keinen Broker.
 *
 * <p>Was er schützt, ist die PATCH-Semantik: ein Feld, das das Portal nicht
 * besitzt, darf NICHT auf dem Draht erscheinen - die Box behält seinen Wert nur
 * dann. Ein Dokument, das jedes Feld immer sendet, setzt beim ersten Speichern
 * still die Einstellungen zurück, die ein Betreiber auf {@code :8484} gepflegt
 * hat.
 */
class ChargingConfigPublisherTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final Instant AT = Instant.parse("2026-08-20T11:24:00Z");

    private final ObjectMapper json = new ObjectMapper();

    private JsonNode doc(Double gridLimitKw, List<String> priorities) throws Exception {
        return json.readTree(new String(
                ChargingConfigPublisher.document(TENANT, SITE, DEVICE, gridLimitKw, priorities, AT),
                StandardCharsets.UTF_8));
    }

    @Test
    void theTopicLivesInTheV2SubtreeTheAclAlreadyCovers() {
        assertThat(ChargingConfigPublisher.configTopic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/charging-config");
    }

    @Test
    void anAbsentFieldIsOmittedNotDefaulted() throws Exception {
        JsonNode onlyLimit = doc(277.0, null);
        assertThat(onlyLimit.get("grid_limit_kw").asDouble()).isEqualTo(277.0);
        assertThat(onlyLimit.has("priority_charge_point_ids"))
                .as("eine abwesende Vorrang-Wahl darf die der Box nicht löschen").isFalse();

        JsonNode onlyPriorities = doc(null, List.of("saeule-1"));
        assertThat(onlyPriorities.has("grid_limit_kw"))
                .as("eine abwesende Grenze darf die gepflegte nicht löschen").isFalse();
        assertThat(onlyPriorities.get("priority_charge_point_ids")).hasSize(1);
    }

    @Test
    void anEmptyPriorityListIsSentBecauseItIsAStatement() throws Exception {
        JsonNode cleared = doc(null, List.of());
        assertThat(cleared.has("priority_charge_point_ids")).isTrue();
        assertThat(cleared.get("priority_charge_point_ids")).isEmpty();
    }

    @Test
    void theIdentityAndTheVersionAreAlwaysThere() throws Exception {
        JsonNode d = doc(277.0, List.of("saeule-1"));
        assertThat(d.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(d.get("tenant_id").asText()).isEqualTo(TENANT.toString());
        assertThat(d.get("site_id").asText()).isEqualTo(SITE.toString());
        assertThat(d.get("device_id").asText()).isEqualTo(DEVICE.toString());
        assertThat(d.get("published_at").asText()).isEqualTo("2026-08-20T11:24:00Z");
        // Ganze Zahlen bleiben ganz: 277, nicht 277.0 - das Dokument wird auch
        // von Menschen gelesen.
        assertThat(new String(ChargingConfigPublisher.document(TENANT, SITE, DEVICE, 277.0, null,
                AT), StandardCharsets.UTF_8)).contains("\"grid_limit_kw\":277,");
    }

    /** Eine ChargePointId ist Fremdtext - sie darf den JSON-Rahmen nie sprengen. */
    @Test
    void aChargePointIdCannotBreakOutOfTheDocument() throws Exception {
        JsonNode d = doc(null, List.of("sae\"ule\n1"));
        assertThat(d.get("priority_charge_point_ids").get(0).asText()).isEqualTo("sae\"ule\n1");
    }

    /** Die eingecheckte Kontrakt-Fixture, Feld für Feld - per PFAD gelesen. */
    @Test
    void theDocumentMatchesTheContractFixture() throws Exception {
        Path fixture = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.grenze-und-vorrang.json");
        JsonNode expected = json.readTree(Files.readString(fixture));
        assertThat(doc(277.0, List.of("saeule-1"))).isEqualTo(expected);
    }
}
