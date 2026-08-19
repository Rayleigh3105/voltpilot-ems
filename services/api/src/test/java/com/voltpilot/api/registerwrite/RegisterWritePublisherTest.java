package com.voltpilot.api.registerwrite;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der Umschlag, den die Cloud auf den Draht legt - gegen die EINGECHECKTEN
 * Kontrakt-Fixtures, PER PFAD gelesen.
 *
 * <p>Ein Umschlag, den nur ein Test von 2026 kennt, ist kein Vertrag. Die
 * Fixtures liegen in {@code docs/contracts/examples/}; sie zu verschieben bricht
 * diesen Test absichtlich, und dieselben Bytes liest der Geräte-Parser
 * ({@code edge-app/core/internal/registerwrite}).
 *
 * <p>Rein: kein Broker, kein Spring - {@link RegisterWritePublisher#envelope}
 * ist die eine Stelle, an der diese Bytes entstehen.
 */
class RegisterWritePublisherTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    private final ObjectMapper mapper = new ObjectMapper();

    /** Die Fixtures liegen relativ zum Repo-Wurzelverzeichnis, nicht zum Modul. */
    private JsonNode fixture(String name) throws Exception {
        Path p = Path.of("..", "..", "docs", "contracts", "examples", name).normalize();
        assertThat(Files.exists(p)).as("Kontrakt-Fixture " + p).isTrue();
        return mapper.readTree(Files.readString(p, StandardCharsets.UTF_8));
    }

    @Test
    void thePreviewEnvelopeIsTheContractsPreviewFixture() throws Exception {
        JsonNode expected = fixture("mqtt-register-write.valid.preview.json");

        JsonNode actual = mapper.readTree(RegisterWritePublisher.envelope(TENANT, SITE, DEVICE,
                expected.get("request_id").asText(),
                Instant.parse(expected.get("requested_at").asText()),
                expected.get("requested_by").asText(),
                new RegisterWritePublisher.Order(RegisterWriteResult.MODE_READ,
                        RegisterWritePublisher.Order.LANE_PRIMARY, null, null, null, null,
                        "holding", 231, null, null, null, null)));

        assertThat(actual).isEqualTo(expected);
        // Die Vorschau trägt WEDER Wert NOCH Bestätigung - ein Umschlag, der beim
        // Lesen einen Wert mitführt, wäre eine widersprüchliche Anweisung (und
        // der Kontrakt verbietet ihn).
        assertThat(actual.has("value")).isFalse();
        assertThat(actual.has("confirm")).isFalse();
    }

    @Test
    void theWriteEnvelopeIsTheContractsWriteFixture() throws Exception {
        JsonNode expected = fixture("mqtt-register-write.valid.write.json");

        JsonNode actual = mapper.readTree(RegisterWritePublisher.envelope(TENANT, SITE, DEVICE,
                expected.get("request_id").asText(),
                Instant.parse(expected.get("requested_at").asText()),
                expected.get("requested_by").asText(),
                new RegisterWritePublisher.Order(RegisterWriteResult.MODE_WRITE,
                        RegisterWritePublisher.Order.LANE_PRIMARY, null, null, null, null,
                        "holding", 231, 16, 7000, 3300,
                        RegisterKnowledge.confirmToken(231, 7000))));

        assertThat(actual).isEqualTo(expected);
    }

    @Test
    void theStampsThatMakeItOneShotAreAlwaysThere() {
        // requested_at ist die zweite Hälfte von „nicht retained": ohne den
        // Stempel könnte eine nachgelieferte Anfrage nie verfallen, und die
        // request_id ist der Einmaligkeits-Merker der Box.
        JsonNode env = envelope(new RegisterWritePublisher.Order(RegisterWriteResult.MODE_WRITE,
                RegisterWritePublisher.Order.LANE_PRIMARY, null, null, null, null, "holding",
                231, null, 7000, null, "0X00E7=7000"));

        assertThat(env.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(env.get("type").asText()).isEqualTo("register_write_request");
        assertThat(env.get("requested_at").asText()).isNotBlank();
        assertThat(env.get("request_id").asText()).matches("^[0-9a-f]{16,64}$");
        assertThat(env.get("target").get("kind").asText()).isEqualTo("primary");
        // write_fc weggelassen = die Box entscheidet (Holding -> FC16).
        assertThat(env.has("write_fc")).isFalse();
    }

    @Test
    void theTwoLanesStufeTwoWillExecuteAreAlreadyOnTheWire() {
        // Vollständig spezifiziert, damit eine Box im Feld eine ihr unbekannte
        // Form BENENNEN kann (not_supported) statt sie still zu verwerfen - die
        // Probe-Kanal-Entscheidung, wörtlich übernommen.
        UUID entity = UUID.fromString("00000000-0000-0000-0000-0000000000aa");
        JsonNode viaEntity = envelope(new RegisterWritePublisher.Order(
                RegisterWriteResult.MODE_READ, RegisterWritePublisher.Order.LANE_ENTITY, entity,
                null, null, null, "holding", 231, null, null, null, null));
        assertThat(viaEntity.get("target").get("kind").asText()).isEqualTo("entity");
        assertThat(viaEntity.get("target").get("entity_id").asText()).isEqualTo(entity.toString());
        // Für eine Komponente reist NUR die Kennung: die Cloud kann einen
        // Schreibvorgang damit nie auf einen fremden Host umlenken.
        assertThat(viaEntity.get("target").has("host")).isFalse();

        JsonNode viaLan = envelope(new RegisterWritePublisher.Order(RegisterWriteResult.MODE_READ,
                RegisterWritePublisher.Order.LANE_LAN, null, "192.168.0.44", 1502, 3, "coil", 4,
                null, null, null, null));
        assertThat(viaLan.get("target").get("host").asText()).isEqualTo("192.168.0.44");
        assertThat(viaLan.get("target").get("port").asInt()).isEqualTo(1502);
        assertThat(viaLan.get("target").get("unit_id").asInt()).isEqualTo(3);
        assertThat(viaLan.get("register").get("kind").asText()).isEqualTo("coil");
    }

    @Test
    void theTopicsLiveInTheV2SubtreeTheDeviceAclAlreadyCovers() {
        assertThat(RegisterWritePublisher.requestTopic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/register-write");
        assertThat(RegisterWritePublisher.resultTopic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE
                        + "/v2/register-write-result");
    }

    private JsonNode envelope(RegisterWritePublisher.Order order) {
        try {
            return mapper.readTree(RegisterWritePublisher.envelope(TENANT, SITE, DEVICE,
                    "0011223344556677", Instant.parse("2026-08-19T14:02:11Z"), "sub-1", order));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
