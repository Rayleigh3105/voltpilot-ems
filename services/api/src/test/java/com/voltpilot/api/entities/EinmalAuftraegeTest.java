package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.consumers.*;
import com.voltpilot.api.interventions.*;
import com.voltpilot.api.measurement.*;
import com.voltpilot.api.probe.*;
import com.voltpilot.api.registerwrite.*;
import com.voltpilot.api.repo.*;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.UebergabeRepository;
import com.voltpilot.api.uems.ZustaendigkeitRepository.Zeitraum;
import com.voltpilot.api.uems.FuehrendeBoxAbleitung.Grund;
import com.voltpilot.api.web.dto.DeviceDto;
import java.math.BigDecimal;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.server.ResponseStatusException;

/** Real routing service and real callers; mocks only at persistence and MQTT boundaries. */
class EinmalAuftraegeTest {
    final UUID tenant = UUID.randomUUID(), site = UUID.randomUUID(), entity = UUID.randomUUID();
    final UUID a = UUID.randomUUID(), b = UUID.randomUUID(), source = UUID.randomUUID(), assignment = UUID.randomUUID();
    final Instant now = Instant.now();
    final EntityRegistryRepository entities = mock(EntityRegistryRepository.class);
    final LeadDeviceService lead = mock(LeadDeviceService.class);
    final DeviceRepository devices = mock(DeviceRepository.class);
    final UebergabeRepository transfers = mock(UebergabeRepository.class);
    final EinmalAuftragZiel target = new EinmalAuftragZiel(entities, lead, devices, transfers);
    final EntityRegistryRepository.EntityRow component = mock(EntityRegistryRepository.EntityRow.class);
    final ConsumerOverridePublisher overridesPublisher = mock(ConsumerOverridePublisher.class);
    final ConsumerOverrideRepository consumerOverrides = mock(ConsumerOverrideRepository.class);
    final ConsumerPolicyActivationService activation = mock(ConsumerPolicyActivationService.class);
    UUID expected;

    @BeforeEach void setup() {
        TenantContext.set(tenant);
        when(component.id()).thenReturn(entity);
        when(component.entityType()).thenReturn("battery-hybrid");
        when(entities.entityForSite(site, entity)).thenReturn(component);
        when(entities.entitiesForSite(site)).thenReturn(List.of(component));
        when(lead.fuehrendeBox(site)).thenReturn(new LeadDeviceService.FuehrendeBox(a, Grund.EINZIGE));
        when(devices.findById(a)).thenReturn(Optional.of(box(a)));
        when(devices.findById(b)).thenReturn(Optional.of(box(b)));
        when(overridesPublisher.publishOverride(any(), any(), any(), any(), any(), any(), anyInt(), any())).thenReturn(true);
        when(overridesPublisher.publishWithdraw(any(), any(), any(), any())).thenReturn(true);
        when(activation.activationAvailable()).thenReturn(true);
    }
    @AfterEach void clear() { TenantContext.clear(); }

