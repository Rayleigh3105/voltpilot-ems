package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * What deleting a site would remove - shown in the portal's confirm dialog so
 * the customer sees the concrete consequences before typing "Löschen". A site
 * with devices cannot be deleted at all ({@code deviceCount > 0} => the DELETE
 * answers 409); the series counts cover the site's recorded history.
 */
public record SiteDeletionPreviewDto(
        int deviceCount,
        long telemetryCount,
        Instant telemetryFrom,
        Instant telemetryTo,
        long forecastCount,
        long scheduleCount,
        long weatherCount) {
}
