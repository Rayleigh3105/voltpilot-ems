package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * A device that enrolled (uploaded a CSR) but has no currently-claimed
 * {@code device} row - the operator view onto "did its part, waiting for the
 * portal". This surfaces the otherwise-invisible half of a mistyped-reference
 * dead-end: the device polls forever while the customer typed a different ref,
 * so nothing links the two. Deliberately admin-only; the device-facing
 * enrollment poll stays opaque (pending == unknown, no enumeration).
 *
 * <p>{@code everIssued} is true when a certificate was once issued and the
 * device was later unclaimed (a stale enrollment) versus never claimed at all.
 */
public record PendingEnrollmentDto(
        String externalRef,
        String deviceInfo,
        Instant csrUpdatedAt,
        boolean everIssued,
        Instant issuedAt) {
}
