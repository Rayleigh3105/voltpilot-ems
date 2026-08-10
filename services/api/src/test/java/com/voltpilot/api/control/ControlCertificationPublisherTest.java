package com.voltpilot.api.control;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.ControlCertificationRepository.Certification;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Reine Wire-Tests des Zertifizierungs-Dokuments (kein Broker, kein Docker) -
 * das Muster von {@code OtaTargetPublisherTest}. Geprüft wird genau das, was
 * das Gerät sieht.
 */
class ControlCertificationPublisherTest {

    private static final UUID T = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID S = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID D = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static Certification deye(Boolean sign) {
        return new Certification(UUID.randomUUID(), "deye", "sun-30k-sg01hp3", "hybrid_3p",
                "remote", sign, Instant.parse("2026-07-27T14:05:00Z"),
                "Protokoll V105.1+", "Prüfstand Pilsting", Instant.now(), "admin");
    }

    private static JsonNode doc(boolean activated, List<Certification> reg) throws Exception {
        byte[] raw = ControlCertificationPublisher.document(T, S, D, activated, reg,
                Instant.parse("2026-08-10T09:00:00Z"));
        return MAPPER.readTree(new String(raw, StandardCharsets.UTF_8));
    }

    @Test
    void theDocumentCarriesTheIdentityTheActivationAndTheRegister() throws Exception {
        JsonNode n = doc(true, List.of(deye(null)));

        assertThat(n.path("schema_version").asText()).isEqualTo("1.0");
        assertThat(n.path("device_id").asText()).isEqualTo(D.toString());
        assertThat(n.path("activated").asBoolean()).isTrue();
        JsonNode m = n.path("certified_models").get(0);
        assertThat(m.path("brand").asText()).isEqualTo("deye");
        assertThat(m.path("model").asText()).isEqualTo("sun-30k-sg01hp3");
        assertThat(m.path("family").asText()).isEqualTo("hybrid_3p");
        assertThat(m.path("control_path").asText()).isEqualTo("remote");
        assertThat(m.path("firmware_note").asText()).contains("V105.1");
    }

    /**
     * ⚠ Eine unbeantwortete Vorzeichenfrage wird WEGGELASSEN, nie als
     * {@code false} gesendet: absent heißt „der Prüfstand hat dazu nichts
     * gesagt" (das Gerät prüft dann nichts), false heißt „er hat es gesagt".
     * Die zwei zu verschmelzen würde eine legitim anders eingestellte Box
     * grundlos aussperren.
     */
    @Test
    void anUnansweredSignQuestionIsOmittedNeverSentAsFalse() throws Exception {
        assertThat(doc(true, List.of(deye(null))).path("certified_models").get(0)
                .has("invert_control_sign")).isFalse();

        JsonNode answered = doc(true, List.of(deye(Boolean.FALSE))).path("certified_models").get(0);
        assertThat(answered.has("invert_control_sign")).isTrue();
        assertThat(answered.path("invert_control_sign").asBoolean()).isFalse();
    }

    /** Ein leeres Register ist gültig und heißt „noch nichts zertifiziert". */
    @Test
    void anEmptyRegisterIsAValidDocument() throws Exception {
        JsonNode n = doc(false, List.of());
        assertThat(n.path("certified_models").isArray()).isTrue();
        assertThat(n.path("certified_models")).isEmpty();
        assertThat(n.path("activated").asBoolean()).isFalse();
    }

    /** Kein Registerwert darf den JSON-Rahmen sprengen können. */
    @Test
    void quotesInARegisterValueCannotBreakTheDocument() throws Exception {
        Certification hostile = new Certification(UUID.randomUUID(), "deye", "m\"x", "f",
                null, null, Instant.parse("2026-07-27T14:05:00Z"), null,
                "eine \"Notiz\" mit \\ Backslash", Instant.now(), "admin");
        JsonNode n = doc(true, List.of(hostile)); // parses at all = the assertion
        assertThat(n.path("certified_models").get(0).path("model").asText()).isEqualTo("m\"x");
        assertThat(n.path("certified_models").get(0).path("note").asText()).contains("Backslash");
    }

    /** Das Topic liegt im v2/#-Teilbaum, den die per-Gerät-ACL schon abdeckt. */
    @Test
    void theTopicLivesInTheAlreadyPermittedV2Subtree() {
        assertThat(ControlCertificationPublisher.certificationTopic(T, S, D))
                .isEqualTo("ems/" + T + "/" + S + "/" + D + "/v2/control-certification");
    }
}
