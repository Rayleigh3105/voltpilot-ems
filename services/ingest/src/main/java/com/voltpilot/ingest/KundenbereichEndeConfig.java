package com.voltpilot.ingest;

import java.time.Clock;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Die Sperre beendeter Kundenbereiche in der Datenannahme (UEMS AP-20 IP-16) — mit den Zugangsdaten, die schon die
 * Box-Auskunft ({@code voltpilot.provisioning.db.*}) nutzt. Abschaltbar für einen ingest ohne Datenbank; dann nimmt
 * er alles an wie vorher.
 */
@Configuration
@ConditionalOnProperty(name = "voltpilot.kundenbereich-ende.enabled", havingValue = "true", matchIfMissing = true)
public class KundenbereichEndeConfig {

    @Bean
    BeendeteKundenbereiche beendeteKundenbereiche(
            @Value("${voltpilot.provisioning.db.jdbc-url:jdbc:postgresql://localhost:5432/voltpilot}") String jdbcUrl,
            @Value("${voltpilot.provisioning.db.username:voltpilot}") String username,
            @Value("${voltpilot.provisioning.db.password:voltpilot_dev_pw}") String password,
            Clock clock) {
        return new BeendeteKundenbereiche(BeendeteKundenbereiche.jdbc(jdbcUrl, username, password), clock);
    }
}
