package com.voltpilot.api.web.dto;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;
import java.util.Set;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Passwort-Vorgabe AP-20 E12 an der API: mindestens 12 Zeichen, bei der
 * Selbstregistrierung nicht die E-Mail (= Benutzername) und nicht der Name.
 * Der Controller validiert mit {@code @Valid}; jede Verletzung hier ist dort
 * ein 400 (der ganze Weg steht in {@code RegistrationApiTest}).
 */
class PasswortVorgabeTest {

    private static ValidatorFactory factory;
    private static Validator validator;

    @BeforeAll
    static void start() {
        factory = Validation.buildDefaultValidatorFactory();
        validator = factory.getValidator();
    }

    @AfterAll
    static void stop() {
        factory.close();
    }

    private static RegistrationRequest registrierung(String passwort) {
        return new RegistrationRequest("Erika Kaiser", "erika@example.com", passwort);
    }

    @Test
    void registrierungLehntElfZeichenAb() {
        Set<ConstraintViolation<RegistrationRequest>> v = validator.validate(registrierung("abcdefghijk"));
        assertThat(v).extracting(c -> c.getPropertyPath().toString()).containsExactly("password");
    }

    @Test
    void registrierungNimmtZwoelfZeichenAn() {
        assertThat(validator.validate(registrierung("abcdefghijkl"))).isEmpty();
    }

    @Test
    void registrierungLehntDieEmailAlsPasswortAb() {
        Set<ConstraintViolation<RegistrationRequest>> v = validator.validate(registrierung(" Erika@Example.COM "));
        assertThat(v).extracting(c -> c.getPropertyPath().toString()).containsExactly("passwordNotName");
    }

    @Test
    void registrierungLehntDenNamenAlsPasswortAb() {
        RegistrationRequest r = new RegistrationRequest("Sonnenhof Kaiser", "erika@example.com", "sonnenhof kaiser");
        assertThat(validator.validate(r)).extracting(c -> c.getPropertyPath().toString())
                .containsExactly("passwordNotName");
    }

    /**
     * Auf dem Sammelzweig setzt der Support kein Passwort mehr von Hand: AP-03 IP-14 (#864) vergibt ein
     * Startpasswort mit Pflichtwechsel. Dasselbe Ziel wie auf main (ResetPasswordRequest ab 12 Zeichen):
     * auch das vom Support übergebene Passwort erfüllt die Vorgabe E12.
     */
    @Test
    void supportStartpasswortHatEbenfallsMindestensZwoelfZeichen() {
        for (int i = 0; i < 50; i++) {
            assertThat(com.voltpilot.api.benutzer.Startpasswort.erzeugen().wert()).hasSizeGreaterThanOrEqualTo(12);
        }
    }
}
