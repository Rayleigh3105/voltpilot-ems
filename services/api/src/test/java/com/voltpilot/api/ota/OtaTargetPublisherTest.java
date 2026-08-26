package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Der Umschlag des Verteilwegs - rein, ohne Broker.
 *
 * <p>DIE Eigenschaft, die hier festgenagelt wird: die Manifest-Bytes gehen
 * BYTE FÜR BYTE durch. Die Signatur geht über genau diese Bytes; eine
 * Umformatierung an irgendeiner Station macht sie lautlos unprüfbar - und
 * genau deshalb wird der Umschlag von Hand gebaut statt über einen
 * Objekt-Mapper.
 */
class OtaTargetPublisherTest {

    private static final UUID T = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID S = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID D = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private final ObjectMapper json = new ObjectMapper();

    @Test
    @DisplayName("die Manifest-Bytes überleben den Umschlag unverändert")
    void manifestBytesSurviveVerbatim() throws Exception {
        // Bewusst „unaufgeräumt": Schlüsselreihenfolge, Leerraum, ein Umlaut
        // und ein abschließender Zeilenumbruch - alles, was eine
        // Re-Serialisierung normalisieren würde.
        String manifest = "{\n  \"z\" : 1,\n  \"release\":\"edge-2026.08.0\",\n"
                + "  \"notes\": \"Solarman-Lesepfad gehärtet\"\n}\n";
        String signature = "{\"alg\":\"ed25519\",\"key_id\":\"rel-2026-a\"}\n";

        byte[] raw = OtaTargetPublisher.envelope(T, S, D, "edge-2026.08.0", 12,
                UUID.fromString("7a1f0c22-4c5e-4a1a-9f0b-2c3d4e5f6a7b"), manifest, signature,
                Instant.parse("2026-08-05T08:15:00Z"));

        JsonNode env = json.readTree(raw);
        String back = new String(Base64.getDecoder().decode(env.get("manifest_b64").asText()),
                StandardCharsets.UTF_8);
        assertThat(back).isEqualTo(manifest);
        String sigBack = new String(Base64.getDecoder().decode(env.get("signature_b64").asText()),
                StandardCharsets.UTF_8);
        assertThat(sigBack).isEqualTo(signature);
    }

    @Test
    @DisplayName("der Umschlag hat die Kontrakt-Form")
    void envelopeMatchesTheContract() throws Exception {
        UUID rollout = UUID.fromString("7a1f0c22-4c5e-4a1a-9f0b-2c3d4e5f6a7b");
        JsonNode env = json.readTree(OtaTargetPublisher.envelope(T, S, D, "edge-2026.08.0", 12,
                rollout, "{}", "{}", Instant.parse("2026-08-05T08:15:00Z")));

        assertThat(env.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(env.get("type").asText()).isEqualTo("update_target");
        assertThat(env.get("tenant_id").asText()).isEqualTo(T.toString());
        assertThat(env.get("site_id").asText()).isEqualTo(S.toString());
        assertThat(env.get("device_id").asText()).isEqualTo(D.toString());
        assertThat(env.get("release").asText()).isEqualTo("edge-2026.08.0");
        assertThat(env.get("release_seq").asLong()).isEqualTo(12);
        assertThat(env.get("rollout_id").asText()).isEqualTo(rollout.toString());
        assertThat(env.get("assigned_at").asText()).isEqualTo("2026-08-05T08:15:00Z");
    }

    @Test
    @DisplayName("optionale Felder werden WEGGELASSEN, nie leer gesetzt")
    void optionalFieldsAreOmitted() throws Exception {
        JsonNode env = json.readTree(OtaTargetPublisher.envelope(T, S, D, "edge-2026.08.0", 12,
                null, "{}", "{}", null));
        // Eine leere Rollout-Id wäre eine Aussage über etwas, das es nicht
        // gibt (und das Schema verbietet sie).
        assertThat(env.has("rollout_id")).isFalse();
        assertThat(env.has("assigned_at")).isFalse();
    }

    @Test
    @DisplayName("das Topic liegt im v2-Teilbaum, den die Geräte-ACL schon abdeckt")
    void topicLivesInTheCoveredV2Subtree() {
        assertThat(OtaTargetPublisher.updateTopic(T, S, D))
                .isEqualTo("ems/" + T + "/" + S + "/" + D + "/v2/update");
    }

    @Test
    @DisplayName("ein Anführungszeichen im Release kann den Umschlag nicht sprengen")
    void quotesCannotBreakTheEnvelope() throws Exception {
        JsonNode env = json.readTree(OtaTargetPublisher.envelope(T, S, D,
                "edge-2026.08.0\",\"boese\":\"1", 12, null, "{}", "{}", null));
        assertThat(env.has("boese")).isFalse();
        assertThat(env.get("release").asText()).isEqualTo("edge-2026.08.0\",\"boese\":\"1");
    }
}
