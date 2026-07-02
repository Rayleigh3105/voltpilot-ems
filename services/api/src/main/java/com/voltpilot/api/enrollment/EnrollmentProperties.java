package com.voltpilot.api.enrollment;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * First-boot device enrollment configuration ({@code voltpilot.enrollment.*}).
 *
 * <p>{@code caDir} points at the device-CA working directory (the layout
 * {@code tools/pki/voltpilot-ca.sh init-ca} creates: {@code ca.crt},
 * {@code ca.key}, {@code serial}, {@code index.txt}, {@code newcerts/}) - the
 * api signs device CSRs with this CA, so mount it read-write and treat the api
 * host as part of the PKI trust boundary (see docs/security-mqtt.md).
 * {@code aclFile} is the EMQX authorization file that receives the per-device
 * grant on issuance (blank = skip grant writing, e.g. when an operator manages
 * grants out of band). {@code mqttHost}/{@code mqttPort} are the broker
 * connection params handed to the device together with its certificate.
 */
@ConfigurationProperties(prefix = "voltpilot.enrollment")
public record EnrollmentProperties(
        boolean enabled,
        String caDir,
        String aclFile,
        String mqttHost,
        int mqttPort,
        int certDays,
        int maxCsrBytes) {

    public EnrollmentProperties {
        if (mqttHost == null || mqttHost.isBlank()) {
            mqttHost = "localhost";
        }
        if (mqttPort <= 0) {
            mqttPort = 8883;
        }
        if (certDays <= 0) {
            certDays = 825; // mirrors voltpilot-ca.sh issue -days 825
        }
        if (maxCsrBytes <= 0) {
            maxCsrBytes = 20_480;
        }
    }
}
