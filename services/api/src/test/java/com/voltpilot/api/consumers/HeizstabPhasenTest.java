package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EinmalAuftragZiel;
import com.voltpilot.api.repo.ConsumerOverrideRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.server.ResponseStatusException;

/**
 * Handeingriff je Phase am Heizstab (heizstab-shelly.md „Handeingriff je Phase“, Entscheide D1-A und
 * D3-A vom 05.11.2026): die Wahl ist die Stufe, der Sollwert die kW dieser Stufe, die gewählten
 * Ausgänge gehen nur an eine Box mit {@code heizstab_phasen}, und ohne eigene Dauer kehrt der Stab
 * nach zwei Stunden zu Smart zurück.
 */
class HeizstabPhasenTest {

    private final UUID tenant = UUID.randomUUID();
    private final UUID site = UUID.randomUUID();
    private final UUID stab = UUID.randomUUID();
    private final UUID box = UUID.randomUUID();

    private final ConsumerRepository consumers = mock(ConsumerRepository.class);
    private final ConsumerOverrideRepository overrides = mock(ConsumerOverrideRepository.class);
    private final ConsumerAuditRepository audit = mock(ConsumerAuditRepository.class);
    private final ConsumerPolicyActivationService activation = mock(ConsumerPolicyActivationService.class);
    private final ConsumerOverridePublisher publisher = mock(ConsumerOverridePublisher.class);
    private final EinmalAuftragZiel ziel = mock(EinmalAuftragZiel.class);
    private final HeizstabGeraet heizstab = mock(HeizstabGeraet.class);
    private ConsumerOverrideService service;

