package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EinmalAuftragZiel;
import com.voltpilot.api.repo.ConsumerOverrideRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/**
 * Der Handeingriff trägt seine Schaltspur (vp-schalten-3s): die Spur entsteht VOR dem Senden, ihre request_id reist
 * im Umschlag zur Box, „gesendet“ folgt dem Ergebnis des Sendens, und die Antwort nennt die Spur fürs Portal.
 */
class SchaltSpurHandeingriffTest {

    private final UUID tenant = UUID.randomUUID();
    private final UUID site = UUID.randomUUID();
    private final UUID stab = UUID.randomUUID();
    private final UUID box = UUID.randomUUID();

    private final ConsumerRepository consumers = mock(ConsumerRepository.class);
    private final ConsumerPolicyActivationService activation = mock(ConsumerPolicyActivationService.class);
    private final ConsumerOverridePublisher publisher = mock(ConsumerOverridePublisher.class);
    private final EinmalAuftragZiel ziel = mock(EinmalAuftragZiel.class);
    private final HeizstabGeraet heizstab = mock(HeizstabGeraet.class);
    private final SchaltSpur spur = mock(SchaltSpur.class);
    private final SchaltSpur.Neu neu = new SchaltSpur.Neu(UUID.randomUUID(), "override:x:y");
    private ConsumerOverrideService service;

    @BeforeEach
    void setup() {
        TenantContext.set(tenant);
        ConsumerRepository.ConsumerRow row = mock(ConsumerRepository.ConsumerRow.class);
        when(row.controlKind()).thenReturn("stepped");
        when(row.levelsKwJson()).thenReturn("[0, 1.5, 3.0, 4.5]");
        when(row.deviceId()).thenReturn(box);
        when(consumers.findForSite(site, stab)).thenReturn(row);
        when(activation.activationAvailable()).thenReturn(true);
        DeviceDto dto = mock(DeviceDto.class);
        when(dto.id()).thenReturn(box);
        when(ziel.komponente(site, stab)).thenReturn(dto);
        when(heizstab.menge(site, stab)).thenReturn(HeizstabPhasenTest.pro3());
        when(heizstab.phasenEinzeln(box)).thenReturn(true);
        when(spur.beginnen(any(), any(), any(), any(), any(), any(), any())).thenReturn(neu);
        @SuppressWarnings("unchecked")
        ObjectProvider<ConsumerOverridePublisher> p = mock(ObjectProvider.class);
        when(p.getIfAvailable()).thenReturn(publisher);
        service = new ConsumerOverrideService(consumers, mock(ConsumerOverrideRepository.class),
                mock(ConsumerAuditRepository.class), activation, p, ziel);
        service.heizstab(heizstab);
        service.schaltSpur(spur);
    }

    @AfterEach
    void clear() {
        TenantContext.clear();
    }

    @Test
    void diePhasenWahlReistMitDerRequestIdIhrerSpur() {
        when(publisher.publishPhasenOverride(any(), any(), any(), any(), any(), any(), anyInt(), any(), any()))
                .thenReturn(true);

        var out = service.start(site, stab, new ConsumerOverrideService.OverrideRequest("start", 120, null, null,
                null, List.of(1)), "kunde");

        assertThat(out.spur()).isEqualTo(neu.id());
        var reihenfolge = inOrder(spur, publisher);
        reihenfolge.verify(spur).beginnen(eq(site), eq(stab), eq("start"), eq("setpoint_kw"),
                eq(new BigDecimal("2.000")), eq(List.of(1)), any());
        reihenfolge.verify(publisher).publishPhasenOverride(eq(tenant), eq(site), eq(box), eq(stab),
                eq(new BigDecimal("2.000")), eq(List.of(1)), anyInt(), any(), eq("override:x:y"));
        reihenfolge.verify(spur).gesendet(eq(neu), eq(box), any(), eq(true), isNull());
    }

    @Test
    void ausTraegtDieSpurUndEinFehlschlagSagtWarum() {
        when(publisher.publishOverride(any(), any(), any(), any(), any(), any(), anyInt(), any(), any()))
                .thenReturn(false);

        var out = service.start(site, stab, new ConsumerOverrideService.OverrideRequest("stop", 120, null, null),
                "kunde");

        assertThat(out.pushed()).isFalse();
        assertThat(out.spur()).isEqualTo(neu.id());
        verify(spur).beginnen(eq(site), eq(stab), eq("stop"), eq("setpoint_kw"), eq(BigDecimal.ZERO), isNull(), any());
        verify(spur).gesendet(eq(neu), eq(box), any(), eq(false), eq("publish_failed"));
        verify(publisher, never()).publishOverride(any(), any(), any(), any(), any(), any(), anyInt(), any());
    }

    @Test
    void automatikFortsetzenTraegtDieSpurImRuecknahmeUmschlag() {
        when(publisher.publishWithdraw(any(), any(), any(), any(), any())).thenReturn(true);

        var out = service.clear(site, stab, "kunde");

        assertThat(out.spur()).isEqualTo(neu.id());
        verify(spur).beginnen(eq(site), eq(stab), eq("zurueck"), isNull(), isNull(), isNull(), any());
        verify(publisher).publishWithdraw(tenant, site, box, stab, "override:x:y");
        verify(spur).gesendet(eq(neu), eq(box), any(), eq(true), isNull());
    }

    @Test
    void ohneSpurBleibtDerUmschlagWieVorher() {
        when(spur.beginnen(any(), any(), any(), any(), any(), any(), any())).thenReturn(null);
        when(publisher.publishPhasenOverride(any(), any(), any(), any(), any(), any(), anyInt(), any()))
                .thenReturn(true);

        var out = service.start(site, stab, new ConsumerOverrideService.OverrideRequest("start", 120, null, null,
                null, List.of(1)), "kunde");

        assertThat(out.pushed()).isTrue();
        assertThat(out.spur()).isNull();
        verify(publisher).publishPhasenOverride(eq(tenant), eq(site), eq(box), eq(stab), any(), eq(List.of(1)),
                anyInt(), any());
    }
}
