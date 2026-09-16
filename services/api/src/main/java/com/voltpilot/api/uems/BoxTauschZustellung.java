package com.voltpilot.api.uems;

import com.voltpilot.api.chargers.ChargingConfigPublisher;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.control.ControlCertificationPublisher;
import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.ota.OtaTargetPublisher;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.ControlCertificationRepository;
import com.voltpilot.api.repo.RolloutRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.UUID;
import java.util.function.Function;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/** Nach dem DB-Commit: wiederholbar über die vorhandenen Enrollment-/Publisher-Wege. */
@Service
public class BoxTauschZustellung {
    private final JdbcTemplate jdbc;
    private final JdbcTemplate admin;
    private final ObjectProvider<EnrollmentService> enrollment;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final ObjectProvider<EntityRegistryPublisher> entities;
    private final ObjectProvider<MeasurementConfigPublisher> measurements;
    private final ObjectProvider<ControlCertificationPublisher> certification;
    private final ObjectProvider<OtaTargetPublisher> ota;
    private final ObjectProvider<FlowDeploymentPublisher> flows;
    private final ObjectProvider<ChargingConfigPublisher> charging;
    private final EntityRegistryService registry;
    private final MeasurementSelectionService selections;
    private final ControlCertificationRepository approvals;
    private final RolloutRepository rollouts;
    private final FlowActivationService deployments;
    private final ChargingConfigService chargingConfig;
    private final boolean enabled;
    private final com.voltpilot.api.repo.DeviceRepository devices;
    private final com.voltpilot.api.enrollment.EnrollmentDeviceLookup identities;
    private final org.springframework.transaction.support.TransactionTemplate transaction;

    public BoxTauschZustellung(JdbcTemplate jdbc, @Qualifier("adminJdbcTemplate") JdbcTemplate admin,
            ObjectProvider<EnrollmentService> enrollment, ObjectProvider<ProvisioningPublisher> provisioning,
            ObjectProvider<EntityRegistryPublisher> entities, ObjectProvider<MeasurementConfigPublisher> measurements,
            ObjectProvider<ControlCertificationPublisher> certification, ObjectProvider<OtaTargetPublisher> ota,
            ObjectProvider<FlowDeploymentPublisher> flows, ObjectProvider<ChargingConfigPublisher> charging,
            EntityRegistryService registry, MeasurementSelectionService selections,
            ControlCertificationRepository approvals, RolloutRepository rollouts,
            FlowActivationService deployments, ChargingConfigService chargingConfig,
            com.voltpilot.api.repo.DeviceRepository devices,
            com.voltpilot.api.enrollment.EnrollmentDeviceLookup identities,
            org.springframework.transaction.PlatformTransactionManager transactions,
            @Value("${voltpilot.uems.uebergabe.enabled:true}") boolean enabled) {
        this.jdbc=jdbc; this.admin=admin; this.enrollment=enrollment; this.provisioning=provisioning;
        this.entities=entities; this.measurements=measurements; this.certification=certification;
        this.ota=ota; this.flows=flows; this.charging=charging; this.registry=registry;
        this.selections=selections; this.approvals=approvals; this.rollouts=rollouts;
        this.deployments=deployments; this.chargingConfig=chargingConfig; this.enabled=enabled;
        this.devices=devices; this.identities=identities;
        this.transaction=new org.springframework.transaction.support.TransactionTemplate(transactions);
    }

    /** Derselbe Produktions-/Test-Schalter wie die Quellenübergabe; keine zweite Aktivierung. */
    @Scheduled(fixedDelayString = "${voltpilot.uems.uebergabe.interval-ms:15000}")
    public void retryPending() {
        if (!enabled) return;
        var pending = admin.query("SELECT tenant_id,old_device_id FROM device_succession "
                + "WHERE delivered_at IS NULL ORDER BY effective_at LIMIT 20",
                (rs,n) -> new UUID[] {rs.getObject(1,UUID.class),rs.getObject(2,UUID.class)});
        UUID previous=TenantContext.get();
        try {
            for (var row: pending) {
                TenantContext.set(row[0]);
                zustellen(row[1]);
            }
        } finally {
            if (previous == null) TenantContext.clear(); else TenantContext.set(previous);
        }
    }

