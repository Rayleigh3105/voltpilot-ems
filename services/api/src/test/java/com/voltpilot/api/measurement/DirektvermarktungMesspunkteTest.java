package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EinmalAuftragZiel;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.Row;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Die dv.*-Punkte der Direktvermarktungs-Zustellung im Messplan (Vertrag
 * direktvermarktung-zustellung.md §5): Box-Zeilen ohne Komponente, ohne Katalogeintrag, idempotent - eine
 * Abwahl von Hand bleibt stehen, abgewählt wird nur die eigene Zeile dieses Akteurs.
 */
class DirektvermarktungMesspunkteTest {

    private static final UUID BOX = UUID.fromString("00000000-0000-0000-0000-00000000000c");

    private MeasurementSelectionRepository repository;
    private MeasurementCatalog catalog;
    private MeasurementSelectionService service;
    private DeviceScope scope;

    @BeforeEach
    void setUp() {
        repository = mock(MeasurementSelectionRepository.class);
        catalog = mock(MeasurementCatalog.class);
        when(catalog.version()).thenReturn("2026.10.26.1");
        service = new MeasurementSelectionService(repository, catalog, new ObjectMapper(),
                new MeasurementBudgetProperties(null), mock(EinmalAuftragZiel.class));
        scope = new DeviceScope(UUID.randomUUID(), UUID.randomUUID(), BOX);
        when(repository.lockDevice(BOX)).thenReturn(scope);
        when(repository.revision(BOX)).thenReturn(5L);
        when(repository.save(any(), any(), anyString(), anyBoolean(), anyInt(), anyLong(), anyString(),
                anyString(), anyString(), anyString(), any(), any()))
                .thenAnswer(inv -> row(inv.getArgument(2), inv.getArgument(3), "system:direktvermarktung-zustellung"));
    }

    private static Row row(String pointKey, boolean enabled, String akteur) {
        return new Row(UUID.randomUUID(), UUID.randomUUID(), BOX, null, pointKey, enabled, 60, 6,
                enabled ? Instant.now() : null, enabled ? null : Instant.now(), "2026.10.26.1", akteur,
                "VoltPilot", Instant.now(), "pending_edge", null, null, null, "state_event", 90, null,
                "event_history");
    }

    @Test
    void auswaehlenLegtGenauDieVierPunkteAlsBoxZeilenAn() {
        when(repository.current(BOX)).thenReturn(List.of());
        service.direktvermarktungsPunkte(BOX, true);

        ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<UUID> entity = ArgumentCaptor.forClass(UUID.class);
        ArgumentCaptor<MeasurementRetention> retention = ArgumentCaptor.forClass(MeasurementRetention.class);
        verify(repository, org.mockito.Mockito.times(4)).save(eq(scope), entity.capture(), keys.capture(),
                eq(true), eq(60), anyLong(), eq("2026.10.26.1"), eq("system:direktvermarktung-zustellung"),
                anyString(), anyString(), eq(null), retention.capture());
        assertThat(keys.getAllValues()).containsExactlyElementsOf(
                MeasurementSelectionService.DIREKTVERMARKTUNG_PUNKTE);
        assertThat(entity.getAllValues()).containsOnlyNulls();
        assertThat(retention.getAllValues()).extracting(MeasurementRetention::retentionClass)
                .containsExactly("state_event", "live_power", "state_event", "unclassified");
    }

    @Test
    void eineVorhandeneZeileBleibtStehen() {
        when(repository.current(BOX)).thenReturn(List.of(row("dv.vorgabe_pct", false, "kunde")));
        service.direktvermarktungsPunkte(BOX, true);
        // Die Hand-Abwahl von dv.vorgabe_pct bleibt; die drei übrigen kommen dazu.
        verify(repository, org.mockito.Mockito.times(3)).save(any(), any(), anyString(), eq(true), anyInt(),
                anyLong(), anyString(), anyString(), anyString(), anyString(), any(), any());
        verify(repository, never()).save(any(), any(), eq("dv.vorgabe_pct"), anyBoolean(), anyInt(),
                anyLong(), anyString(), anyString(), anyString(), anyString(), any(), any());
    }

    @Test
    void abwaehlenNimmtNurEigeneEingeschalteteZeilen() {
        when(repository.current(BOX)).thenReturn(List.of(
                row("dv.vorgabe_pct", true, "system:direktvermarktung-zustellung"),
                row("dv.grenze_kw", true, "kunde"),
                row("dv.verbunden", false, "system:direktvermarktung-zustellung")));
        service.direktvermarktungsPunkte(BOX, false);
        verify(repository).save(eq(scope), eq(null), eq("dv.vorgabe_pct"), eq(false), anyInt(), anyLong(),
                anyString(), anyString(), anyString(), anyString(), any(), any());
        verify(repository, never()).save(any(), any(), eq("dv.grenze_kw"), anyBoolean(), anyInt(), anyLong(),
                anyString(), anyString(), anyString(), anyString(), any(), any());
        verify(repository, never()).save(any(), any(), eq("dv.verbunden"), anyBoolean(), anyInt(), anyLong(),
                anyString(), anyString(), anyString(), anyString(), any(), any());
    }

    @Test
    void ohneBoxPassiertNichts() {
        when(repository.lockDevice(BOX)).thenReturn(null);
        service.direktvermarktungsPunkte(BOX, true);
        verify(repository, never()).save(any(), any(), anyString(), anyBoolean(), anyInt(), anyLong(),
                anyString(), anyString(), anyString(), anyString(), any(), any());
    }
}
