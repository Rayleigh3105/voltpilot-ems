package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.mock.env.MockPropertySource;

/**
 * Security-Wartung (vp-wartung-security-s1 C2): see {@link ProduktionsZugangsdatenGuard}
 * for why this exists. A fresh {@link StandardEnvironment} with its real
 * {@code systemEnvironment}/{@code systemProperties} sources stripped - this test
 * must stay correct regardless of which dev values the surrounding Maven test run
 * happens to export (pom.xml surefire config supplies them for the tests that need
 * a real, resolvable value without activating the local profile).
 */
class ProduktionsZugangsdatenGuardTest {

    private static StandardEnvironment leereProduktionsUmgebung() {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        return environment;
    }

    @Test
    void produktionBrichtOhneDieVierZugangsdatenMitKlarerMeldungAb() {
        StandardEnvironment environment = leereProduktionsUmgebung();

        assertThatThrownBy(
                () -> new ProduktionsZugangsdatenGuard().postProcessEnvironment(environment, new SpringApplication()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("APP_DB_PASSWORD")
                .hasMessageContaining("POSTGRES_PASSWORD")
                .hasMessageContaining("ADMIN_DB_PASSWORD")
                .hasMessageContaining("KEYCLOAK_API_CLIENT_SECRET");
    }

    @Test
    void produktionStartetMitGesetztenZugangsdaten() {
        StandardEnvironment environment = leereProduktionsUmgebung();
        environment.getPropertySources().addFirst(new MockPropertySource()
                .withProperty("APP_DB_PASSWORD", "ein-produktions-geheimnis")
                .withProperty("POSTGRES_PASSWORD", "ein-anderes-geheimnis")
                .withProperty("ADMIN_DB_PASSWORD", "noch-eins")
                .withProperty("KEYCLOAK_API_CLIENT_SECRET", "und-noch-eins"));

        assertThatCode(
                () -> new ProduktionsZugangsdatenGuard().postProcessEnvironment(environment, new SpringApplication()))
                .doesNotThrowAnyException();
    }

    @Test
    void einzelneFehlendeVariableWirdNamentlichGenannt() {
        StandardEnvironment environment = leereProduktionsUmgebung();
        environment.getPropertySources().addFirst(new MockPropertySource()
                .withProperty("APP_DB_PASSWORD", "x")
                .withProperty("POSTGRES_PASSWORD", "y")
                .withProperty("KEYCLOAK_API_CLIENT_SECRET", "z"));
        // ADMIN_DB_PASSWORD bleibt bewusst aus.

        assertThatThrownBy(
                () -> new ProduktionsZugangsdatenGuard().postProcessEnvironment(environment, new SpringApplication()))
                .hasMessageContaining("[ADMIN_DB_PASSWORD]")
                .hasMessageNotContaining("APP_DB_PASSWORD")
                .hasMessageNotContaining("POSTGRES_PASSWORD")
                .hasMessageNotContaining("KEYCLOAK_API_CLIENT_SECRET");
    }

    @Test
    void lokalesProfilBleibtOhneUmgebungGruen() {
        StandardEnvironment environment = leereProduktionsUmgebung();
        environment.setActiveProfiles("local");

        assertThatCode(
                () -> new ProduktionsZugangsdatenGuard().postProcessEnvironment(environment, new SpringApplication()))
                .doesNotThrowAnyException();
    }
}
