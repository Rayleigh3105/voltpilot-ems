package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * Outcome of a device data purge (POST /api/v1/devices/{id}/purge-data).
 * {@code deviceNotified} tells the portal whether the retained purge command
 * reached the broker - when false (broker outage), the cloud data is still
 * gone and the writer watermark blocks replays; the copy just cannot promise
 * the device's LOCAL buffer was told yet.
 */
public record DevicePurgeResultDto(
        UUID deviceId,
        long purgedRows,
        Instant purgedBefore,
        boolean deviceNotified) {
}
