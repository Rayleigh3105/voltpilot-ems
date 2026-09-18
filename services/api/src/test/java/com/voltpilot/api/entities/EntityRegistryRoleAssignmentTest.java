package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryRepository.RoleAssignment;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.FlowClaimRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Befund L4: die im Portal GESPEICHERTE Rollen-Zuordnung (AE1
 * {@code entity_role_assignment}) reist im Registry-Push - rein, ohne Docker.
 *
 * <p>Bis dahin schrieb {@code PUT …/topology-roles} nur die Tabelle, und der
 * Push trug sie nicht: die Box löste IMMER über {@code topology.DefaultRole}
 * auf, also konnten Portal und {@code :8484} zwei Energieflüsse zeichnen, die
 * sich widersprechen. Additiv wie {@code charge_point_id} - eine Anlage ohne
 * eine einzige gespeicherte Zuordnung sendet exakt die Bytes von vorher.
 */
class EntityRegistryRoleAssignmentTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID METER_A = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID METER_B = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    private static final Instant NOW = Instant.parse("2026-08-31T09:00:00Z");

    private static EntityRow row(UUID id, String type) {
        return new EntityRow(id, null, null, null, null, null, null, null, null, null, false,
                type, "{\"measure\":[{\"channel\":\"power_kw\"}]}",
                "{\"failsafe\":{\"behavior\":\"measure-only\"}}", null, null, null, null, 1, null);
    }

    @SuppressWarnings("unchecked")
    private static EntityRegistryService service(EntityRegistryRepository repo) {
        ObjectProvider<EntityRegistryPublisher> publisher = mock(ObjectProvider.class);
        return new EntityRegistryService(repo, publisher, MAPPER, mock(EntityTypeCatalog.class),
                mock(AssetRepository.class), mock(FlowClaimRepository.class),
                mock(DeviceOverrideRepository.class), new LeadDeviceService(repo),
                mock(BerichtsBelege.class));
    }

    private static EntityRegistryRepository repoWith(Map<UUID, List<RoleAssignment>> roles) {
        EntityRegistryRepository repo = mock(EntityRegistryRepository.class);
        when(repo.consumerCycleLimits(any())).thenReturn(Map.of());
        when(repo.activeConsumerPolicies(any())).thenReturn(Map.of());
        when(repo.chargePointIdsByEntity(any())).thenReturn(Map.of());
        when(repo.roleAssignments(any())).thenReturn(roles);
        return repo;
    }

    private static JsonNode push(EntityRegistryService svc, List<EntityRow> rows) throws Exception {
        return MAPPER.readTree(svc.composePush(TENANT, SITE, DEVICE, NOW, rows));
    }

    /**
     * Der Kern des Befunds: ein im Portal umgewidmeter Messpunkt und ein als
     * maßgeblich markierter Zähler reisen beide - je Eintrag EIN Kanal, weil die
     * Zuordnung im Portal per Kanal getroffen wird.
     */
    @Test
    void theStoredRoleAssignmentTravelsPerChannel() throws Exception {
        EntityRegistryService svc = service(repoWith(Map.of(
                METER_A, List.of(new RoleAssignment("power_kw", "pv", false)),
                METER_B, List.of(new RoleAssignment("power_kw", "grid", true)))));

        JsonNode entities = push(svc, List.of(row(METER_A, "generic-load"),
                row(METER_B, "grid-meter"))).get("entities");

        JsonNode repurposed = entities.get(0).path("role_assignment");
        assertThat(repurposed).hasSize(1);
        assertThat(repurposed.get(0).path("channel").asText()).isEqualTo("power_kw");
        assertThat(repurposed.get(0).path("role").asText()).isEqualTo("pv");
        assertThat(repurposed.get(0).has("primary"))
                .as("ABSENT = false, damit ein Push ohne maßgebliche Wahl die Vorgabe-Regel "
                        + "der Box unangetastet lässt")
                .isFalse();

        JsonNode primaryMeter = entities.get(1).path("role_assignment");
        assertThat(primaryMeter).hasSize(1);
        assertThat(primaryMeter.get(0).path("role").asText()).isEqualTo("grid");
        assertThat(primaryMeter.get(0).path("primary").asBoolean()).isTrue();
    }

    /**
     * Additiv im Wortsinn: eine Anlage, in der niemand je eine Rolle umgewidmet
     * hat - also jede Bestandsanlage - bekommt einen Push OHNE das Feld, byte-
     * gleich zu dem vor dieser Runde.
     */
    @Test
    void aPlantWithoutAssignmentsSendsAByteIdenticalPush() throws Exception {
        byte[] payload = service(repoWith(Map.of()))
                .composePush(TENANT, SITE, DEVICE, NOW, List.of(row(METER_A, "grid-meter")));
        assertThat(new String(payload)).doesNotContain("role_assignment");
    }

    /**
     * Nur die zugeordneten Komponenten tragen den Block - eine Komponente ohne
     * gespeicherte Zuordnung bekommt kein erfundenes Feld.
     */
    @Test
    void anUnassignedComponentGetsNoInventedBlock() throws Exception {
        EntityRegistryService svc = service(repoWith(
                Map.of(METER_B, List.of(new RoleAssignment("power_kw", "grid", true)))));
        JsonNode entities = push(svc, List.of(row(METER_A, "grid-meter"),
                row(METER_B, "grid-meter"))).get("entities");

        assertThat(entities.get(0).has("role_assignment")).isFalse();
        assertThat(entities.get(1).has("role_assignment")).isTrue();
    }

    /**
     * Eine halbe Zeile ist keine Aussage: der Löschweg einer Zuordnung ist das
     * ENTFERNEN der Zeile, nie eine leere Rolle - eine solche Zeile darf die
     * Box also nie erreichen, und wenn sie die einzige war, fehlt der Block ganz.
     */
    @Test
    void aBlankChannelOrRoleIsNeverSent() throws Exception {
        EntityRegistryService svc = service(repoWith(Map.of(
                METER_A, List.of(new RoleAssignment("power_kw", "  ", true),
                        new RoleAssignment("   ", "grid", true)))));
        JsonNode entities = push(svc, List.of(row(METER_A, "grid-meter"))).get("entities");
        assertThat(entities.get(0).has("role_assignment")).isFalse();
    }

    /**
     * Der Block ist deterministisch: die Repository liefert nach Kanal sortiert,
     * und die Reihenfolge reist unverändert - sonst erzeugte derselbe Zustand
     * verschiedene Bytes und die Box sähe eine Änderung, die keine ist.
     */
    @Test
    void severalChannelsTravelInTheRepositoryOrder() throws Exception {
        EntityRow row = new EntityRow(METER_A, null, null, null, null, null, null, null, null,
                null, false, "battery-hybrid",
                "{\"measure\":[{\"channel\":\"battery_power_kw\"},{\"channel\":\"pv_power_kw\"}]}",
                "{\"failsafe\":{\"behavior\":\"self-consumption\"}}", null, null, null, null, 1,
                null);
        EntityRegistryService svc = service(repoWith(Map.of(METER_A, List.of(
                new RoleAssignment("battery_power_kw", "storage", true),
                new RoleAssignment("pv_power_kw", "pv", false)))));

        JsonNode block = push(svc, List.of(row)).get("entities").get(0).path("role_assignment");
        assertThat(block).hasSize(2);
        assertThat(block.get(0).path("channel").asText()).isEqualTo("battery_power_kw");
        assertThat(block.get(1).path("channel").asText()).isEqualTo("pv_power_kw");
    }
}
