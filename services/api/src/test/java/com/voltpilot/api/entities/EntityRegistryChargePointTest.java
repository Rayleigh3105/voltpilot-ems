package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Cockpit Phase 1 / E1: der Registry-Push nennt die OCPP-ChargePointId einer
 * Ladepunkt-Komponente - rein, ohne Docker.
 *
 * <p>Es ist der Zwilling von {@code edge_source_id} einen Transport weiter: eine
 * Ladesäule ist keine Quelle in {@code sources.json} (sie wählt die Box AN), ihre
 * gemessenen Kilowatt liessen sich also über keinen anderen Schlüssel auf die
 * Komponente abbilden. Ohne dieses Feld veröffentlicht die Box gar keine
 * Ladepunkt-Telemetrie je Entität, und eine ältere Cloud ist damit
 * byte-identisch zum Vor-Phase-1-Stand.
 */
class EntityRegistryChargePointTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID CHARGER = UUID.fromString("00000000-0000-0000-0000-0000000000c1");
    private static final UUID BATTERY = UUID.fromString("00000000-0000-0000-0000-0000000000b1");

    private static EntityRow row(UUID id, String type) {
        return new EntityRow(id, null, null, null, null, null, null, null, null, null, false,
                type, "{\"measure\":[{\"channel\":\"power_kw\"}]}",
                "{\"failsafe\":{\"behavior\":\"release\"}}", null, null, null, null, 1, null);
    }

    @SuppressWarnings("unchecked")
    private static EntityRegistryService service(EntityRegistryRepository repo) {
        ObjectProvider<EntityRegistryPublisher> publisher = mock(ObjectProvider.class);
        return new EntityRegistryService(repo, publisher, MAPPER, mock(EntityTypeCatalog.class),
                mock(AssetRepository.class), mock(FlowClaimRepository.class),
                mock(DeviceOverrideRepository.class), new LeadDeviceService(repo),
                mock(BerichtsBelege.class));
    }

    private static EntityRegistryRepository repoWith(Map<UUID, String> chargePoints) {
        EntityRegistryRepository repo = mock(EntityRegistryRepository.class);
        when(repo.consumerCycleLimits(any())).thenReturn(Map.of());
        when(repo.activeConsumerPolicies(any())).thenReturn(Map.of());
        when(repo.chargePointIdsByEntity(any())).thenReturn(chargePoints);
        return repo;
    }

    private static JsonNode push(EntityRegistryService svc, List<EntityRow> rows) throws Exception {
        return MAPPER.readTree(
                svc.composePush(TENANT, SITE, DEVICE, Instant.parse("2026-08-28T12:00:00Z"), rows));
    }

    @Test
    void aChargePointComponentCarriesItsOcppIdentity() throws Exception {
        EntityRegistryService svc = service(repoWith(Map.of(CHARGER, "saeule-1")));
        JsonNode entities = push(svc, List.of(row(CHARGER, "ev-charger"))).get("entities");

        assertThat(entities).hasSize(1);
        assertThat(entities.get(0).path("charge_point_id").asText()).isEqualTo("saeule-1");
    }

    /**
     * Additiv im Wortsinn: eine Anlage ohne Ladepunkt - und jede Komponente, die
     * keiner ist - sendet das Feld GAR NICHT. Der Push ist damit byte-gleich zu
     * dem, den dieselbe Anlage vor Phase 1 bekommen hat.
     */
    @Test
    void aPlantWithoutChargePointsSendsAByteIdenticalPush() throws Exception {
        List<EntityRow> rows = List.of(row(BATTERY, "battery-hybrid"));
        byte[] withFeature = service(repoWith(Map.of()))
                .composePush(TENANT, SITE, DEVICE, Instant.parse("2026-08-28T12:00:00Z"), rows);
        assertThat(new String(withFeature)).doesNotContain("charge_point_id");
    }

    /**
     * Nur BEIDES gebunden zählt: eine gemeldete Säule, die noch keine Komponente
     * ist, taucht in der Karte gar nicht auf - und eine Komponente ohne Bindung
     * bekommt kein erfundenes Feld.
     */
    @Test
    void anUnboundComponentGetsNoInventedIdentity() throws Exception {
        EntityRegistryService svc = service(repoWith(Map.of(CHARGER, "saeule-1")));
        JsonNode entities = push(svc,
                List.of(row(CHARGER, "ev-charger"), row(BATTERY, "battery-hybrid"))).get("entities");

        assertThat(entities).hasSize(2);
        assertThat(entities.get(0).has("charge_point_id")).isTrue();
        assertThat(entities.get(1).has("charge_point_id"))
                .as("die Batterie ist keine Ladesäule").isFalse();
    }

    /** Eine leere Kennung ist keine Bindung - sie wird nie gesendet. */
    @Test
    void aBlankIdentityIsNeverSent() throws Exception {
        EntityRegistryService svc = service(repoWith(Map.of(CHARGER, "   ")));
        JsonNode entities = push(svc, List.of(row(CHARGER, "ev-charger"))).get("entities");
        assertThat(entities.get(0).has("charge_point_id")).isFalse();
    }
}
