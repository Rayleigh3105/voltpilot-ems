package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository.BatteryAsset;
import com.voltpilot.api.entities.EntityRegistryService.BackfillOutcome;
import com.voltpilot.api.entities.EntityRegistryService.ConversionPreview;
import com.voltpilot.api.entities.EntityRegistryService.PushOutcome;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowActivationService.ActivationOutcome;
import com.voltpilot.api.flows.FlowCatalog;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.function.Executable;
import org.springframework.beans.factory.ObjectProvider;

/**
 * DER Beweis der Verhaltensgleichheit von IP-5: für jede Bestandsanlage ist
 * {@code site.lead_device_id} NULL (kein Backfill), und dann bekommen die zwei umgestellten
 * Aufrufer — {@link EntityRegistryService} (Registry-Push, Bootstrap, Vorschau, Übernahme-Frage,
 * Sync-Status) und {@link FlowActivationService} (Aktivieren, Stoppen, Neu-Veröffentlichen) — genau
 * die Box der alten Einzel-Gateway-Weiche, und wo die keine hatte, genau das alte Beobachtbare:
 * kein Push + {@code no_gateway_device}, {@code SKIPPED_NO_GATEWAY},
 * {@code refused(no_gateway_device)}, derselbe Vorschau-Grund.
 *
 * <p>Die alte Weiche steht hier wörtlich als Referenz ({@link #alteWeiche},
 * {@link #alterVorschauGrund}); geprüft wird über alle Welten, die sie unterschied — A12 (eine Box
 * mit Speicher), A9 (zweite Box, der Speicher an der ersten), Speicher ohne Gerät, keine Box,
 * mehrere Boxen, und der Speicher an einer Box AUSSERHALB der Anlage (die Weiche prüfte die
 * Anmeldung nicht, der Dienst auch nicht).
 */
class LeadDeviceBestandVerhaltensgleichTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID FLOW = UUID.fromString("4e1c2b3a-5d6e-4f70-8123-456789abcdef");
    private static final UUID D1 = UUID.fromString("00000000-0000-0000-0000-0000000000d1");
    private static final UUID D2 = UUID.fromString("00000000-0000-0000-0000-0000000000d2");
    private static final UUID DX = UUID.fromString("00000000-0000-0000-0000-0000000000dd");

    /** Eine Bestandsanlage: ihr Speicher (oder keiner) und ihre Boxen, lead_device_id NULL. */
    private record Welt(String name, BatteryAsset speicher, List<UUID> boxen) {}

    private static BatteryAsset speicherAn(UUID geraet) {
        return new BatteryAsset(geraet, BigDecimal.TEN, BigDecimal.TEN, BigDecimal.valueOf(10),
                BigDecimal.valueOf(90));
    }

    private static List<Welt> welten() {
        return List.of(
                new Welt("A12 eine Box, der Speicher daran", speicherAn(D1), List.of(D1)),
                new Welt("A9 zweite Box, der Speicher an der ersten", speicherAn(D1),
                        List.of(D1, D2)),
                new Welt("zwei Boxen, der Speicher an der zweiten", speicherAn(D2),
                        List.of(D1, D2)),
                new Welt("eine Box, Speicher ohne Gerät", speicherAn(null), List.of(D1)),
                new Welt("eine Box, kein Speicher", null, List.of(D1)),
                new Welt("zwei Boxen, Speicher ohne Gerät", speicherAn(null), List.of(D1, D2)),
                new Welt("zwei Boxen, kein Speicher", null, List.of(D1, D2)),
                new Welt("keine Box, kein Speicher", null, List.of()),
                new Welt("keine Box, Speicher ohne Gerät", speicherAn(null), List.of()),
                new Welt("Speicher an einer Box außerhalb der Anlage", speicherAn(DX), List.of(D1)),
                new Welt("Speicher an einer Box, die Anlage ohne Box", speicherAn(DX), List.of()));
    }

    /** Die Weiche wörtlich, wie {@code EntityRegistryService.gatewayDevice} bis IP-5 stand. */
    private static UUID alteWeiche(Welt w) {
        if (w.speicher() != null && w.speicher().deviceId() != null) {
            return w.speicher().deviceId();
        }
        List<UUID> devices = w.boxen();
        return devices.size() == 1 ? devices.get(0) : null;
    }

    /** Der Vorschau-Grund wörtlich, wie ihn {@code EntityRegistryService.gatewayReason} gab. */
    private static String alterVorschauGrund(Welt w) {
        int devices = w.boxen().size();
        if (devices == 0) {
            return "no_claimed_device";
        }
        if (w.speicher() == null || w.speicher().deviceId() == null) {
            return "multiple_devices_no_battery_link";
        }
        return "no_gateway_device";
    }

    // ------------------------------------------------------------------ Aufbau

    /** Frische Mocks je Prüfung: das Repository der Welt, zwei Broker, die zwei echten Dienste. */
    private static final class Aufbau {
        final EntityRegistryRepository repo = mock(EntityRegistryRepository.class);
        final EntityRegistryPublisher registryBroker = mock(EntityRegistryPublisher.class);
        final FlowDeploymentPublisher flowBroker = mock(FlowDeploymentPublisher.class);
        final FlowRepository flows = mock(FlowRepository.class);
        final EntityRegistryService registry;
        final FlowActivationService flowService;

        Aufbau(Welt w) throws Exception {
            when(repo.batteryAsset(SITE)).thenReturn(w.speicher());
            when(repo.siteDeviceIds(SITE)).thenReturn(w.boxen());
            // storedLeadDeviceId bleibt ungestubbt: NULL, der Stand jeder Bestandsanlage.
            when(registryBroker.publishRegistry(any(), any(), any(), any())).thenReturn(true);
            when(flowBroker.publishDeployment(any(), any(), any(), any())).thenReturn(true);
            LeadDeviceService lead = new LeadDeviceService(repo);
            registry = new EntityRegistryService(repo, provider(registryBroker), MAPPER,
                    mock(EntityTypeCatalog.class), mock(AssetRepository.class),
                    mock(FlowClaimRepository.class), mock(DeviceOverrideRepository.class), lead);
            JsonNode artifact = MAPPER.readTree(Files.readString(Path.of("..", "..", "docs",
                    "contracts", "v2", "examples", "flow-artifact.valid.artifact.json")));
            flowService = new FlowActivationService(flows, lead, mock(FlowClaimRepository.class),
                    new FlowCatalog(MAPPER), provider((EntityRegistryService) null),
                    provider((FlowCompiler) doc -> artifact), provider(flowBroker), MAPPER, true);
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(value);
        return provider;
    }

    private static FlowVersionRow row(String lifecycle) {
        return new FlowVersionRow(FLOW, 2, SITE, "Marktoptimierung", "edge", lifecycle, "{}", null,
                null, Instant.now(), Instant.now(), null, null);
    }

    private static List<DynamicTest> jeWelt(String was, WeltPruefung pruefung) {
        List<DynamicTest> tests = new ArrayList<>();
        for (Welt w : welten()) {
            Executable ausfuehren = () -> {
                TenantContext.set(TENANT);
                try {
                    pruefung.pruefe(w, alteWeiche(w));
                } finally {
                    TenantContext.clear();
                }
            };
            tests.add(DynamicTest.dynamicTest(was + ": " + w.name(), ausfuehren));
        }
        return tests;
    }

    @FunctionalInterface
    private interface WeltPruefung {
        void pruefe(Welt w, UUID alteBox) throws Exception;
    }

    // ------------------------------------------------------- Registry-Push

    @TestFactory
    List<DynamicTest> derRegistryPushGehtAnDieBoxDerAltenWeiche() {
        return jeWelt("Registry-Push", (w, alt) -> {
            Aufbau a = new Aufbau(w);
            PushOutcome push = a.registry.pushRegistryBestEffort(SITE);
            if (alt == null) {
                assertThat(push)
                        .isEqualTo(new PushOutcome(false, false, "no_gateway_device", null));
                verify(a.registryBroker, never()).publishRegistry(any(), any(), any(), any());
                verify(a.repo, never()).upsertRegistryState(any(), any(), any(), any());
            } else {
                assertThat(push).isEqualTo(new PushOutcome(true, true, null, alt));
                verify(a.registryBroker).publishRegistry(eq(TENANT), eq(SITE), eq(alt), any());
                verify(a.repo).upsertRegistryState(eq(SITE), eq(TENANT), eq(alt), anyString());
            }
        });
    }

    @TestFactory
    List<DynamicTest> dieUebernahmeFrageUndDerSyncStatusSehenDieselbeBox() {
        return jeWelt("gatewayDeviceFor/gatewayAmbiguous", (w, alt) -> {
            Aufbau a = new Aufbau(w);
            assertThat(a.registry.gatewayDeviceFor(SITE)).isEqualTo(alt);
            assertThat(a.registry.gatewayAmbiguous(SITE))
                    .isEqualTo(alt == null && !w.boxen().isEmpty());
        });
    }

    @TestFactory
    List<DynamicTest> dieVorschauNenntDieselbeBoxUndDenselbenGrund() {
        return jeWelt("Vorschau", (w, alt) -> {
            ConversionPreview preview = new Aufbau(w).registry.preview(SITE);
            assertThat(preview.gatewayDevice()).isEqualTo(alt);
            assertThat(preview.gatewayReason())
                    .isEqualTo(alt == null ? alterVorschauGrund(w) : null);
        });
    }

    @TestFactory
    List<DynamicTest> derBootstrapKomponiertAufDerBoxDerAltenWeiche() {
        return jeWelt("Bootstrap", (w, alt) -> {
            Aufbau a = new Aufbau(w);
            BackfillOutcome outcome = a.registry.bootstrapIfEligible(SITE);
            if (alt == null) {
                assertThat(outcome).isEqualTo(BackfillOutcome.SKIPPED_NO_GATEWAY);
                verify(a.repo, never()).createComposedPoint(any(), any(), any(), any(), any());
                verify(a.repo, never()).createBatteryHybridPoint(any(), any(), any(), any());
                return;
            }
            assertThat(outcome).isEqualTo(BackfillOutcome.MIGRATED);
            verify(a.repo).createComposedPoint(TENANT, SITE, EntityRegistryService.ROLE_GRID_METER,
                    null, alt);
            verify(a.repo).createComposedPoint(TENANT, SITE, EntityRegistryService.ROLE_HOUSE_LOAD,
                    null, alt);
            if (w.speicher() != null) {
                verify(a.repo).createBatteryHybridPoint(TENANT, SITE, null, alt);
            }
            verify(a.registryBroker).publishRegistry(eq(TENANT), eq(SITE), eq(alt), any());
        });
    }

    // ------------------------------------------------------ Flow-Aktivierung

    @TestFactory
    List<DynamicTest> dieFlowAktivierungGehtAnDieBoxDerAltenWeiche() {
        return jeWelt("Flow aktivieren", (w, alt) -> {
            Aufbau a = new Aufbau(w);
            ActivationOutcome outcome = a.flowService.activate(SITE, row("simulated"),
                    MAPPER.createObjectNode());
            if (alt == null) {
                assertThat(outcome.activated()).isFalse();
                assertThat(outcome.reason()).isEqualTo("no_gateway_device");
                assertThat(outcome.deviceId()).isNull();
                verify(a.flows, never()).markActive(any(), anyInt(), anyString());
                verify(a.flowBroker, never()).publishDeployment(any(), any(), any(), any());
            } else {
                assertThat(outcome.activated()).isTrue();
                assertThat(outcome.published()).isTrue();
                assertThat(outcome.deviceId()).isEqualTo(alt);
                verify(a.flowBroker).publishDeployment(eq(TENANT), eq(SITE), eq(alt), any());
            }
        });
    }

    @TestFactory
    List<DynamicTest> stoppenUndNeuVeroeffentlichenGehenAnDieBoxDerAltenWeiche() {
        return jeWelt("Flow stoppen/neu veröffentlichen", (w, alt) -> {
            Aufbau stoppen = new Aufbau(w);
            assertThat(stoppen.flowService.deactivate(SITE, FLOW, row("active")).published())
                    .isEqualTo(alt != null);
            verify(stoppen.flows).retireActive(FLOW);

            Aufbau neu = new Aufbau(w);
            assertThat(neu.flowService.republishForSite(SITE)).isEqualTo(alt != null);
            assertThat(neu.flowService.hasGatewayDevice(SITE)).isEqualTo(alt != null);
            for (Aufbau a : List.of(stoppen, neu)) {
                if (alt == null) {
                    verify(a.flowBroker, never()).publishDeployment(any(), any(), any(), any());
                } else {
                    verify(a.flowBroker).publishDeployment(eq(TENANT), eq(SITE), eq(alt), any());
                }
            }
        });
    }
}
