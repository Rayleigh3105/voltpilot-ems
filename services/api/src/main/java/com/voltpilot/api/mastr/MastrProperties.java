package com.voltpilot.api.mastr;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * MaStR access configuration ({@code voltpilot.mastr.*}). The api key +
 * Marktakteur number are the captain's one-time Webdienstnutzer registration
 * (see docs); when BLANK - the default - lookups use the keyless public JSON
 * backend instead, so dev and a fresh deployment need no secret.
 */
@ConfigurationProperties(prefix = "voltpilot.mastr")
public record MastrProperties(
        String apiKey,
        String marktakteurNummer,
        String soapEndpoint,
        String jsonEndpoint,
        Duration timeout) {

    public MastrProperties {
        if (soapEndpoint == null || soapEndpoint.isBlank()) {
            soapEndpoint = "https://www.marktstammdatenregister.de/MaStRApi/Api.svc/Soap11/Anlage";
        }
        if (jsonEndpoint == null || jsonEndpoint.isBlank()) {
            jsonEndpoint = "https://www.marktstammdatenregister.de/MaStR/Einheit/EinheitJson/"
                    + "GetErweiterteOeffentlicheEinheitStromerzeugung";
        }
        if (timeout == null) {
            timeout = Duration.ofSeconds(15);
        }
    }

    public boolean hasCredentials() {
        return apiKey != null && !apiKey.isBlank()
                && marktakteurNummer != null && !marktakteurNummer.isBlank();
    }
}
