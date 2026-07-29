package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.flows.SelfconsumptionFlowSweepRunner.Candidate;
import com.voltpilot.api.tenant.TenantContext;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The one-time sweep that retires every existing flow carrying the removed
 * {@code vp.strategy.selfconsumption} node (report vp-nacht-bezug-e7 §3.3),
 * unit-tested against a stubbed candidate query + FlowService - the real
 * deactivation is proven against a live DB by the flow API tests.
 */
class SelfconsumptionFlowSweepRunnerTest {

    private final JdbcTemplate adminJdbc = mock(JdbcTemplate.class);
    private final FlowService flowService = mock(FlowService.class);

    private SelfconsumptionFlowSweepRunner runner(boolean enabled, List<Candidate> pending) {
        SelfconsumptionFlowSweepRunner r =
                spy(new SelfconsumptionFlowSweepRunner(adminJdbc, flowService, enabled));
        doReturn(new ArrayList<>(pending)).when(r).pending();
        return r;
    }

    private static Candidate candidate(boolean hasActive) {
        return new Candidate(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), hasActive);
    }

    @Test
    void deactivatesAnActiveFlowUnderItsTenantAndRetiresItsDrafts() {
        Candidate c = candidate(true);
        List<UUID> tenantSeenInside = new ArrayList<>();
        when(flowService.deactivate(c.siteId(), c.flowId())).thenAnswer(i -> {
            tenantSeenInside.add(TenantContext.get());
            return Map.of();
        });
        when(adminJdbc.update(anyString(), eq(c.flowId()))).thenReturn(1);

        SelfconsumptionFlowSweepRunner.SweepSummary s = runner(true, List.of(c)).run();

        assertThat(s.flows()).isEqualTo(1);
        assertThat(s.deactivated()).isEqualTo(1);
        assertThat(s.draftsRetired()).isEqualTo(1);
        // The deactivation runs under the flow's tenant (RLS fence).
        assertThat(tenantSeenInside).containsExactly(c.tenantId());
        assertThat(TenantContext.get()).as("context cleared after the run").isNull();
    }

    @Test
    void retiresADraftOnlyFlowWithoutDeactivating() {
        Candidate c = candidate(false);
        when(adminJdbc.update(anyString(), eq(c.flowId()))).thenReturn(2);

        SelfconsumptionFlowSweepRunner.SweepSummary s = runner(true, List.of(c)).run();

        assertThat(s.deactivated()).isZero();
        assertThat(s.draftsRetired()).isEqualTo(2);
        verify(flowService, never()).deactivate(any(), any());
    }

    @Test
    void oneFailingFlowNeverStopsTheRunAndClearsTheContext() {
        Candidate broken = candidate(true);
        Candidate healthy = candidate(true);
        when(flowService.deactivate(broken.siteId(), broken.flowId()))
                .thenThrow(new IllegalStateException("boom"));
        when(flowService.deactivate(healthy.siteId(), healthy.flowId())).thenReturn(Map.of());
        when(adminJdbc.update(anyString(), eq(healthy.flowId()))).thenReturn(0);

        SelfconsumptionFlowSweepRunner.SweepSummary s =
                runner(true, List.of(broken, healthy)).run();

        assertThat(s.failed()).isEqualTo(1);
        assertThat(s.deactivated()).isEqualTo(1);
        assertThat(TenantContext.get()).as("context cleared even after a failure").isNull();
    }

    @Test
    void theOpsKillSwitchDoesNothingAtAll() {
        SelfconsumptionFlowSweepRunner r = runner(false, List.of(candidate(true)));
        r.onApplicationReady();
        verify(r, never()).run();
        verify(flowService, never()).deactivate(any(), any());
    }

    @Test
    void aNoOpRunIsFineWhenNoFlowCarriesTheNode() {
        SelfconsumptionFlowSweepRunner.SweepSummary s = runner(true, List.of()).run();
        assertThat(s.flows()).isZero();
        verify(flowService, never()).deactivate(any(), any());
    }
}
