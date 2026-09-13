package com.voltpilot.api.purge;

import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.SeriesRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BelegeImWeg;
import com.voltpilot.api.uems.MessreihenBelege;
import com.voltpilot.api.web.dto.DeviceDto;
import java.time.Instant;
import java.util.List;
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
 *   <li><b>Serialize per device</b>: a database-wide advisory session lock is
 *       held through watermark and sweep. OCPP ingestion takes the same lock
 *       transactionally, so a post-watermark event cannot be half-deleted.</li>
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
 * <p><b>Belege first</b> (UEMS AP-07 E8, IP-11): a box whose series were ever bound to a
 * Messstelle is refused with the list of those Messstellen ({@link BelegeImWeg}) BEFORE the lock,
 * the watermark or any delete - both entry points, nothing written. A box without Belege purges
 * exactly as before.
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
    private final DeviceDataLock dataLock;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final MessreihenBelege belege;

    public DevicePurgeService(DeviceRepository devices, SeriesRepository series,
            DeviceDataLock dataLock, ObjectProvider<ProvisioningPublisher> provisioning,
            MessreihenBelege belege) {
        this.devices = devices;
        this.series = series;
        this.dataLock = dataLock;
        this.provisioning = provisioning;
        this.belege = belege;
    }

    /**
     * Purge all recorded data of the given device (which the caller has already
     * resolved through the RLS-scoped repository, proving tenant ownership).
     * Requires the tenant context to be set - every statement here runs through
     * the RLS-scoped app datasource.
     *
     * @throws BelegeImWeg when the box carries series that were ever bound to a Messstelle -
     *     thrown before anything is locked or written
     */
    public Result purge(DeviceDto device) {
        UUID tenantId = TenantContext.get();
        List<MessreihenBelege.Beleg> imWeg = belege.derBox(device.id());
        if (!imWeg.isEmpty()) {
            throw new BelegeImWeg(BelegeImWeg.Gegenstand.BOX, imWeg);
        }
        Instant purgedBefore;
        long purgedRows;
        // This spans two commits on purpose: telemetry needs the watermark
        // visible before its sweep, while OCPP ingestion uses the same lock and
        // can therefore cross this boundary only wholly before or wholly after.
        try (DeviceDataLock.SessionLock ignored = dataLock.lockSession(device.id())) {
            // T is chosen only after the device lock is ours. Any ingest which
            // won the lock first is unambiguously pre-purge; every event born
            // after T must wait and is preserved after the sweep.
            purgedBefore = Instant.now();
            devices.setDataPurgedBefore(device.id(), purgedBefore);
            purgedRows = series.purgeDeviceRecordings(device.id(), device.siteId(), purgedBefore);
        }
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