    /** Der Pro 3 des Captains: drei Phasen, Stern mit N, 2 kW je Element, Stufen 1/2/3. */
    static Map<String, Object> pro3() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.178.43");
        c.put("channels", List.of(0, 1, 2));
        c.put("output_kw", List.of(2.0, 2.0, 2.0));
        c.put("stages", List.of(1, 2, 3));
        c.put("rotation", "daily");
        c.put("anschluss", "stern_mit_n");
        return c;
    }

    @BeforeEach
    void setup() {
        TenantContext.set(tenant);
        ConsumerRepository.ConsumerRow row = mock(ConsumerRepository.ConsumerRow.class);
        when(row.controlKind()).thenReturn("stepped");
        when(row.levelsKwJson()).thenReturn("[0, 2.0, 4.0, 6.0]");
        when(row.deviceId()).thenReturn(box);
        when(consumers.findForSite(site, stab)).thenReturn(row);
        when(activation.activationAvailable()).thenReturn(true);
        DeviceDto dto = mock(DeviceDto.class);
        when(dto.id()).thenReturn(box);
        when(ziel.komponente(site, stab)).thenReturn(dto);
        when(heizstab.menge(site, stab)).thenReturn(pro3());
        when(publisher.publishOverride(any(), any(), any(), any(), any(), any(), anyInt(), any())).thenReturn(true);
        when(publisher.publishPhasenOverride(any(), any(), any(), any(), any(), any(), anyInt(), any()))
                .thenReturn(true);
        @SuppressWarnings("unchecked")
        ObjectProvider<ConsumerOverridePublisher> p = mock(ObjectProvider.class);
        when(p.getIfAvailable()).thenReturn(publisher);
        service = new ConsumerOverrideService(consumers, overrides, audit, activation, p, ziel);
        service.heizstab(heizstab);
    }

    @AfterEach
    void clear() {
        TenantContext.clear();
    }

    private static ConsumerOverrideService.OverrideRequest phasen(Integer minuten, List<Integer> ausgaenge) {
        return new ConsumerOverrideService.OverrideRequest("start", minuten, null, null, null, ausgaenge);
    }

    @Test
    void eineBoxMitHeizstabPhasenBekommtGenauDieGewaehltenAusgaenge() {
        when(heizstab.phasenEinzeln(box)).thenReturn(true);

        var out = service.start(site, stab, phasen(120, List.of(2, 0)), "kunde");

        assertThat(out.pushed()).isTrue();
        assertThat(out.phasenGenau()).isTrue();
        assertThat(out.effectivePowerKw()).isEqualByComparingTo("4.0");
        verify(publisher).publishPhasenOverride(eq(tenant), eq(site), eq(box), eq(stab),
                eq(new BigDecimal("4.000")), eq(List.of(0, 2)), anyInt(), any());
        verify(publisher, never()).publishOverride(any(), any(), any(), any(), any(), any(), anyInt(), any());
        verify(overrides).put(eq(site), eq(stab), eq("start"), eq("setpoint_kw"), eq(new BigDecimal("4.000")),
                eq(List.of(0, 2)), any(), eq("kunde"));
    }

    @Test
    void eineAeltereBoxBekommtDieStufeUndDerKundeErfaehrtEs() {
        when(heizstab.phasenEinzeln(box)).thenReturn(false);

        var out = service.start(site, stab, phasen(120, List.of(1)), "kunde");

        assertThat(out.pushed()).isTrue();
        assertThat(out.phasenGenau()).isFalse();
        assertThat(out.message()).contains("wählt die Phasen noch selbst");
        verify(publisher).publishOverride(eq(tenant), eq(site), eq(box), eq(stab), isNull(),
                eq(new BigDecimal("2.000")), anyInt(), any());
        verify(publisher, never()).publishPhasenOverride(any(), any(), any(), any(), any(), any(), anyInt(), any());
    }

    @Test
    void ohneEigeneDauerKehrtDerStabNachZweiStundenZuSmartZurueck() {
        Instant vorher = Instant.now();

        var an = service.start(site, stab, phasen(null, List.of(0)), "kunde");
        var aus = service.start(site, stab,
                new ConsumerOverrideService.OverrideRequest("stop", null, null, null), "kunde");

        for (var out : List.of(an, aus)) {
            assertThat(out.endsAt()).isBetween(vorher.plus(Duration.ofHours(2)),
                    Instant.now().plus(Duration.ofHours(2)));
            assertThat(out.ttlCapped()).isFalse();
        }
        assertThat(aus.phasenGenau()).as("ohne Phasen-Wahl fehlt das Feld").isNull();
    }

    @Test
    void einVerbraucherOhneAusgangsmengeBrauchtWeiterEineDauer() {
        when(heizstab.menge(site, stab)).thenReturn(null);

        assertThatThrownBy(() -> service.start(site, stab,
                new ConsumerOverrideService.OverrideRequest("start", null, null, null), "kunde"))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("Endzeit oder Dauer");
        assertThatThrownBy(() -> service.start(site, stab, phasen(30, List.of(0)), "kunde"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("nur bei einem Heizstab über mehrere Ausgänge");
    }

    @Test
    void eineFalschePhasenWahlSchreibtNichts() {
        when(heizstab.phasenEinzeln(box)).thenReturn(true);

        assertThatThrownBy(() -> service.start(site, stab, phasen(30, List.of(3)), "kunde"))
                .hasMessageContaining("Ausgang 3 gehört nicht zu diesem Heizstab");
        assertThatThrownBy(() -> service.start(site, stab, phasen(30, List.of()), "kunde"))
                .hasMessageContaining("mindestens eine Phase");
        assertThatThrownBy(() -> service.start(site, stab,
                new ConsumerOverrideService.OverrideRequest("stop", 30, null, null, null, List.of(0)), "kunde"))
                .hasMessageContaining("„Aus“");
        assertThatThrownBy(() -> service.start(site, stab,
                new ConsumerOverrideService.OverrideRequest("start", 30, null, null, 1, List.of(0, 1)), "kunde"))
                .hasMessageContaining("Stufe und Phasen-Wahl passen nicht zusammen");
        verify(overrides, never()).put(any(), any(), any(), any(), any(), any(), any(), any());
        verify(overrides, never()).put(any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void dieRegelDerPhasenWahlIstDieDerBox() {
        Map<String, Object> c = pro3();
        assertThat(HeizstabAusgaenge.phasenFehler(c, List.of(1))).isNull();
        assertThat(HeizstabAusgaenge.phasenFehler(c, List.of(0, 2))).isNull();
        assertThat(HeizstabAusgaenge.phasenFehler(c, List.of(0, 1, 2))).isNull();
        assertThat(HeizstabAusgaenge.phasenFehler(c, List.of(1, 1))).contains("zweimal");
        assertThat(HeizstabAusgaenge.stufeMit(c, 2).kw()).isEqualByComparingTo("4.0");

        Map<String, Object> alleZusammen = pro3();
        alleZusammen.put("stages", List.of(3));
        assertThat(HeizstabAusgaenge.phasenFehler(alleZusammen, List.of(0)))
                .isEqualTo("Dieser Heizstab schaltet nur alle Phasen zusammen.");

        Map<String, Object> einsUndDrei = pro3();
        einsUndDrei.put("stages", List.of(1, 3));
        assertThat(HeizstabAusgaenge.phasenFehler(einsUndDrei, List.of(0, 1)))
                .isEqualTo("2 Phasen zugleich sind bei diesem Heizstab nicht erlaubt (erlaubt: 1, 3).");

        // Ungleiche Elemente: der Sollwert sind die kW der gewählten, nicht der größten (die Stufe).
        Map<String, Object> ungleich = pro3();
        ungleich.put("output_kw", List.of(1.0, 2.0, 3.0));
        assertThat(HeizstabAusgaenge.kwDer(ungleich, List.of(0, 1))).isEqualByComparingTo("3.0");
        assertThat(HeizstabAusgaenge.stufeMit(ungleich, 2).kw()).isEqualByComparingTo("5.0");
    }
}
