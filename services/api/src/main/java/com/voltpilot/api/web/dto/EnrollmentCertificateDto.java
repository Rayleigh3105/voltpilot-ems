package com.voltpilot.api.web.dto;

import java.util.UUID;

/**
 * Everything a freshly enrolled device needs to switch to production mTLS
 * operation: its signed client certificate, the CA to verify the broker, the
 * broker address, and the claim-derived identity for its MQTT topics. The
 * device pairs {@code deviceCertPem} with the private key it generated for the
 * CSR - no key material is ever transported.
 */
public record EnrollmentCertificateDto(
        String deviceCertPem,
        String caPem,
        String mqttHost,
        int mqttPort,
        UUID tenantId,
        UUID siteId,
        UUID deviceId) {
}
