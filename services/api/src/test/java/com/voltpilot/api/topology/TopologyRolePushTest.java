package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

/**
 * Befund L4, zweite Hälfte: eine gespeicherte Rollen-Zuordnung muss die BOX
 * auch erreichen. {@code PUT …/topology-roles} schrieb bis dahin nur
 * {@code entity_role_assignment} und stiess KEINEN Push an - die Box zeichnete
 * bis zum nächsten beliebigen Push (Umbenennen, Bearbeiten, Übernahme) weiter
 * ihre Defaults.
 *
 * <p>Rein, ohne Docker. Der Push läuft hier sofort, weil keine Transaktion
 * aktiv ist; in beiden Controllern ({@code @Transactional}) läuft er NACH dem
 * Commit - das {@code EntityAutoComposer}-Muster.
 */
class TopologyRolePushTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID ENTITY = UUID.fromString("00000000-0000-0000-0000-0000000000a1");

    private EntityRegistryRepository registry;
    private TopologyRepository repo;
    private EntityRegistryService push;
    private TopologyService service;

    @BeforeEach
    void setUp() {
        registry = mock(EntityRegistryRepository.class);
        repo = mock(TopologyRepository.class);
        push = mock(EntityRegistryService.class);
        EntityTypeCatalog catalog = mock(EntityTypeCatalog.class);
        DeviceChargerStatusRepository chargers = mock(DeviceChargerStatusRepository.class);
        when(registry.entityForSite(eq(SITE), eq(ENTITY))).thenReturn(row());
        when(registry.entitiesForSite(eq(SITE))).thenReturn(List.of(row()));
        when(repo.overrides(eq(SITE))).thenReturn(List.of());
        when(repo.latestValues(any(), any())).thenReturn(List.of());
        when(chargers.connectionsByEntity(eq(SITE))).thenReturn(Map.of());
        service = new TopologyService(registry, repo, catalog, new ObjectMapper(), chargers, push, mock(RollenZuordnungService.class));
        TenantContext.set(TENANT);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    private static EntityRow row() {
        return new EntityRow(ENTITY, null, null, null, null, null, null, null, null, null, false,
                "grid-meter", "{\"measure\":[{\"channel\":\"power_kw\"}]}",
                "{\"failsafe\":{\"behavior\":\"measure-only\"}}", null, null, null, null, 1, null);
    }

    /** Die Zuordnung wird gespeichert UND an die Box geschickt. */
    @Test
    void anAssignmentIsPushedToTheDevice() {
        service.applyAssignments(SITE,
                List.of(new TopologyService.Assignment(ENTITY, "power_kw", "pv", true)));

        verify(repo).upsertOverride(TENANT, SITE, ENTITY, "power_kw", "pv", true);
        verify(push).pushRegistryBestEffort(SITE);
    }

    /** Auch das ZURÜCKNEHMEN einer Zuordnung muss die Box erfahren. */
    @Test
    void clearingAnAssignmentIsPushedToo() {
        service.applyAssignments(SITE,
                List.of(new TopologyService.Assignment(ENTITY, "power_kw", "  ", false)));

        verify(repo).deleteOverride(SITE, ENTITY, "power_kw");
        verify(push).pushRegistryBestEffort(SITE);
    }

    /** Ein leerer Stapel ändert nichts - und pusht deshalb auch nichts. */
    @Test
    void anEmptyBatchPushesNothing() {
        service.applyAssignments(SITE, List.of());
        service.applyAssignments(SITE, null);
        verify(push, never()).pushRegistryBestEffort(any());
    }

    /**
     * Eine abgelehnte Zuordnung darf die Box nie erreichen: die Prüfung läuft
     * vor dem ersten Schreibvorgang, also gibt es weder Zeile noch Push.
     */
    @Test
    void arefusedAssignmentNeverReachesTheDevice() {
        assertThatThrownBy(() -> service.applyAssignments(SITE,
                List.of(new TopologyService.Assignment(ENTITY, "power_kw", "waermepumpe", false))))
                .isInstanceOf(ResponseStatusException.class);

        verify(push, never()).pushRegistryBestEffort(any());
        verify(repo, never()).upsertOverride(any(), any(), any(), any(), any(),
                org.mockito.ArgumentMatchers.anyBoolean());
    }

    /**
     * Der Push ist BEST EFFORT: eine Rolle ist Anzeige, ein Broker-Ausfall darf
     * die Zuordnung des Kunden nicht verwerfen - der nächste Push beliebiger Art
     * heilt sie (das {@code updateEntity}-Muster beim Umbenennen).
     */
    @Test
    void aFailedPushNeverLosesTheStoredAssignment() {
        org.mockito.Mockito.doThrow(new IllegalStateException("Broker weg"))
                .when(push).pushRegistryBestEffort(SITE);

        TopologyService.TopologyResponse response = service.applyAssignments(SITE,
                List.of(new TopologyService.Assignment(ENTITY, "power_kw", "grid", true)));

        assertThat(response).isNotNull();
        verify(repo).upsertOverride(TENANT, SITE, ENTITY, "power_kw", "grid", true);
    }
}
