package com.voltpilot.api.probe;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * {@link ProbeService#probeBox}: die Erreichbarkeitsprüfung einer Datenquelle geht an GENAU die
 * genannte Box (UEMS AP-06 IP-3, E11) — auf deren EIGENEM Topic, also unter ihrer Heimat-Anlage,
 * auch wenn die Quelle einer anderen Anlage gehört; ohne die Einzel-Gateway-Weiche der übrigen
 * Wege, die unverändert bleiben.
 */
class ProbeServiceBoxTest {

    private static final UUID MANDANT = UUID.fromString("0a000000-0000-0000-0000-000000000001");
    /** Box Halle 2 (neu), Heimat AN-2 — sie soll DQ-3 aus AN-1 prüfen (A3/A11). */
    private static final UUID BOX = UUID.fromString("0a000000-0000-0000-0000-0000000000e2");
    private static final UUID HEIMAT = UUID.fromString("0a000000-0000-0000-0000-0000000000a2");

    private final DeviceRepository devices = mock(DeviceRepository.class);
    private final ProbeRegistry registry = new ProbeRegistry();
    private final ProbePublisher publisher = mock(ProbePublisher.class);
    @SuppressWarnings("unchecked")
    private final ObjectProvider<ProbePublisher> provider = mock(ObjectProvider.class);
    private final ProbeService service = new ProbeService(devices, registry, provider);

    private static final ProbeRequest.Op SCHRITT = new ProbeRequest.Op("erreichbarkeit", "192.168.10.31",
            502, 1, "holding", 0, "u16", null, null, null);

    @BeforeEach
    void mandant() {
        TenantContext.set(MANDANT);
        when(provider.getIfAvailable()).thenReturn(publisher);
        when(devices.findById(BOX)).thenReturn(Optional.of(new DeviceDto(BOX, HEIMAT, "VP-BOX-2027-0090",
                "gateway", "Box Halle 2 (neu)", "claimed", null, Instant.parse("2026-11-04T08:38:00Z"))));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    @Test
    void fragtGenauDieGenannteBoxAufIhremEigenenTopicUndGibtIhreAntwortZurueck() throws Exception {
        ProbeResult antwort = new ProbeResult(null, null, null, List.of(new ProbeResult.OpResult(
                "erreichbarkeit", true, 1.0, List.of(1), 1.0, null, null)));
        doAnswer(inv -> {
            registry.complete(BOX, inv.getArgument(3), antwort);
            return null;
        }).when(publisher).publish(eq(MANDANT), eq(HEIMAT), eq(BOX), anyString(), any(), eq("sub-jonas"),
                eq(List.of(SCHRITT)));

        assertThat(service.probeBox(BOX, List.of(SCHRITT), "sub-jonas")).contains(antwort);

        // Heimat-Anlage der BOX im Topic — nie die Anlage der Quelle, nie eine geratene Box.
        verify(publisher).publish(eq(MANDANT), eq(HEIMAT), eq(BOX), anyString(), any(), eq("sub-jonas"),
                eq(List.of(SCHRITT)));
        verify(devices, never()).findAll();
    }

    @Test
    void eineAntwortEinerAnderenBoxZaehltNicht() throws Exception {
        UUID andere = UUID.randomUUID();
        doAnswer(inv -> {
            registry.complete(andere, inv.getArgument(3), new ProbeResult(null, null, null, List.of()));
            return null;
        }).when(publisher).publish(any(), any(), any(), anyString(), any(), any(), anyList());

        long start = System.nanoTime();
        assertThat(service.probeBox(BOX, List.of(SCHRITT), "sub-jonas"))
                .as("die Box hat nicht geantwortet — die fremde Antwort wird nie ihre").isEmpty();
        assertThat((System.nanoTime() - start) / 1_000_000).isGreaterThanOrEqualTo(4_000);
    }

    @Test
    void eineBoxAusserhalbDesZaunsIst404UndNichtsGehtRaus() throws Exception {
        UUID fremd = UUID.randomUUID();
        when(devices.findById(fremd)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.probeBox(fremd, List.of(SCHRITT), "sub-jonas"))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        verify(publisher, never()).publish(any(), any(), any(), anyString(), any(), any(), anyList());
    }

    @Test
    void ohneMandantIst404() {
        TenantContext.clear();
        assertThatThrownBy(() -> service.probeBox(BOX, List.of(SCHRITT), "sub-jonas"))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    void kannDieFrageNichtRausIst503() throws Exception {
        doAnswer(inv -> {
            throw new IllegalStateException("Broker weg");
        }).when(publisher).publish(any(), any(), any(), anyString(), any(), any(), anyList());

        assertThatThrownBy(() -> service.probeBox(BOX, List.of(SCHRITT), "sub-jonas"))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
    }
}
