package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * CSR upload for first-boot device enrollment. {@code csrPem} is a PEM-encoded
 * PKCS#10 request generated ON the device (the private key never leaves it);
 * the size cap refuses oversized anonymous payloads before any parsing (PEM is
 * ASCII, so the character cap equals the byte cap). {@code deviceInfo} is
 * optional free-form metadata (model, firmware) recorded for support.
 */
public record EnrollmentCsrRequest(
        @NotBlank @Size(max = 20_480) String csrPem,
        @Size(max = 500) String deviceInfo) {
}
