package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Die Quelle des Wetter-Archivs ist Konfiguration des Betreibers (LA1, LA5): {@code voltpilot.uems.wetter-archiv.quelle}
 * ({@code open-meteo}), {@code basis-url}, {@code schluessel} (optional), {@code zeitgrenze}. Eine andere Quelle ist
 * noch nicht gebaut — sie liefert einen Ausfall, nie eine Zahl.
 */
@Configuration
public class WetterArchivKonfiguration {

    @Bean
    WetterArchiv wetterArchiv(@Value("${voltpilot.uems.wetter-archiv.quelle:open-meteo}") String quelle,
            @Value("${voltpilot.uems.wetter-archiv.basis-url:https://archive-api.open-meteo.com}") String basisUrl,
            @Value("${voltpilot.uems.wetter-archiv.schluessel:}") String schluessel,
            @Value("${voltpilot.uems.wetter-archiv.zeitgrenze:PT20S}") Duration zeitgrenze, ObjectMapper json) {
        if ("open-meteo".equals(quelle)) {
            return new OpenMeteoWetterArchiv(basisUrl, schluessel, zeitgrenze, json, Clock.systemUTC());
        }
        return (breite, laenge, von, bis, zone) ->
                new WetterArchiv.Abruf(quelle, Instant.now(), Map.of(), "Quelle „" + quelle + "“ ist nicht gebaut");
    }
}
