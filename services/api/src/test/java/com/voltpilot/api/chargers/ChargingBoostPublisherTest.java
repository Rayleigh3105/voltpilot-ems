package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Drahtform der Übersteuerung „Jetzt voll laden" (Stufe 4). Rein, ohne
 * Docker: der Umschlag wird von Hand gebaut, also wird er von Hand geprüft.
 */
class ChargingBoostPublisherTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final Instant AT = Instant.parse("2026-08-20T13:24:00Z");

    private final ObjectMapper json = new ObjectMapper();

    private JsonNode doc(Integer minutes, boolean cancel, String actor) throws Exception {
        return doc(minutes, cancel, false, 1, actor);
    }

    private JsonNode doc(Integer minutes, boolean cancel, boolean pause, int connector,
            String actor) throws Exception {
        return json.readTree(new String(ChargingBoostPublisher.document(TENANT, SITE, DEVICE,
                "saeule-1", connector, minutes, cancel, pause, actor, AT), StandardCharsets.UTF_8));
    }

    @Test
    void theTopicLivesInTheV2SubtreeTheAclAlreadyCovers() {
        assertThat(ChargingBoostPublisher.boostTopic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/charging-boost");
    }

    @Test
    void theEnvelopeCarriesTheSessionAndTheStampTheWindowHangsOff() throws Exception {
        JsonNode d = doc(240, false, "9b1c7a2e-0000-4000-8000-000000000abc");
        assertThat(d.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(d.get("charge_point_id").asText()).isEqualTo("saeule-1");
        assertThat(d.get("connector_id").asInt()).isEqualTo(1);
        assertThat(d.get("minutes").asInt()).isEqualTo(240);
        // ⚠ Das Fenster hängt an DIESEM Stempel, nicht am Empfang: eine
        // nachgelieferte QoS1-Nachricht ist bei der Ankunft abgelaufen.
        assertThat(d.get("requested_at").asText()).isEqualTo("2026-08-20T13:24:00Z");
        assertThat(d.get("actor").asText()).isNotBlank();
        assertThat(d.has("cancel")).as("eine Erteilung ist keine Rücknahme").isFalse();
        // ⚠ Die KOMPATIBILITÄTS-ZUSAGE des ganzen Pakets: ein Voll-Boost trägt
        // GAR KEIN `action`. Hätten wir es immer gesendet, wäre der Beweis weg,
        // dass eine Box ohne P3b exakt den Boost von vorher bekommt.
        assertThat(d.has("action")).as("„voll\" reist als Abwesenheit").isFalse();
    }

    /** Die ZWEITE Richtung (P3b, E5) - und sie SAGT sich, statt sich zu verstecken. */
    @Test
    void theSecondDirectionNamesItselfAndTheFirstStaysAbsent() throws Exception {
        JsonNode d = doc(60, false, true, 2, "9b1c7a2e-0000-4000-8000-000000000abc");
        assertThat(d.get("action").asText()).isEqualTo("pause");
        assertThat(d.get("connector_id").asInt()).isEqualTo(2);
        assertThat(d.get("minutes").asInt()).isEqualTo(60);
        assertThat(d.has("cancel")).isFalse();
    }

    @Test
    void theWithdrawalSaysSoAndCarriesNoDuration() throws Exception {
        JsonNode d = doc(null, true, null);
        assertThat(d.get("cancel").asBoolean()).isTrue();
        assertThat(d.has("minutes")).isFalse();
        assertThat(d.has("actor")).isFalse();
    }

    /** Eine ChargePointId ist Fremdtext - sie darf den JSON-Rahmen nie sprengen. */
    @Test
    void aChargePointIdCannotBreakOutOfTheDocument() throws Exception {
        JsonNode d = json.readTree(new String(ChargingBoostPublisher.document(TENANT, SITE, DEVICE,
                "sae\"ule\n1", 2, null, false, false, null, AT), StandardCharsets.UTF_8));
        assertThat(d.get("charge_point_id").asText()).isEqualTo("sae\"ule\n1");
    }

    /** Die eingecheckten Kontrakt-Fixtures, Feld für Feld - per PFAD gelesen. */
    @Test
    void theDocumentMatchesTheContractFixtures() throws Exception {
        Path dir = Path.of("..", "..", "docs", "contracts", "examples");
        JsonNode fixture = json.readTree(
                Files.readString(dir.resolve("mqtt-charging-boost.valid.jetzt-voll-laden.json")));
        JsonNode built = doc(fixture.get("minutes").asInt(), false, fixture.get("actor").asText());
        for (String field : new String[] {"schema_version", "tenant_id", "site_id", "device_id",
                "charge_point_id", "connector_id", "minutes", "requested_at", "actor"}) {
            assertThat(built.get(field)).as(field).isEqualTo(fixture.get(field));
        }
        JsonNode withdrawal = json.readTree(
                Files.readString(dir.resolve("mqtt-charging-boost.valid.zuruecknehmen.json")));
        assertThat(withdrawal.get("cancel").asBoolean()).isTrue();
        assertThat(doc(null, true, null).get("cancel")).isEqualTo(withdrawal.get("cancel"));

        JsonNode pause = json.readTree(
                Files.readString(dir.resolve("mqtt-charging-boost.valid.laden-pausieren.json")));
        JsonNode builtPause = doc(pause.get("minutes").asInt(), false, true,
                pause.get("connector_id").asInt(), pause.get("actor").asText());
        for (String field : new String[] {"schema_version", "tenant_id", "site_id", "device_id",
                "charge_point_id", "connector_id", "action", "minutes", "requested_at", "actor"}) {
            assertThat(builtPause.get(field)).as(field).isEqualTo(pause.get(field));
        }
    }

    /** Das Wort der Papier-Spur folgt der GESENDETEN Richtung, auch bei der Rücknahme. */
    @Test
    void theAuditWordFollowsTheDirectionThatWasSent() {
        assertThat(ChargingBoostService.eventKind(false, ChargingBoostService.Action.VOLL))
                .isEqualTo("voll_laden_erteilt");
        assertThat(ChargingBoostService.eventKind(true, ChargingBoostService.Action.VOLL))
                .isEqualTo("voll_laden_zurueckgenommen");
        assertThat(ChargingBoostService.eventKind(false, ChargingBoostService.Action.PAUSE))
                .isEqualTo("laden_pausiert");
        assertThat(ChargingBoostService.eventKind(true, ChargingBoostService.Action.PAUSE))
                .isEqualTo("laden_pausiert_beendet");
    }

    /** ABWESEND = „voll"; ein unbekanntes Wort ist eine BENANNTE Ablehnung. */
    @Test
    void anAbsentActionIsTheOldBoostAndAnUnknownOneIsRefused() {
        assertThat(ChargingBoostService.Action.of(null)).isEqualTo(ChargingBoostService.Action.VOLL);
        assertThat(ChargingBoostService.Action.of("")).isEqualTo(ChargingBoostService.Action.VOLL);
        assertThat(ChargingBoostService.Action.of("voll")).isEqualTo(ChargingBoostService.Action.VOLL);
        assertThat(ChargingBoostService.Action.of("pause"))
                .isEqualTo(ChargingBoostService.Action.PAUSE);
        assertThatThrownBy(() -> ChargingBoostService.Action.of("stop"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Unbekannte Art des Eingriffs");
    }
}
