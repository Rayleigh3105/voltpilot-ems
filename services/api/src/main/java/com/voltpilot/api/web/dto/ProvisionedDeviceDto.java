package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * A manufactured device in the provisioning registry, plus its claim state
 * (admin view): {@code claimed}/{@code claimedByTenant} come from joining the
 * global {@code device} table, so an operator sees at a glance which shipped
 * devices customers have connected.
 */
public record ProvisionedDeviceDto(
        String externalRef,
        String kind,
        String note,
        Instant provisionedAt,
        boolean claimed,
        String claimedByTenant) {
}
