package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargingConfigRepository;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.SiteOcppControlController;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class OcppControlCommitTest {
    @Test void onlyCommittedPolicyIsPublished() throws Exception {
        var sites = mock(SiteRepository.class);
        var configs = mock(ChargingConfigRepository.class);
        var distribution = mock(ChargingConfigService.class);
        var status = mock(DeviceChargerStatusRepository.class);
        var mapper = new ObjectMapper();
        var controller = new SiteOcppControlController(sites, configs, distribution, status, new OcppControlValidator(), mapper);
        UUID tenant = UUID.randomUUID(), site = UUID.randomUUID();
        when(sites.existsForCurrentTenant(site)).thenReturn(true);
        when(configs.saveOcppControl(eq(tenant), eq(site), anyString(), eq(0L), eq("owner"))).thenReturn(true);
        when(status.ocppControlStatus(site)).thenReturn(List.of());
        for (boolean commit : new boolean[]{false, true}) {
            TenantContext.set(tenant);
            TransactionSynchronizationManager.initSynchronization();
            try {
                controller.save(site, mapper.readTree("{\"revision\":0,\"authorization\":{\"mode\":\"free\"}}"),
                        new TestingAuthenticationToken("owner", "unused"));
                verifyNoInteractions(distribution);
                for (var sync : TransactionSynchronizationManager.getSynchronizations()) {
                    if (commit) sync.afterCommit();
                    sync.afterCompletion(commit ? TransactionSynchronization.STATUS_COMMITTED : TransactionSynchronization.STATUS_ROLLED_BACK);
                }
                if (commit) verify(distribution).pushFor(tenant, site);
                else verifyNoInteractions(distribution);
            } finally { TransactionSynchronizationManager.clearSynchronization(); TenantContext.clear(); }
        }
    }
}
