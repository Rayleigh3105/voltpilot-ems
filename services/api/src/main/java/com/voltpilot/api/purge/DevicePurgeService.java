package com.voltpilot.api.purge;

import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.SeriesRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * The ONE place a device data purge ("Datenaufzeichnungen löschen") is
 * executed - both entry points (the portal endpoint on {@code DeviceController}
 * and the device-initiated MQTT {@code purge_request} via
 * {@link PurgeRequestListener}) run through here, so the ordering guarantees
 * hold no matter who asked. Design (docs/contracts/mqtt-data-purge.schema.json):
 *
 * <ol>
 *   <li><b>Watermark first</b>: {@code device.data_purged_before = now()} is
 *       committed as its own statement. From that moment the timescale-writer
 *       refuses any telemetry whose observation time is at or before the
 *       watermark, so a store-and-forward edge replaying old buffered samples
 *       can never resurrect the history we are about to delete - correctness
 *       never depends on the device cooperating.</li>
 *   <li><b>Delete + rollup rebuild</b> in one transaction
 *       ({@link SeriesRepository#purgeDeviceRecordings}): raw telemetry and
 *       every OCPP event/snapshot/transaction/configuration row of the device
 *       go, the site's rollups are recomputed from what remains.</li>
 *   <li><b>Retained {@code purge_data} command</b> to the device (best-effort):
 *       an online device wipes its local buffer + history immediately; an
 *       offline one gets the retained command on reconnect. Either way the
 *       command doubles as the device's confirmation signal.</li>
 * </ol>
 *
 * <p>The device row itself is untouched apart from the watermark: claim,
 * enrollment, certificates, ACL grants and the retained schedule all stay
 * intact, and new data (observed after the watermark) flows and charts
 * normally.
 */
@Service
public class DevicePurgeService {

    private static final Logger log = LoggerFactory.getLogger(DevicePurgeService.class);

    /** What a purge did (the portal response body mirrors this). */
    public record Result(UUID deviceId, long purgedRows, Instant purgedBefore, boolean deviceNotified) {
    }

    private final DeviceRepository devices;
    private final SeriesRepository series;
    private final ObjectProvider<ProvisioningPublisher> provisioning;

    public DevicePurgeService(DeviceRepository devices, SeriesRepository series,
            ObjectProvider<ProvisioningPublisher> provisioning) {
        this.devices = devices;
        this.series = series;
        this.provisioning = provisioning;
    }

    /**
     * Purge all recorded data of the given device (which the caller has already
     * resolved through the RLS-scoped repository, proving tenant ownership).
     * Requires the tenant context to be set - every statement here runs through
     * the RLS-scoped app datasource.
     */
    public Result purge(DeviceDto device) {
        UUID tenantId = TenantContext.get();
        Instant purgedBefore = Instant.now();
        devices.setDataPurgedBefore(device.id(), purgedBefore);
        long purgedRows = series.purgeDeviceRecordings(device.id(), device.siteId(), purgedBefore);
        boolean notified = false;
        ProvisioningPublisher publisher = provisioning.getIfAvailable();
        if (publisher != null) {
            notified = publisher.publishPurgeCommand(tenantId, device.siteId(), device.id(), purgedBefore);
        }
        log.info("Purged recorded data of device {} (ref '{}', tenant {}): {} telemetry rows removed, "
                + "watermark {}, device notified: {}",
                device.id(), device.externalRef(), tenantId, purgedRows, purgedBefore, notified);
        return new Result(device.id(), purgedRows, purgedBefore, notified);
    }
}
