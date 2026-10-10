package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EntityRegistryService;
import java.sql.ResultSet;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

/**
 * Der Outbox-Takt markiert einen Eintrag nach dem Push als erledigt - und muss
 * dabei Parameter binden, die der Postgres-Treiber auch KENNT.
 *
 * <p>Befund (Produktion, 24.09.2026): {@code java.time.Instant} als Parameter
 * scheitert im pgJDBC mit „Can't infer the SQL type"; der Eintrag blieb
 * 'pending', wurde alle 2 s erneut gepusht, und 20 solcher Einträge liessen
 * über das {@code LIMIT 20} jede neuere Aktivierung verhungern (eine neu
 * angelegte Komponente erreichte ihre Box nie). Ohne Docker prüfbar: die Frage
 * ist allein, WELCHE Java-Typen gebunden werden.
 */
class ComponentActivationOutboxBindingTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-0000000000b1");

    private final JdbcTemplate admin = mock(JdbcTemplate.class);
    private final EntityRegistryService registry = mock(EntityRegistryService.class);
    private final ComponentActivationOutboxService outbox =
            new ComponentActivationOutboxService(admin, mock(JdbcTemplate.class), registry);

    private void onePendingRow() throws Exception {
        ResultSet rs = mock(ResultSet.class);
        when(rs.getLong("id")).thenReturn(42L);
        when(rs.getObject("tenant_id", UUID.class)).thenReturn(TENANT);
        when(rs.getObject("site_id", UUID.class)).thenReturn(SITE);
        doAnswer(inv -> {
            ((RowCallbackHandler) inv.getArgument(1)).processRow(rs);
            return null;
        // Seit AP-20 (#1273) trägt die Abfrage die beendeten Kundenbereiche als Parameter.
        }).when(admin).query(anyString(), any(RowCallbackHandler.class), any(Object[].class));
    }

    private Object[] updateArgs() {
        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(admin).update(anyString(), args.capture());
        return args.getValue();
    }

    private static void assertDriverBindable(Object[] args) {
        for (Object a : args) {
            if (a == null) {
                continue; // a NULL (e.g. no last_error) binds fine
            }
            assertThat(a).as("pgJDBC kann java.time.Instant nicht binden")
                    .isNotInstanceOf(java.time.Instant.class);
        }
    }

    @Test
    void aPublishedPushIsMarkedAppliedWithBindableTimestamps() throws Exception {
        onePendingRow();
        when(registry.pushRegistryBestEffort(SITE)).thenReturn(
                new EntityRegistryService.PushOutcome(true, true, null, UUID.randomUUID()));

        outbox.retryPending();

        Object[] args = updateArgs();
        assertThat(args[0]).isEqualTo("applied");
        assertThat(args[2]).isInstanceOf(java.sql.Timestamp.class);
        assertThat(args[4]).isInstanceOf(java.sql.Timestamp.class);
        assertThat(args[5]).isEqualTo(42L);
        assertDriverBindable(args);
    }

    @Test
    void aFailingPushRecordsItsErrorWithBindableTimestamps() throws Exception {
        onePendingRow();
        when(registry.pushRegistryBestEffort(SITE)).thenThrow(new IllegalStateException("broker weg"));

        outbox.retryPending();

        Object[] args = updateArgs();
        assertThat(args[0]).isEqualTo("broker weg");
        assertThat(args[1]).isInstanceOf(java.sql.Timestamp.class);
        assertDriverBindable(args);
    }
}
