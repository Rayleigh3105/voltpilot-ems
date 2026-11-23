package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * The box's own enrollment moments (vp-box-verbinden-konzept S2), read from
 * the global, pre-claim {@code device_enrollment} table by the device's own
 * {@code external_ref} - safe because every caller already has RLS-scoped
 * access to the {@code device} row first, so a lookup only ever reaches a
 * box's OWN already-tenant-scoped reference.
 *
 * <p>{@code zuletztAngefragtAm} is the certificate-signing request the box's
 * own enroll loop sent ({@code csr_updated_at}); the box uploads it only once
 * per program start, not refreshed on later retries, so this can predate the
 * claim by hours if the box was already running (vp-erstverbindung-update-
 * konzept N1). {@code schluesselAbgeholtAm} is when the cloud last issued it
 * a certificate for that request ({@code issued_at}). All three null (this DTO
 * absent, see {@link DeviceDto#anmeldung()}) means the box has never asked
 * since it was claimed - "nie angemeldet", not a slow heartbeat.
 *
 * <p>{@code zuletztAbgefragtAm} (vp-einrichtung-verbunden-keine-wahl, {@code zuletzt_abgefragt_am})
 * is the box's own certificate-POLL heartbeat - unlike {@code zuletztAngefragtAm} this repeats
 * every reconcile cycle, before AND after the claim, so it is the one sign of life a freshly
 * claimed box that has not sent a status heartbeat yet can give.
 */
public record AnmeldungDto(Instant zuletztAngefragtAm, Instant schluesselAbgeholtAm, Instant zuletztAbgefragtAm) {
}
