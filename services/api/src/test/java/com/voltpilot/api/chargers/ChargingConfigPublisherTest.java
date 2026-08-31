package com.voltpilot.api.chargers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.ChargingConfigDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.AllowedChargePointDto;
import com.voltpilot.api.web.dto.FahrzeugDto.VehicleProfileDto;
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
        return doc(gridLimitKw, priorities, policy, storage, chargePoints, null);
    }

    private JsonNode doc(Double gridLimitKw, List<String> priorities, String policy,
            String storage, List<AllowedChargePointDto> chargePoints, List<String> removed)
            throws Exception {
        return doc(gridLimitKw, priorities, policy, storage, chargePoints, removed, null);
    }

    private JsonNode doc(Double gridLimitKw, List<String> priorities, String policy,
            String storage, List<AllowedChargePointDto> chargePoints, List<String> removed,
            List<VehicleProfileDto> vehicles) throws Exception {
        return json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE, DEVICE,
                gridLimitKw, priorities, policy, storage, chargePoints, removed, null, null,
                null, vehicles, AT), StandardCharsets.UTF_8));
    }

    /** Eine eingetragene Saeule, so wie die Repository sie liefert. */
    private static AllowedChargePointDto cp(String id, String label, Double ratedKw,
            Integer connectors) {
        return cp(id, label, ratedKw, connectors, null);
    }

    private static AllowedChargePointDto cp(String id, String label, Double ratedKw,
            Integer connectors, String connection) {
        return cp(id, label, ratedKw, connectors, connection, null, null);
    }

    /** Eine Saeule MIT eigener Steuerart (P5). */
    private static AllowedChargePointDto cp(String id, String label, Double ratedKw,
            Integer connectors, String connection, String source, Double minKw) {
        return cp(id, label, ratedKw, connectors, connection, source, minKw, null);
    }

    /** Eine Saeule MIT einer Position in der Rangliste (P6). */
    private static AllowedChargePointDto cp(String id, String label, Double ratedKw,
            Integer connectors, String connection, String source, Double minKw, Integer rank) {
        return new AllowedChargePointDto(id, label, ratedKw, connectors, source, minKw,
                connection, rank, AT, "wer-auch-immer");
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
                null, null, null, null, null, null, null, null, AT), StandardCharsets.UTF_8))
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
                null, null, null, null, null, Instant.parse("2026-08-21T09:15:00Z")),
                StandardCharsets.UTF_8));
        assertThat(actual).isEqualTo(expected);
        // ⚠ Das Dokument nennt KEIN `priority` - der Vorrang wird allein ueber
        // `priority_charge_point_ids` gestellt (das ist eine MENGE und damit die
        // ganze Aussage). Zwei Wahrheiten ueber denselben Rang waeren eine zu
        // viel, und die Box wendet die Allowlist ohnehin VOR der Vorrang-Liste
        // an, also traegt eine gerade eingetragene Saeule den Vorrang desselben
        // Dokuments schon.
        assertThat(actual.get("charge_points").get(0).has("priority")).isFalse();
    }

    /**
     * ⚠ Die GRABSTEIN-Liste ist die einzige Art, ein Löschen auszudrücken - eine
     * Kennung in {@code charge_points} wegzulassen ist keines. Abwesend/leer
     * wird deshalb WEGGELASSEN (ein leeres Array behauptete eine Rücknahme, die
     * niemand ausgesprochen hat), und eine echte Rücknahme reist mit.
     */
    @Test
    void aRemovalIsSaidExplicitlyAndAnEmptyOneIsOmitted() throws Exception {
        assertThat(doc(277.0, null, null, null, null, null).has("removed_charge_point_ids"))
                .as("abwesend heißt „das Portal äußert sich nicht\"").isFalse();
        assertThat(doc(277.0, null, null, null, null, List.of())
                .has("removed_charge_point_ids"))
                .as("eine leere Liste behauptete eine Rücknahme, die es nicht gab").isFalse();

        JsonNode d = doc(277.0, null, null, null, List.of(cp("saeule-1", null, null, null)),
                List.of("saeule-2"));
        assertThat(d.get("removed_charge_point_ids")).hasSize(1);
        assertThat(d.get("removed_charge_point_ids").get(0).asText()).isEqualTo("saeule-2");
        // Beide Listen stehen nebeneinander, und keine Kennung ist in beiden.
        assertThat(d.get("charge_points").get(0).get("id").asText()).isEqualTo("saeule-1");
    }

    /** Auch eine zurückgenommene Kennung ist Fremdtext - der Rahmen hält. */
    @Test
    void aRemovedChargePointIdCannotBreakOutOfTheDocument() throws Exception {
        JsonNode d = doc(null, null, null, null, null, List.of("sae\"ule\n1"));
        assertThat(d.get("removed_charge_point_ids").get(0).asText()).isEqualTo("sae\"ule\n1");
    }

    /** Die dritte eingecheckte Fixture, Feld für Feld - per PFAD gelesen. */
    @Test
    void theRemovalDocumentMatchesTheContractFixture() throws Exception {
        Path fixture = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.saeule-entfernen.json");
        JsonNode expected = json.readTree(Files.readString(fixture));
        JsonNode actual = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, 277.0, null, null, null,
                List.of(cp("saeule-hof-nord", "Hof Nord", null, null)), List.of("saeule-halle"),
                null, null, null, null, Instant.parse("2026-08-24T10:05:00Z")),
                StandardCharsets.UTF_8));
        assertThat(actual).isEqualTo(expected);
    }

    /**
     * Cockpit Phase 1 / C1: WO eine Säule hängt reist im BESTEHENDEN Dokument
     * mit - und NUR, wenn der Kunde es wirklich gesagt hat.
     *
     * <p>⚠ Ein hier eingesetztes {@code "haus"} wäre eine Aussage über die
     * Bilanz einer Anlage, die niemand getroffen hat - und würde auf der Box
     * eine schon als {@code "eigen"} geführte Säule zurückdrehen.
     */
    @Test
    void theConnectionTravelsOnlyWhenTheCustomerSaidIt() throws Exception {
        JsonNode d = doc(null, null, null, null, List.of(
                cp("haus-1", null, null, null, "haus"),
                cp("eigen-1", null, null, null, "eigen"),
                cp("stumm-1", null, null, null, null)));
        JsonNode list = d.get("charge_points");
        assertThat(list.get(0).get("connection").asText()).isEqualTo("haus");
        assertThat(list.get(1).get("connection").asText()).isEqualTo("eigen");
        assertThat(list.get(2).has("connection")).isFalse();
        assertThat(list.get(2).fieldNames()).toIterable().containsExactly("id");
    }

    /** Die Fixture des eigenen Anschlusses, Feld für Feld - per PFAD gelesen. */
    @Test
    void theOwnConnectionDocumentMatchesTheContractFixture() throws Exception {
        Path fixture = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.eigener-anschluss.json");
        JsonNode expected = json.readTree(Files.readString(fixture));
        JsonNode actual = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, 277.0, null, null, null,
                List.of(cp("saeule-hof-nord", "Hof Nord", 22.0, 2, "haus"),
                        cp("saeule-strasse", "Ladepark Strasse", null, null, "eigen"),
                        cp("saeule-halle", null, null, null, null)),
                null, null, null, null, null, Instant.parse("2026-08-28T09:15:00Z")),
                StandardCharsets.UTF_8));
        assertThat(actual).isEqualTo(expected);
    }

    // -----------------------------------------------------------------------
    // P5: die Steuerart je Saeule und der Ladepark-Rahmen
    // -----------------------------------------------------------------------

    /** Die STEUERART reist nur auf Ansage - abwesend ist nie „schnell". */
    @Test
    void aStationsOwnSourceTravelsOnlyWhenItWasChosen() throws Exception {
        JsonNode d = doc(null, null, "sonne_zuerst", null,
                List.of(cp("saeule-hof-nord", null, null, null, null, "nur_sonne", 4.2),
                        cp("saeule-halle", null, null, null)));
        JsonNode gewaehlt = d.get("charge_points").get(0);
        assertThat(gewaehlt.get("source").asText()).isEqualTo("nur_sonne");
        assertThat(gewaehlt.get("min_kw").asDouble()).isEqualTo(4.2);
        // ⚠ Die Saeule OHNE eigene Wahl traegt das Feld GAR NICHT - sie folgt
        // dem Anlagen-Standard, und ein eingesetztes „schnell" waere eine
        // Netzstrom-Freigabe, die niemand erteilt hat.
        assertThat(d.get("charge_points").get(1).has("source")).isFalse();
        assertThat(d.get("charge_points").get(1).has("min_kw")).isFalse();
        // Und der Anlagen-Standard steht unveraendert daneben.
        assertThat(d.get("surplus_policy").asText()).isEqualTo("sonne_zuerst");
    }

    /** Der RAHMEN folgt der PATCH-Regel: nur genannte Felder reisen. */
    @Test
    void theFrameTravelsFieldByFieldAndNeverAsAnEmptyObject() throws Exception {
        JsonNode d = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, null, null, null, null, null, null,
                new ChargingConfigDto.LadeparkRahmenDto(167.0, null, 30.0, null, null, false),
                null, null, null, AT), StandardCharsets.UTF_8));
        JsonNode frame = d.get("frame");
        assertThat(frame.get("house_reserve_kw").asInt()).isEqualTo(167);
        assertThat(frame.get("min_power_kw").asInt()).isEqualTo(30);
        assertThat(frame.get("static_budget").asBoolean()).isFalse();
        assertThat(frame.has("margin_pct")).isFalse();
        assertThat(frame.has("rotation_minutes")).isFalse();

        // Ein Rahmen ohne einen einzigen Wert reist GAR NICHT - ein leeres
        // Objekt taeuschte eine Aussage vor.
        JsonNode leer = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, null, null, null, null, null, null,
                new ChargingConfigDto.LadeparkRahmenDto(null, null, null, null, null, null),
                null, null, null, AT), StandardCharsets.UTF_8));
        assertThat(leer.has("frame")).isFalse();
    }

    /** Die vierte eingecheckte Fixture, Feld fuer Feld - per PFAD gelesen. */
    @Test
    void theSteuerartAndFrameDocumentMatchesTheContractFixture() throws Exception {
        Path fixture = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.steuerart-je-saeule.json");
        JsonNode expected = json.readTree(Files.readString(fixture));
        JsonNode actual = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, 277.0, null, "sonne_zuerst", null,
                List.of(cp("saeule-hof-nord", null, null, null, null, "nur_sonne", null),
                        cp("saeule-chef", null, null, null, null, "schnell", null),
                        cp("saeule-halle", null, null, null, null, "sonne_zuerst", 4.2)),
                null,
                new ChargingConfigDto.LadeparkRahmenDto(167.0, 10.0, 30.0, 15, 180.0, false),
                null, null, null, Instant.parse("2026-08-31T09:15:00Z")),
                StandardCharsets.UTF_8));
        assertThat(actual).isEqualTo(expected);
    }

    // --- P6: die Rangliste erreicht die Box -----------------------------------

    @Test
    void dieRaengeReisenJeSaeuleUndDerSpeicherStehtDANEBEN() throws Exception {
        Path fixture = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.rangliste.json");
        JsonNode expected = json.readTree(Files.readString(fixture));
        JsonNode actual = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, 44.0, null, "sonne_zuerst", "speicher_vor_auto",
                List.of(cp("saeule-chef", null, null, null, null, null, null, 1),
                        cp("saeule-hof-nord", null, null, null, null, null, null, 3),
                        cp("saeule-halle", null, null, null, null, null, null, 3)),
                null, null, 2, null, null, Instant.parse("2026-08-31T09:15:00Z")),
                StandardCharsets.UTF_8));
        assertThat(actual).isEqualTo(expected);
    }

    @Test
    void ohneRangReistWederEinRangNochEineSpeicherPositionMit() throws Exception {
        // ⚠ DIE KOMPATIBILITAETS-ZUSAGE des ganzen Pakets: eine Anlage, deren
        // Kunde nie sortiert hat, bekommt ein Dokument OHNE `rank` und OHNE
        // `storage_rank` - und die Box verteilt dann exakt wie vor P6.
        JsonNode d = doc(277.0, null, null, null,
                List.of(cp("saeule-hof-nord", "Hof Nord", 22.0, 2)));
        assertThat(d.has("storage_rank")).isFalse();
        assertThat(d.get("charge_points").get(0).has("rank")).isFalse();
    }

    @Test
    void eineNullPositionWaereKeinePositionUndReistNieMit() {
        // Der DB-CHECK laesst sie gar nicht zu; der Publisher verlaesst sich
        // trotzdem nicht darauf - eine 0 waere im Kontrakt „ungerankt" und
        // damit eine Aussage, die niemand getroffen hat.
        JsonNode d;
        try {
            d = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE, DEVICE,
                    null, null, null, null,
                    List.of(cp("saeule-halle", null, null, null, null, null, null, 0)), null, null,
                    0, null, null, Instant.parse("2026-08-31T09:15:00Z")),
                    StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        assertThat(d.has("storage_rank")).isFalse();
        assertThat(d.get("charge_points").get(0).has("rank")).isFalse();
    }

    @Test
    void eineWallboxTrittDemRahmenBeiUndDieLEEREListeNimmtSieWiederHeraus() throws Exception {
        JsonNode d = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE, DEVICE,
                22.0, null, null, null, null, null, null, 3,
                List.of(new ChargingConfigDto.WallboxDto(
                        UUID.fromString("00000000-0000-0000-0000-0000000000aa"), "Wallbox Garage",
                        11.0, 4.2, 1)),
                null, Instant.parse("2026-08-31T09:15:00Z")), StandardCharsets.UTF_8));
        JsonNode wb = d.get("wallboxes").get(0);
        assertThat(wb.get("entity_id").asText())
                .isEqualTo("00000000-0000-0000-0000-0000000000aa");
        assertThat(wb.get("label").asText()).isEqualTo("Wallbox Garage");
        assertThat(wb.get("rated_kw").asDouble()).isEqualTo(11.0);
        assertThat(wb.get("min_kw").asDouble()).isEqualTo(4.2);
        assertThat(wb.get("rank").asInt()).isEqualTo(1);
        // ⚠ Die Cloud nennt (noch) KEINE eigene Quelle je Wallbox - dann gilt
        // der Anlagen-Standard. Der Kontrakt kennt das Feld, das Portal fuellt
        // es nicht: eine erfundene Quelle waere eine Netzstrom-Freigabe.
        assertThat(wb.has("source")).isFalse();

        // ⚠ Und die LEERE Liste ist hier - anders als bei der Allowlist - eine
        // AUSSAGE: nur so faellt eine entfernte Wallbox wieder aus dem Rahmen.
        JsonNode leer = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, 22.0, null, null, null, null, null, null, null, List.of(), null,
                Instant.parse("2026-08-31T09:15:00Z")), StandardCharsets.UTF_8));
        assertThat(leer.get("wallboxes")).isEmpty();

        // Ohne jede Aussage reist das Feld GAR NICHT mit.
        assertThat(doc(277.0, null, null, null).has("wallboxes")).isFalse();
    }

    // -----------------------------------------------------------------------
    // P7: die Fahrzeug-Profile
    // -----------------------------------------------------------------------

    /**
     * Die MENGE ist die Aussage - und das ist die UMGEKEHRTE Regel der
     * Allowlist. Eine LEERE Liste reist MIT (sie nimmt alle Profile zurueck),
     * nur `null` schweigt.
     */
    @Test
    void vehicleProfilesTravelAsASetAndAnEmptyListWithdrawsThemAll() throws Exception {
        assertThat(doc(null, null, null, null, null, null, null).has("vehicle_profiles"))
                .as("ohne Aussage darf das Feld nicht entstehen").isFalse();

        JsonNode leer = doc(null, null, null, null, null, null, List.of());
        assertThat(leer.get("vehicle_profiles").isArray()).isTrue();
        assertThat(leer.get("vehicle_profiles")).isEmpty();
    }

    /** Nur was gemeint ist, reist mit: kein Name, kein Boden, keine 0. */
    @Test
    void aVehicleProfileCarriesOnlyWhatItReallySays() throws Exception {
        JsonNode d = doc(null, null, null, null, null, null,
                List.of(new VehicleProfileDto("tagref_1f2e3d4c5b6a798877665544", null,
                                "schnell", null),
                        new VehicleProfileDto("tagref_00112233445566778899aabb", "Privatwagen",
                                "sonne_zuerst", 4.2)));
        JsonNode ohne = d.get("vehicle_profiles").get(0);
        assertThat(ohne.get("tag_ref").asText()).isEqualTo("tagref_1f2e3d4c5b6a798877665544");
        assertThat(ohne.get("source").asText()).isEqualTo("schnell");
        assertThat(ohne.has("name")).isFalse();
        assertThat(ohne.has("min_kw")).isFalse();
        JsonNode mit = d.get("vehicle_profiles").get(1);
        assertThat(mit.get("name").asText()).isEqualTo("Privatwagen");
        assertThat(mit.get("min_kw").asDouble()).isEqualTo(4.2);
    }

    /** Ein Kundenname ist Fremdtext - er darf den JSON-Rahmen nie sprengen. */
    @Test
    void aVehicleNameCannotBreakOutOfTheDocument() throws Exception {
        JsonNode d = doc(null, null, null, null, null, null,
                List.of(new VehicleProfileDto("tagref_1f2e3d4c5b6a798877665544",
                        "Dienst\"wagen\n", "schnell", null)));
        assertThat(d.get("vehicle_profiles").get(0).get("name").asText())
                .isEqualTo("Dienst\"wagen\n");
    }

    /** Die eingecheckte P7-Fixture, Feld fuer Feld - per PFAD gelesen. */
    @Test
    void theVehicleProfileFixtureIsExactlyWhatThePublisherWrites() throws Exception {
        Path fixture = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.fahrzeug-profile.json");
        JsonNode expected = json.readTree(Files.readString(fixture));
        JsonNode actual = json.readTree(new String(ChargingConfigPublisher.document(TENANT, SITE,
                DEVICE, 32.0, null, "nur_sonne", null,
                List.of(cp("stellplatz-01", null, null, null, null, "nur_sonne", null)),
                null, null, null, null,
                List.of(new VehicleProfileDto("tagref_1f2e3d4c5b6a798877665544", "Dienstwagen",
                                "schnell", null),
                        new VehicleProfileDto("tagref_00112233445566778899aabb", "Privatwagen",
                                "sonne_zuerst", 4.2)),
                Instant.parse("2026-08-31T09:15:00Z")), StandardCharsets.UTF_8));
        assertThat(actual).isEqualTo(expected);

        Path zurueck = Path.of("..", "..", "docs", "contracts", "examples",
                "mqtt-charging-config.valid.fahrzeug-profile-zurueckgenommen.json");
        JsonNode expectedBack = json.readTree(Files.readString(zurueck));
        JsonNode actualBack = json.readTree(new String(ChargingConfigPublisher.document(TENANT,
                SITE, DEVICE, null, null, null, null, null, null, null, null, null, List.of(),
                Instant.parse("2026-08-31T10:00:00Z")), StandardCharsets.UTF_8));
        assertThat(actualBack).isEqualTo(expectedBack);
    }
}
