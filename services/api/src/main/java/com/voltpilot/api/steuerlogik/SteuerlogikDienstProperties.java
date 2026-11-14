package com.voltpilot.api.steuerlogik;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Adresse und Frist des Logik-Dienstes (Compose-Dienst {@code logik-dienst}). */
@ConfigurationProperties(prefix = "voltpilot.steuerlogik.dienst")
public record SteuerlogikDienstProperties(String baseUrl, Duration timeout) {

    public SteuerlogikDienstProperties {
        if (baseUrl == null || baseUrl.isBlank()) {
            baseUrl = "http://logik-dienst:8101";
        }
        if (timeout == null) {
            timeout = Duration.ofSeconds(15);
        }
    }
}
