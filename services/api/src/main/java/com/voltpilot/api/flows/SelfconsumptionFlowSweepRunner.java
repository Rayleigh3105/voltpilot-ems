package com.voltpilot.api.flows;

import com.voltpilot.api.tenant.TenantContext;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * One-time, idempotent startup sweep that retires every existing flow carrying
 * the removed {@code vp.strategy.selfconsumption} strategy node (report
 * vp-nacht-bezug-e7 §3.3): self-consumption is the platform's BASE behaviour, so
 * the node is gone from the catalog and a flow that still delegates it is a
 * no-op the customer never chose.
 *
 * <p>Two paths, mirroring the M3 lifecycle:
 * <ul>
 *   <li><b>ACTIVE</b> versions go through {@link FlowService#deactivate} so the
 *       (now smaller) deployment set is re-published and the edge removes the
 *       retired flow's retained artifact - never a stale artifact left behind.</li>
 *   <li><b>draft / simulated</b> versions are marked {@code retired} directly
 *       (nothing is deployed, so no republish is needed).</li>
 * </ul>
 * Nothing is lost - the FUNCTION of the flow IS the base behaviour, which keeps
 * running. Idempotent: a later boot finds no selfconsumption flow and no-ops.
 *
 * <p>Follows the {@code V2SiteBackfillRunner} pattern: enumeration is
 * cross-tenant via the BYPASSRLS {@code adminJdbcTemplate}, but the ACTIVE-flow
 * deactivation runs with the flow's tenant bound in the {@link TenantContext}
 * (the RLS-scoped path, exactly like an admin using the X-Tenant-Id switcher).
 * A failure on one flow is logged and never aborts the run or the boot.
 */
@Component
public class SelfconsumptionFlowSweepRunner {

    private static final Logger log = LoggerFactory.getLogger(SelfconsumptionFlowSweepRunner.class);

    private static final String NODE = "vp.strategy.selfconsumption";

    /** One flow carrying the removed node: its identity + whether it is active. */
    record Candidate(UUID flowId, UUID siteId, UUID tenantId, boolean hasActive) {}

    /** What one run did (for logging + tests). */
    public record SweepSummary(int flows, int deactivated, int draftsRetired, int failed) {}

    private final JdbcTemplate adminJdbc;
    private final FlowService flowService;
    private final boolean enabled;

    /** The {@code @Autowired} is load-bearing (the two-constructor footgun). */
    @Autowired
    public SelfconsumptionFlowSweepRunner(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            FlowService flowService,
            @Value("${voltpilot.flows.selfconsumption-sweep.enabled:true}") boolean enabled) {
        this.adminJdbc = adminJdbc;
        this.flowService = flowService;
        this.enabled = enabled;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
        if (!enabled) {
            log.info("selfconsumption flow sweep disabled "
                    + "(voltpilot.flows.selfconsumption-sweep.enabled=false)");
            return;
        }
        try {
            SweepSummary s = run();
            if (s.flows() > 0) {
                log.warn("selfconsumption flow sweep: {} flow(s) carried the removed "
                        + "vp.strategy.selfconsumption node - {} active deactivated, {} drafts "
                        + "retired, {} failed. Self-consumption is now base behaviour.",
                        s.flows(), s.deactivated(), s.draftsRetired(), s.failed());
            }
        } catch (RuntimeException e) {
            log.error("selfconsumption flow sweep failed, flows stay as-is: {}", e.toString(), e);
        }
    }

    /** Retire every selfconsumption-carrying flow; returns what happened. */
    public SweepSummary run() {
        int deactivated = 0;
        int draftsRetired = 0;
        int failed = 0;
        List<Candidate> flows = pending();
        for (Candidate c : flows) {
            try {
                if (c.hasActive()) {
                    TenantContext.set(c.tenantId());
                    try {
                        flowService.deactivate(c.siteId(), c.flowId());
                        deactivated++;
                        log.warn("selfconsumption flow sweep: deactivated active flow {} on site "
                                + "{}", c.flowId(), c.siteId());
                    } finally {
                        TenantContext.clear();
                    }
                }
                int retired = retireDrafts(c.flowId());
                if (retired > 0) {
                    draftsRetired += retired;
                    log.warn("selfconsumption flow sweep: retired {} draft/simulated version(s) of "
                            + "flow {} on site {}", retired, c.flowId(), c.siteId());
                }
            } catch (RuntimeException e) {
                failed++;
                log.warn("selfconsumption flow sweep: flow {} failed, staying as-is: {}",
                        c.flowId(), e.toString(), e);
            }
        }
        return new SweepSummary(flows.size(), deactivated, draftsRetired, failed);
    }

    /** Retire this flow's draft/simulated versions directly (nothing deployed). */
    private int retireDrafts(UUID flowId) {
        return adminJdbc.update(
                "UPDATE flow_definition SET lifecycle = 'retired', updated_at = now() "
                        + "WHERE flow_id = ? AND lifecycle IN ('draft', 'simulated')",
                flowId);
    }

    /** Flows (one row each) carrying the removed node, oldest first. */
    List<Candidate> pending() {
        // (flow_id, has-active) collapsed across versions.
        Map<UUID, Candidate> byFlow = new LinkedHashMap<>();
        adminJdbc.query(
                "SELECT flow_id, site_id, tenant_id, lifecycle FROM flow_definition d "
                        + "WHERE lifecycle <> 'retired' AND EXISTS ("
                        + "  SELECT 1 FROM jsonb_array_elements(d.document->'nodes') n "
                        + "  WHERE n->>'type' = ?) "
                        + "ORDER BY flow_id, flow_version",
                rs -> {
                    UUID flowId = rs.getObject("flow_id", UUID.class);
                    boolean active = "active".equals(rs.getString("lifecycle"));
                    Candidate prev = byFlow.get(flowId);
                    if (prev == null) {
                        byFlow.put(flowId, new Candidate(flowId,
                                rs.getObject("site_id", UUID.class),
                                rs.getObject("tenant_id", UUID.class), active));
                    } else if (active && !prev.hasActive()) {
                        byFlow.put(flowId, new Candidate(prev.flowId(), prev.siteId(),
                                prev.tenantId(), true));
                    }
                },
                NODE);
        return new ArrayList<>(byFlow.values());
    }
}