    DeviceDto box(UUID id) { return new DeviceDto(id, site, "box-" + id, "gateway", "Box", "claimed", now, now); }
    @SuppressWarnings("unchecked") <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> p = mock(ObjectProvider.class); when(p.getIfAvailable()).thenReturn(value); return p;
    }
    void world(String scenario) {
        expected = "assigned".equals(scenario) ? b : a;
        when(devices.findAll()).thenReturn("single".equals(scenario) ? List.of(box(a)) : List.of(box(a), box(b)));
        if ("single".equals(scenario) || "lead".equals(scenario)) return;
        when(entities.datenquelleJeEntitaet(site)).thenReturn(Map.of(entity, source));
        when(entities.zustaendigkeitenDerQuellen(site)).thenReturn(List.of(
                new Zeitraum(assignment, source, b, now.minusSeconds(60), null)));
        when(transfers.stand(source)).thenReturn(new UebergabeRepository.Stand(source, site, assignment,
                expected, b, "pending".equals(scenario) ? "pending" : "active", now, now, null, null));
    }

    @ParameterizedTest @ValueSource(strings={"single", "lead", "assigned", "pending"})
    void probeConnectionAndSwitchUseExecutionBox(String scenario) throws Exception {
        world(scenario);
        ProbeRegistry registry = mock(ProbeRegistry.class);
        when(registry.await(any(), any())).thenReturn(new ProbeResult("id", null, null, List.of()));
        ProbePublisher pub = mock(ProbePublisher.class);
        ProbeService service = new ProbeService(devices, registry, provider(pub), target);
        UUID requested = "single".equals(scenario) ? null : b;
        UUID bound = "single".equals(scenario) ? null : entity;
        service.probe(site, new ProbeRequest(requested, List.of(), bound), "actor");
        service.testConnection(site, requested, bound, "test", "brand", "model", "family", "role", Map.of(), "actor");
        service.switchOp(site, requested, bound, mock(ProbePublisher.SwitchOp.class), "actor");
        verify(pub).publish(eq(tenant), eq(site), eq(expected), anyString(), any(), eq("actor"), anyList());
        verify(pub).publishTest(eq(tenant), eq(site), eq(expected), anyString(), any(), eq("actor"),
                eq("test"), eq("brand"), eq("model"), eq("family"), eq("role"), eq(Map.of()));
        verify(pub).publishSwitch(eq(tenant), eq(site), eq(expected), anyString(), any(), eq("actor"), any());
    }

    @ParameterizedTest @ValueSource(strings={"single", "lead", "assigned", "pending"})
    void registerPreviewAndWriteUseExecutionBox(String scenario) throws Exception {
        world(scenario);
        RegisterKnowledge knowledge = mock(RegisterKnowledge.class);
        when(knowledge.of(any(), anyInt())).thenReturn(new RegisterKnowledge.Known(null, "unknown", null, null, null));
        RegisterWriteRegistry registry = mock(RegisterWriteRegistry.class);
        when(registry.await(any(), any())).thenReturn(RegisterWriteResult.silent("id", "read", "timeout"));
        RegisterWritePublisher pub = mock(RegisterWritePublisher.class);
        RegisterWriteService service = new RegisterWriteService(devices, knowledge, mock(RegisterWriteTargets.class),
                registry, mock(RegisterWriteEventRepository.class), provider(pub), Duration.ofSeconds(40), Duration.ofSeconds(60), true, target);
        var cmd = new RegisterWriteService.Command("single".equals(scenario) ? null : b,
                "single".equals(scenario) ? "primary" : "entity", "single".equals(scenario) ? null : entity,
                null, null, null, "holding", "100", "1", 0, 6, "Test");
        var actor = new RegisterWriteService.Actor("actor", "Actor", false);
        service.preview(site, cmd, actor);
        service.write(site, cmd, actor);
        verify(pub, times(2)).publish(eq(tenant), eq(site), eq(expected), anyString(), any(), eq("actor"), any());
    }

    ConsumerOverrideService consumerService() {
        ConsumerRepository repo = mock(ConsumerRepository.class);
        var row = mock(ConsumerRepository.ConsumerRow.class);
        // New sources need no legacy device link; old links must not overrule execution.
        UUID legacyDevice = entities.datenquelleJeEntitaet(site).isEmpty() ? b : null;
        when(row.deviceId()).thenReturn(legacyDevice);
        when(row.controlKind()).thenReturn("on_off");
        when(repo.findForSite(site, entity)).thenReturn(row);
        return new ConsumerOverrideService(repo, consumerOverrides, mock(ConsumerAuditRepository.class),
                activation, provider(overridesPublisher), target);
    }
    @ParameterizedTest @ValueSource(strings={"single", "lead", "assigned", "pending"})
    void consumerStartStopAndWithdrawUseExecutionBox(String scenario) {
        world(scenario);
        var svc = consumerService();
        for (String action : List.of("start", "stop")) {
            var result = svc.start(site, entity, new ConsumerOverrideService.OverrideRequest(action, 10, null, null), "actor");
            assertThat(result.pushed()).isTrue(); assertThat(result.pushReason()).isNull();
        }
        assertThat(svc.clear(site, entity, "actor").pushed()).isTrue();
        verify(overridesPublisher, times(2)).publishOverride(eq(tenant), eq(site), eq(expected), eq(entity), any(), any(), anyInt(), any());
        verify(overridesPublisher).publishWithdraw(tenant, site, expected, entity);
    }

    DeviceOverrideService batteryService(ObjectProvider<ConsumerOverridePublisher> p) {
        return new DeviceOverrideService(mock(DeviceOverrideRepository.class), entities,
                mock(ConsumerAuditRepository.class), p, provider(null), target);
    }
    @ParameterizedTest @ValueSource(strings={"single", "lead", "assigned", "pending"})
    void batteryStartAndWithdrawUseExecutionBoxWithoutAssetDevice(String scenario) {
        world(scenario);
        var svc = batteryService(provider(overridesPublisher));
        assertThat(svc.startBattery(site, new Handeingriff.Anfrage(Handeingriff.HALTEN, 20, null, null), "actor").pushed()).isTrue();
        assertThat(svc.clearBattery(site, "actor").pushed()).isTrue();
        verify(overridesPublisher).publishOverride(eq(tenant), eq(site), eq(expected), eq(entity), isNull(), eq(BigDecimal.ZERO), anyInt(), any());
        verify(overridesPublisher).publishWithdraw(tenant, site, expected, entity);
    }

    @ParameterizedTest @ValueSource(strings={"single", "lead", "assigned", "pending"})
    void measurementSelectionReadsAndWritesOnExecutionBox(String scenario) {
        world(scenario);
        MeasurementSelectionRepository repo = mock(MeasurementSelectionRepository.class);
        var scopeA = new MeasurementSelectionRepository.DeviceScope(tenant, site, a);
        var scopeB = new MeasurementSelectionRepository.DeviceScope(tenant, site, b);
        when(repo.aktiverDeviceScope(a)).thenReturn(scopeA); when(repo.aktiverDeviceScope(b)).thenReturn(scopeB);
        when(repo.lockDevice(a)).thenReturn(scopeA); when(repo.lockDevice(b)).thenReturn(scopeB);
        when(repo.entitySiteId(entity)).thenReturn(site);
        MeasurementCatalog catalog = mock(MeasurementCatalog.class);
        when(catalog.version()).thenReturn("test");
        when(repo.save(any(), any(), anyString(), anyBoolean(), anyInt(), anyLong(), any(), any(), any(), any(), any(), any()))
                .thenReturn(mock(MeasurementSelectionRepository.Row.class));
        var svc = new MeasurementSelectionService(repo, catalog, new ObjectMapper(), new MeasurementBudgetProperties(Map.of()), target);
        assertThat(svc.state(a, entity).deviceId()).isEqualTo(expected);
        var definition = new CustomMeasurementPoint.Definition("Test", "modbus_holding", 100, "holding:0x0064", "uint16", 16, false,
                "big", BigDecimal.ONE, "W", 60, "thermal_bms", true);
        var result = svc.addCustom(a, entity, new MeasurementSelectionService.CustomChange(0, UUID.randomUUID(), definition),
                new MeasurementSelectionService.Actor("actor", "Actor"));
        assertThat(result.deviceId()).isEqualTo(expected);
        verify(repo).lockDevice(expected);
        verify(repo).save(eq(new MeasurementSelectionRepository.DeviceScope(tenant, site, expected)), eq(entity), anyString(),
                eq(true), eq(60), anyLong(), any(), any(), any(), any(), any(), any());
    }

    @ParameterizedTest @ValueSource(strings={"removing", "reconciling", "receiving", "unknown"})
    void noUnconfirmedOwnerOrFallbackDuringTransfer(String phase) {
        world("pending");
        when(transfers.stand(source)).thenReturn(new UebergabeRepository.Stand(source, site, assignment, a, b, phase, now, now, null, null));
        assertThatThrownBy(() -> target.komponente(site, entity)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(409));
        verifyNoInteractions(overridesPublisher);
    }

    @Test void namedDeliveryFailureOnBothWithdrawPaths() {
        world("pending");
        when(overridesPublisher.publishWithdraw(any(), any(), any(), any())).thenReturn(false);
        var consumer = consumerService().clear(site, entity, "actor");
        assertThat(consumer.pushed()).isFalse(); assertThat(consumer.pushReason()).isEqualTo("publish_failed");
        assertThat(consumer.message()).contains("fehlgeschlagen").doesNotContain("übernimmt wieder");
        var battery = batteryService(provider(null)).clearBattery(site, "actor");
        assertThat(battery.pushed()).isFalse(); assertThat(battery.pushReason()).isEqualTo("publisher_unavailable");
        assertThat(battery.message()).contains("nicht verfügbar").doesNotContain("übernehmen wieder");
    }

    @Test void namedDisabledControlAndNoMutationWhenOwnerUnknown() {
        world("pending");
        when(activation.activationAvailable()).thenReturn(false);
        var result = consumerService().start(site, entity, new ConsumerOverrideService.OverrideRequest("start", 10, null, null), "actor");
        assertThat(result.pushed()).isFalse(); assertThat(result.pushReason()).isEqualTo("control_disabled");
        reset(consumerOverrides);
        when(activation.activationAvailable()).thenReturn(true);
        when(transfers.stand(source)).thenReturn(new UebergabeRepository.Stand(source, site, assignment, a, b, "removing", now, now, null, null));
        assertThatThrownBy(() -> consumerService().clear(site, entity, "actor")).isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(consumerOverrides, overridesPublisher);
    }

    @Test void missingAndForeignComponentsNeverFallBackToLead() {
        assertThatThrownBy(() -> target.pruefung(site, a, UUID.randomUUID())).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        world("pending");
        when(devices.findById(a)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> target.komponente(site, entity)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(409));
    }
    @Test void initialAssignmentNeedsNoHandoverButPastChangesNeedExecutionEvidence() {
        world("assigned");
        when(transfers.stand(source)).thenReturn(null);
        assertThat(target.komponente(site, entity, now).id()).isEqualTo(b);
        when(entities.zustaendigkeitenDerQuellen(site)).thenReturn(List.of(
                new Zeitraum(UUID.randomUUID(), source, a, now.minusSeconds(120), now),
                new Zeitraum(assignment, source, b, now, null)));
        assertThat(target.komponente(site, entity, now.minusNanos(1)).id()).isEqualTo(a);
        assertThatThrownBy(() -> target.komponente(site, entity, now)).isInstanceOf(ResponseStatusException.class);
    }

    @Test void sentReceivingUsesNewBoxAndNoLeaderIsNamed() {
        world("pending");
        when(transfers.stand(source)).thenReturn(new UebergabeRepository.Stand(source, site, assignment,
                a, b, "receiving", now, now, "uems-registry:4", null));
        assertThat(target.komponente(site, entity).id()).isEqualTo(b);
        when(lead.fuehrendeBox(site)).thenReturn(new LeadDeviceService.FuehrendeBox(null, Grund.KEINE_WAHL));
        assertThatThrownBy(() -> target.pruefung(site, null, null)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getReason()).contains("keine führende Box"));
        assertThat(target.pruefung(site, b, null).id()).isEqualTo(b);
    }

    @Test void retainedMeasurementPlanCannotReenableSourceOnFormerBox() {
        world("assigned");
        MeasurementSelectionRepository repo = mock(MeasurementSelectionRepository.class);
        when(repo.aktiverDeviceScope(a)).thenReturn(new MeasurementSelectionRepository.DeviceScope(tenant, site, a));
        when(repo.current(a)).thenReturn(List.of(new MeasurementSelectionRepository.Row(tenant, site, a, entity,
                "test.point", true, 60, 1, now, null, "test", "actor", "Actor", now,
                "pending_edge", null, null, null, "thermal_bms", 90, 900, "fifteen_minute")));
        var svc = new MeasurementSelectionService(repo, mock(MeasurementCatalog.class), new ObjectMapper(),
                new MeasurementBudgetProperties(Map.of()), target);
        assertThat(svc.state(a).selections()).hasSize(1); // history/desired row retained
        assertThat(svc.forPublishing(a).selections()).isEmpty(); // cannot go back on the wire
        world("pending");
        assertThat(svc.forPublishing(a).selections()).hasSize(1); // old reader still executes
    }

    @Test void identicalLanAddressHonorsExplicitBoxOrLeadingBoxWithoutMergingTargets() throws Exception {
        world("lead");
        var targets = mock(RegisterWriteTargets.class);
        when(targets.forSite(site)).thenReturn(List.of(
                new RegisterWriteTargets.Target("entity", a, entity, "A", null, null, null,
                        "modbus_tcp", "192.168.1.4", 502, 1, true, null),
                new RegisterWriteTargets.Target("lan", b, null, "B", null, null, null,
                        "modbus_tcp", "192.168.1.4", 502, 1, true, null)));
        var knowledge = mock(RegisterKnowledge.class);
        when(knowledge.of(any(), anyInt())).thenReturn(new RegisterKnowledge.Known(null, "unknown", null, null, null));
        var registry = mock(RegisterWriteRegistry.class);
        when(registry.await(any(), any())).thenReturn(RegisterWriteResult.silent("id", "read", "timeout"));
        var pub = mock(RegisterWritePublisher.class);
        var service = new RegisterWriteService(devices, knowledge, targets, registry,
                mock(RegisterWriteEventRepository.class), provider(pub), Duration.ofSeconds(40), Duration.ofSeconds(60), true, target);
        for (UUID requested : Arrays.asList(a, b, null)) {
            service.preview(site, new RegisterWriteService.Command(requested, "lan", null,
                    "192.168.1.4", 502, 1, "holding", "100", null, null, null, null),
                    new RegisterWriteService.Actor("actor", "Actor", false));
        }
        verify(pub, times(2)).publish(eq(tenant), eq(site), eq(a), anyString(), any(), any(), any());
        verify(pub).publish(eq(tenant), eq(site), eq(b), anyString(), any(), any(), any());
    }

}
