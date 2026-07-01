package com.voltpilot.ingest.provisioning;

import java.util.Optional;
import java.util.UUID;

/**
 * Lookup of a claimed device by its edge reference (device.external_ref), the
 * cloud-side half of the zero-touch handshake
 * (docs/contracts/mqtt-provisioning.schema.json). Cross-tenant by design: a
 * booting device knows only its ref, so the resolver must find it wherever it
 * was claimed - the resolver is a trusted cloud component like the writer.
 */
public interface DeviceDirectory {

    /** The claimed identity for a ref, or empty when nobody has claimed it yet. */
    Optional<DeviceIdentity> findByRef(String externalRef);

    record DeviceIdentity(UUID tenantId, UUID siteId, UUID deviceId) {
    }
}
