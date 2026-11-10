package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * The box's own enrollment moments (vp-box-verbinden-konzept S2), read from
 * the global, pre-claim {@code device_enrollment} table by the device's own
 * {@code external_ref} - safe because every caller already has RLS-scoped
 * access to the {@code device} row first, so a lookup only ever reaches a
 * box's OWN already-tenant-scoped reference.
 *
 * <p>{@code zuletztAngefragtAm} is the newest certificate-signing request the
 * box's own enroll loop has sent ({@code csr_updated_at}, refreshed on every
 * retry, not only the first); {@code schluesselAbgeholtAm} is when the cloud
 * last issued it a certificate for that request ({@code issued_at}). Both
 * null (this DTO absent, see {@link DeviceDto#anmeldung()}) means the box has
 * never asked since it was claimed - "nie angemeldet", not a slow heartbeat.
 */
public record AnmeldungDto(Instant zuletztAngefragtAm, Instant schluesselAbgeholtAm) {
}
