package com.voltpilot.api.probe;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EinmalAuftragZiel;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * {@link ProbeService#testConnection}: der Portal-Test wartet so lange, wie die Box für einen
 * Verbindungstest brauchen darf.
 *
 * <p>Live-Fall VoltPilotGATE (31.10.2026): ein Shelly Pro 3 im schwachen WLAN brauchte 1,5 bis
 * 3,5 s je Anfrage, der Test der Box lief 0,6 bis 7,2 s und BESTAND - das Portal zeigte trotzdem
 * „Ihre VoltPilot-Box hat nicht rechtzeitig geantwortet", weil es nach 5 s nicht mehr zuhörte und
 * die Antwort verwarf.
 */
class ProbeServiceTestConnectionTest {

    private static final UUID MANDANT = UUID.fromString("0a000000-0000-0000-0000-000000000001");
    private static final UUID ANLAGE = UUID.fromString("0a000000-0000-0000-0000-0000000000a1");
    private static final UUID BOX = UUID.fromString("0a000000-0000-0000-0000-0000000000e1");

    private final ProbeRegistry registry = new ProbeRegistry();
    private final ProbePublisher publisher = mock(ProbePublisher.class);
    @SuppressWarnings("unchecked")
    private final ObjectProvider<ProbePublisher> provider = mock(ObjectProvider.class);
    private final EinmalAuftragZiel ziel = mock(EinmalAuftragZiel.class);
    private final ProbeService service =
            new ProbeService(mock(DeviceRepository.class), registry, provider, ziel);

    @BeforeEach
    void mandant() {
        TenantContext.set(MANDANT);
        when(provider.getIfAvailable()).thenReturn(publisher);
        when(ziel.pruefung(ANLAGE, null, null)).thenReturn(new DeviceDto(BOX, ANLAGE, "edge-h5atkys",
                "gateway", "VoltPilotGATE", "claimed", null, Instant.parse("2026-10-31T09:35:00Z")));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    @Test
    void eineAntwortNachFuenfSekundenErreichtDenKunden() throws Exception {
        ProbeResult bestanden = new ProbeResult(null, null, null, List.of(new ProbeResult.OpResult(
                "verbindung", true, null, null, null, null, null)));
        // Die Box antwortet nach 5,5 s - so wie der Test am Shelly Pro 3 in drei von acht Läufen.
        doAnswer(inv -> {
            String requestId = inv.getArgument(3);
            CompletableFuture.runAsync(() -> registry.complete(BOX, requestId, bestanden),
                    CompletableFuture.delayedExecutor(5_500, TimeUnit.MILLISECONDS));
            return null;
        }).when(publisher).publishTest(eq(MANDANT), eq(ANLAGE), eq(BOX), anyString(), any(),
                eq("sub-kapitaen"), eq("verbindung"), eq("shelly"), eq("shelly_http"), eq("shelly_http"),
                isNull(), any());

        ProbeResult antwort = service.testConnection(ANLAGE, null, "verbindung", "shelly",
                "shelly_http", "shelly_http", null,
                Map.of("ip", "192.168.178.43", "port", 80, "channel", 0), "sub-kapitaen");

        assertThat(antwort).isSameAs(bestanden);
        assertThat(antwort.errorCode()).isNull();
    }

    @Test
    void dieWartezeitDecktDasBudgetDerBoxFuerEinenTest() {
        // testReadTimeout in edge-app/core/internal/agent/agent.go: 10 s je Verbindungstest.
        Duration boxBudget = Duration.ofSeconds(10);
        assertThat(ProbeService.TEST_TIMEOUT).isGreaterThan(boxBudget);
        // Die Registerlesung und der Schalt-Test bleiben bei ihrer kurzen Wartezeit.
        assertThat(ProbeService.TIMEOUT).isEqualTo(Duration.ofSeconds(5));
    }
}
