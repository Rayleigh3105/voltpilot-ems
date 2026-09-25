package com.voltpilot.api.uems;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Der Seed-Weg der Prüfumgebung gegen die Datenbank des lokalen Stapels (UEMS AP-20 IP-13) — kein Test, ein Werkzeug:
 * nur mit {@code -Dpruefumgebung.jdbc=…} aktiv, sonst in jedem Lauf übersprungen. Aufruf über
 * {@code infra/local/pruefumgebung/ahrenberg.sh}; er baut auf den eingespielten Seed 1.4 die Welt der Referenzdatei 1.10
 * ({@link PruefumgebungAhrenberg}) und tut nichts, wenn sie schon steht.
 *
 * <p>Die Anwendung dieses Laufs spricht über die Routen (MockMvc) mit derselben Datenbank wie die {@code api} des
 * Stapels; Flyway findet dort nichts Neues, solange beide aus demselben Stand gebaut sind.
 */
@EnabledIfSystemProperty(named = "pruefumgebung.jdbc", matches = "jdbc:postgresql://.+")
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class PruefumgebungAhrenbergAufbau {
    private static final String JDBC = System.getProperty("pruefumgebung.jdbc", "");
    private static final String EIGNER = System.getProperty("pruefumgebung.eigner", "voltpilot");
    private static final String EIGNER_PW = System.getProperty("pruefumgebung.eigner-passwort", "voltpilot_dev_pw");
    private static final String APP_PW = System.getProperty("pruefumgebung.app-passwort", "voltpilot_app_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> JDBC);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> APP_PW);
        r.add("spring.flyway.url", () -> JDBC);
        r.add("spring.flyway.user", () -> EIGNER);
        r.add("spring.flyway.password", () -> EIGNER_PW);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        r.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
        r.add("voltpilot.pruefumgebung.buehnen-uhr", () -> PruefumgebungAhrenberg.BUEHNE);
    }

    @Autowired MockMvc mvc;
    @Autowired PruefumgebungUhr buehnenUhr;

    @Test
    void aufbauen() throws Exception {
        JdbcTemplate root = new JdbcTemplate(new DriverManagerDataSource(JDBC, EIGNER, EIGNER_PW));
        boolean gebaut = PruefumgebungAhrenberg.aufbauen(mvc, root, buehnenUhr);
        System.out.println(gebaut ? "Prüfumgebung: die Welt der Referenzdatei 1.10 steht jetzt im Kundenbereich Ahrenberg."
                : "Prüfumgebung: die Welt stand schon — nichts geändert.");
    }
}
