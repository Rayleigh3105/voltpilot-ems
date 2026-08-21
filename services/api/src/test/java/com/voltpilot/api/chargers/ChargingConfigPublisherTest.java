package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.ChargingConfigDto.AllowedChargePointDto;
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
        return doc(gridLimitKw, priorities, null, null);
    }

    private JsonNode doc(Double gridLimitKw, List<String> priorities, String policy,
            String storage) throws Exception {
        return doc(gridLimitKw, priorities, policy, storage, null);
    }

    private JsonNode doc(Double gridLimitKw, List<String> priorities, String policy,
            String storage, List<AllowedChargePointDto> chargePoints) throws Exception {
        return json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE, DEVICE,
                gridLimitKw, priorities, policy, storage, chargePoints, AT),
                StandardCharsets.UTF_8));
    }

    /** Eine eingetragene Saeule, so wie die Repository sie liefert. */
    private static AllowedChargePointDto cp(String id, String label, Double ratedKw,
            Integer connectors) {
        return new AllowedChargePointDto(id, label, ratedKw, connectors, AT, "wer-auch-immer");
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
                null, null, null, AT), StandardCharsets.UTF_8))
                .contains("\"grid_limit_kw\":277,");
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

    /**
     * Stufe 4: die QUELLEN-Wahl reist mit - und ABWESEND ist NICHT „schnell".
     *
     * <p>Das eine heißt „das Portal äußert sich nicht" und die Box behält ihre
     * Wahl; das andere ist eine eigene Aussage des Kunden („keine
     * Quellen-Politik"). Die beiden zu verschmelzen ließe eine ältere Cloud ein
     * „Nur Sonnenstrom" still fallen lassen.
     */
    @Test
    void theSourceChoiceTravelsAndAbsenceIsNotSchnell() throws Exception {
        JsonNode d = doc(null, null, "nur_sonne", "auto_vor_speicher");
        assertThat(d.get("surplus_policy").asText()).isEqualTo("nur_sonne");
        assertThat(d.get("storage_priority").asText()).isEqualTo("auto_vor_speicher");

        JsonNode silent = doc(277.0, null);
        assertThat(silent.has("surplus_policy"))
                .as("eine abwesende Wahl darf die der Box nicht überschreiben").isFalse();
        assertThat(silent.has("storage_priority")).isFalse();

        // Und „schnell" ist eine AUSSAGE, also reist es.
        assertThat(doc(null, null, "schnell", null).get("surplus_policy").asText())
                .isEqualTo("schnell");
    }

    /**
     * Der Anbinde-Assistent: die ALLOWLIST reist mit - und ein Feld, das der
     * Betreiber nicht weiss, wird WEGGELASSEN statt als 0 gesendet.
     *
     * <p>Eine 0 waere hier eine Aussage ueber ein Geraet, das niemand gemessen
     * hat („dieser Stecker kann nichts"); abwesend heisst „unbekannt", und die
     * Box entscheidet dann aus dem, was die Saeule selbst meldet.
     */
    @Test
    void theAllowlistTravelsAndWhatTheOperatorDoesNotKnowIsOmitted() throws Exception {
        JsonNode d = doc(null, null, null, null,
                List.of(cp("saeule-hof-nord", "Hof Nord", 22.0, 2), cp("saeule-halle", null, null,
                        null)));
        JsonNode list = d.get("charge_points");
        assertThat(list).hasSize(2);
        assertThat(list.get(0).get("id").asText()).isEqualTo("saeule-hof-nord");
        assertThat(list.get(0).get("label").asText()).isEqualTo("Hof Nord");
        assertThat(list.get(0).get("rated_kw").asDouble()).isEqualTo(22.0);
        assertThat(list.get(0).get("connectors").asInt()).isEqualTo(2);
        // Die zweite nennt NUR ihre Kennung.
        assertThat(list.get(1).fieldNames()).toIterable().containsExactly("id");
    }

    /**
     * ⚠ Eine LEERE Allowlist wird WEGGELASSEN. Der Box bedeuten abwesend und
     * leer hier zwar dasselbe (die Liste fuegt nur hinzu), aber ein leeres Array
     * im Dokument einer Anlage ohne Ladepark waere ein Feld, das eine Aussage
     * vortaeuscht, die niemand getroffen hat.
     */
    @Test
    void anEmptyAllowlistIsOmittedUnlikeTheEmptyPriorityList() throws Exception {
        assertThat(doc(277.0, null, null, null, List.of()).has("charge_points")).isFalse();
        assertThat(doc(277.0, null, null, null, null).has("charge_points")).isFalse();
    }

    /** Auch hier ist die Kennung Fremdtext - der Rahmen haelt. */
    @Test
    void anAdmittedChargePointCannotBreakOutOfTheDocument() throws Exception {
        JsonNode d = doc(null, null, null, null, List.of(cp("sae\"ule\n1", "La\"bel", null, null)));
        assertThat(d.get("charge_points").get(0).get("id").asText()).isEqualTo("sae\"ule\n1");
        assertThat(d.get("charge_points").get(0).get("label").asText()).isEqualTo("La\"bel");
    }

    /** Die zweite eingecheckte Fixture, Feld fuer Feld - per PFAD gelesen. */
    @Test
    void theAllowlistDocumentMatchesTheContractFixture() throws Exception {
        Path fixture = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.saeulen-eintragen.json");
        JsonNode expected = json.readTree(Files.readString(fixture));
        JsonNode actual = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, 277.0, null, null, null,
                List.of(cp("saeule-hof-nord", "Hof Nord", 22.0, 2), cp("saeule-halle", null, null,
                        null)),
                Instant.parse("2026-08-21T09:15:00Z")), StandardCharsets.UTF_8));
        assertThat(actual).isEqualTo(expected);
        // ⚠ Das Dokument nennt KEIN `priority` - der Vorrang wird allein ueber
        // `priority_charge_point_ids` gestellt (das ist eine MENGE und damit die
        // ganze Aussage). Zwei Wahrheiten ueber denselben Rang waeren eine zu
        // viel, und die Box wendet die Allowlist ohnehin VOR der Vorrang-Liste
        // an, also traegt eine gerade eingetragene Saeule den Vorrang desselben
        // Dokuments schon.
        assertThat(actual.get("charge_points").get(0).has("priority")).isFalse();
    }
}
