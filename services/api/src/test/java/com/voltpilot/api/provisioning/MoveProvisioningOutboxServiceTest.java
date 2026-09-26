package com.voltpilot.api.provisioning;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

class MoveProvisioningOutboxServiceTest {

    private final JdbcTemplate admin = mock(JdbcTemplate.class);
    private final ProvisioningPublisher publisher = mock(ProvisioningPublisher.class);
    private final EntityRegistryService registry = mock(EntityRegistryService.class);
    @SuppressWarnings("unchecked")
    private final ObjectProvider<ProvisioningPublisher> provisioning = mock(ObjectProvider.class);

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void appliesAnAcceptedMoveThatWasPendingBeforeTheEndpointWasRemoved() {
        MoveProvisioningOutboxService.PendingMove move = pendingMove();
        pending(move);
        when(provisioning.getIfAvailable()).thenReturn(publisher);
        when(publisher.clearRetained(move.externalRef(), move.tenantId(), move.fromSiteId(),
                move.deviceId())).thenReturn(true);
        when(publisher.publishConfig(move.externalRef(), move.tenantId(), move.toSiteId(),
                move.deviceId())).thenReturn(true);
        when(registry.pushRegistryBestEffort(move.toSiteId())).thenReturn(
                new EntityRegistryService.PushOutcome(true, true, null, move.deviceId()));
        UUID previousTenant = UUID.randomUUID();
        TenantContext.set(previousTenant);

        service().retryPending();

        verify(publisher).clearRetained(move.externalRef(), move.tenantId(), move.fromSiteId(),
                move.deviceId());
        verify(publisher).publishConfig(move.externalRef(), move.tenantId(), move.toSiteId(),
                move.deviceId());
        verify(registry).pushRegistryBestEffort(move.toSiteId());
        // main a64e23298 bindet java.sql.Timestamp statt Instant (pgJDBC kann Instant nicht typisieren).
        verify(admin).update(contains("SET status = ?"), eq("applied"), isNull(),
                any(java.sql.Timestamp.class), eq("applied"), any(java.sql.Timestamp.class), eq(move.id()));
        assertThat(TenantContext.get()).isEqualTo(previousTenant);
    }

    @Test
    void leavesBrokerFailuresPendingForTheNextRetry() {
        MoveProvisioningOutboxService.PendingMove move = pendingMove();
        pending(move);
        when(provisioning.getIfAvailable()).thenReturn(publisher);
        when(registry.pushRegistryBestEffort(move.toSiteId())).thenReturn(
                new EntityRegistryService.PushOutcome(true, false, "publish_failed",
                        move.deviceId()));

        service().retryPending();

        verify(admin).update(contains("SET status = ?"), eq("pending"), eq("publish_failed"),
                any(java.sql.Timestamp.class), eq("pending"), any(java.sql.Timestamp.class), eq(move.id()));
        assertThat(TenantContext.get()).isNull();
    }

    private MoveProvisioningOutboxService service() {
        return new MoveProvisioningOutboxService(admin, provisioning, registry);
    }

    private MoveProvisioningOutboxService.PendingMove pendingMove() {
        return new MoveProvisioningOutboxService.PendingMove(41L, UUID.randomUUID(),
                UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), "VP-LEGACY-0001");
    }

    @SuppressWarnings("unchecked")
    private void pending(MoveProvisioningOutboxService.PendingMove move) {
        // AP-20: beendete Kundenbereiche bleiben im SQL liegen (ein Parameter, ohne Spring leer)
        when(admin.query(contains("NOT (tenant_id = ANY (?::uuid[]))"), any(RowMapper.class), any()))
                .thenReturn(List.of(move));
    }
}
