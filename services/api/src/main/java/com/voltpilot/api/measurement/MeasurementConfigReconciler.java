package com.voltpilot.api.measurement;

import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.EventListener;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Re-publishes authoritative desired state until its full revision is acknowledged. */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class MeasurementConfigReconciler {
    private static final Logger log = LoggerFactory.getLogger(MeasurementConfigReconciler.class);
    private final JdbcTemplate adminJdbc;
    private final MeasurementSelectionService selections;
    private final MeasurementConfigPublisher publisher;

    public MeasurementConfigReconciler(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MeasurementSelectionService selections, MeasurementConfigPublisher publisher) {
        this.adminJdbc = adminJdbc;
        this.selections = selections;
        this.publisher = publisher;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void atStartup() {
        reconcile();
    }

    @Scheduled(fixedDelayString = "${voltpilot.measurements.reconcile-interval-ms:30000}",
            initialDelayString = "${voltpilot.measurements.reconcile-initial-delay-ms:30000}")
    public void reconcile() {
        for (DeviceScope scope : pending()) {
            TenantContext.set(scope.tenantId());
            try {
                publisher.publish(scope, selections.state(scope.deviceId()));
            } catch (Exception e) {
                log.warn("measurement desired-state reconciliation failed for device {}: {}",
                        scope.deviceId(), e.getMessage());
            } finally {
                TenantContext.clear();
            }
        }
    }

    List<DeviceScope> pending() {
        return adminJdbc.query("""
                SELECT d.tenant_id,d.site_id,d.id
                  FROM device d
                 WHERE EXISTS (SELECT 1 FROM device_measurement_selection s WHERE s.device_id=d.id)
                   AND COALESCE((SELECT max(e.desired_revision)
                                   FROM device_measurement_selection_event e
                                  WHERE e.device_id=d.id),0)
                       > COALESCE((SELECT max(e.desired_revision)
                                     FROM device_measurement_selection_event e
                                    WHERE e.device_id=d.id AND e.event_kind='edge_ack'),0)
                 ORDER BY d.id
                """, (rs, n) -> new DeviceScope(rs.getObject(1, UUID.class),
                        rs.getObject(2, UUID.class), rs.getObject(3, UUID.class)));
    }
}