    public boolean zustellen(UUID oldId) {
        var rows=jdbc.query("SELECT s.new_device_id,s.site_id,d.external_ref,n.external_ref AS new_ref "
                + "FROM device_succession s JOIN device d ON d.id=s.old_device_id "
                + "JOIN device n ON n.id=s.new_device_id WHERE s.old_device_id=? AND s.delivered_at IS NULL",
                (rs,n) -> new Auftrag(rs.getObject(1,UUID.class),rs.getObject(2,UUID.class),
                        rs.getString(3),rs.getString(4)), oldId);
        if (rows.isEmpty()) return true;
        Auftrag a=rows.getFirst();
        UUID tenant=TenantContext.get();
        try {
            if (!send(enrollment, e -> e.blockSucceededDevice(a.oldRef(),oldId))) return ausstehend(oldId,"acl_entzug_ausstehend");
            boolean cleared=Boolean.TRUE.equals(transaction.execute(status -> {
                devices.lockReference(a.oldRef());
                boolean clearProvisioning=identities.findByRef(a.oldRef()).isEmpty();
                return send(provisioning,p -> p.clearRetained(a.oldRef(),tenant,a.site(),oldId,clearProvisioning));
            }));
            cleared &= send(entities,p -> p.clearRegistry(tenant,a.site(),oldId));
            cleared &= send(measurements,p -> p.clear(tenant,a.site(),oldId));
            cleared &= send(certification,p -> p.clear(tenant,a.site(),oldId));
            cleared &= send(ota,p -> p.clearTarget(tenant,a.site(),oldId));
            cleared &= send(flows,p -> p.clearDeployment(tenant,a.site(),oldId));
            cleared &= send(charging,p -> p.clear(tenant,a.site(),oldId));
            if (!cleared) return ausstehend(oldId,"retained_bereinigung_ausstehend");
            // Expliziter E7-Entzug statt einer unerreichbaren Quittung der ausgebauten Box.
            // Kein Reset laufender/neuerer Übergaben bei einem Wiederholungsversuch.
            jdbc.update("UPDATE data_source_handover SET phase='receiving',started_at=now(),sent_revision=NULL,"
                    + "written_xid=pg_current_xact_id() WHERE reader_id=? AND target_id=? AND phase='pending'",oldId,a.next());
            boolean sent=send(provisioning,p -> p.publishConfig(a.newRef(),tenant,a.site(),a.next()));
            sent &= registry.pushRegistryBestEffort(a.site()).published();
            var state=selections.forPublishing(a.next());
            sent &= send(measurements,p -> p.publish(selections.requireDevice(a.next()),state));
            boolean active=approvals.findActivation(a.next()).isPresent();
            sent &= send(certification,p -> p.publish(tenant,a.site(),a.next(),active,approvals.listCertifications(),Instant.now()));
            var target=rollouts.targetOf(a.next());
            if (target.isPresent()) {
                var t=target.get();
                boolean targetSent=t.manifest() != null && t.signature() != null
                        && send(ota,p -> p.publishTarget(tenant,a.site(),a.next(),t.releaseVersion(),t.releaseSeq(),
                                t.rolloutId(),t.manifest(),t.signature(),t.assignedAt()));
                if (targetSent) jdbc.update("UPDATE device_update_target SET published_at=now() WHERE device_id=?",a.next());
                sent &= targetSent;
            }
            sent &= deployments.republishForSite(a.site());
            sent &= chargingConfig.republishForSite(tenant,a.site());
            if (!sent) return ausstehend(oldId,"konfiguration_ausstehend");
            jdbc.update("UPDATE device_succession SET delivered_at=now(),last_error=NULL WHERE old_device_id=?",oldId);
            return true;
        } catch (RuntimeException e) {
            org.slf4j.LoggerFactory.getLogger(getClass()).warn("Box succession delivery pending for {}",oldId,e);
            return ausstehend(oldId,"zustellung_fehlgeschlagen");
        }
    }

    private record Auftrag(UUID next, UUID site, String oldRef, String newRef) {}
    private boolean ausstehend(UUID oldId,String reason) {
        jdbc.update("UPDATE device_succession SET last_error=? WHERE old_device_id=?",reason,oldId);
        return false;
    }
    private static <T> boolean send(ObjectProvider<T> provider,Function<T,Boolean> action) {
        T value=provider.getIfAvailable();
        return value != null && action.apply(value);
    }
}
