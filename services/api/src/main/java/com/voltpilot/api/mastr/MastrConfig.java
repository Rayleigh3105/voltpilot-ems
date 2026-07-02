package com.voltpilot.api.mastr;

import java.net.URI;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Dual-source wiring (the DayAheadPriceSource pattern): with the captain's
 * Webdienst credentials configured ({@code MASTR_API_KEY} +
 * {@code MASTR_MARKTAKTEUR_NUMMER}) lookups go to the official SOAP
 * webservice; without them - the default - the keyless public JSON backend
 * serves the same port. Promotion to the official source is pure config, no
 * code change. The transport is resolved via {@link ObjectProvider} so tests
 * drop in a fixture-serving {@link MastrHttp} bean and the REAL client code
 * runs offline.
 */
@Configuration
@EnableConfigurationProperties(MastrProperties.class)
public class MastrConfig {

    private static final Logger log = LoggerFactory.getLogger(MastrConfig.class);

    @Bean
    public PlantRegistryClient plantRegistryClient(MastrProperties props,
            ObjectProvider<MastrHttp> httpProvider) {
        MastrHttp http = httpProvider.getIfAvailable(() -> new JdkMastrHttp(props.timeout()));
        PlantRegistryClient client = props.hasCredentials()
                ? new MastrSoapClient(http, URI.create(props.soapEndpoint()),
                        props.apiKey(), props.marktakteurNummer())
                : new MastrJsonClient(http, URI.create(props.jsonEndpoint()));
        log.info("mastr.source={}", client.sourceId());
        return client;
    }
}
