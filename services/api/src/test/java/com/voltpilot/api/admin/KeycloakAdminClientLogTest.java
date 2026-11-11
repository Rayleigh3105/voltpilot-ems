package com.voltpilot.api.admin;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * Das Anlegen eines Kontos protokolliert die interne Kennung des Kontos und nie Benutzername oder
 * E-Mail (docs/k8s-readiness.md, Abschnitt "Logs": Logs tragen interne Kennungen, keine Personen).
 * Gegen ein nachgestelltes Keycloak, ohne Docker.
 */
class KeycloakAdminClientLogTest {

    private static final String KONTO = "3b1f6c0e-5a2d-4e7b-8c91-0d2e4f6a8b10";
    private static final String BENUTZERNAME = "ines.ahrenberg";
    private static final String EMAIL = "ines@ahrenberg.example";

    private final Logger logger = (Logger) LoggerFactory.getLogger(KeycloakAdminClient.class);
    private final ListAppender<ILoggingEvent> zeilen = new ListAppender<>();
    private Level vorher;
    private HttpServer keycloak;
    private KeycloakAdminClient client;

    @BeforeEach
    void starten() throws Exception {
        keycloak = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        keycloak.createContext("/", anfrage -> {
            String pfad = anfrage.getRequestURI().getPath();
            String methode = anfrage.getRequestMethod();
            anfrage.getRequestBody().readAllBytes();
            int status = 200;
            String antwort = "";
            if (pfad.endsWith("/token")) {
                antwort = "{\"access_token\":\"test-token\",\"expires_in\":600}";
            } else if (methode.equals("POST") && pfad.endsWith("/users")) {
                status = 201;
                anfrage.getResponseHeaders().add("Location",
                        "http://127.0.0.1:" + keycloak.getAddress().getPort() + pfad + "/" + KONTO);
            } else if (methode.equals("GET") && pfad.endsWith("/users/" + KONTO)) {
                antwort = "{\"id\":\"" + KONTO + "\",\"username\":\"" + BENUTZERNAME + "\",\"email\":\"" + EMAIL
                        + "\",\"enabled\":true}";
            } else if (methode.equals("GET") && pfad.contains("/roles/")) {
                antwort = "{\"id\":\"rolle-1\",\"name\":\"partner\"}";
            } else if (methode.equals("POST") && pfad.endsWith("/role-mappings/realm")) {
                status = 204;
            } else {
                status = 404;
            }
            byte[] bytes = antwort.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > 0) {
                anfrage.getResponseHeaders().add("Content-Type", "application/json");
            }
            anfrage.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
            anfrage.getResponseBody().write(bytes);
            anfrage.close();
        });
        keycloak.start();
        KeycloakAdminProperties properties = new KeycloakAdminProperties();
        properties.setBaseUrl("http://127.0.0.1:" + keycloak.getAddress().getPort());
        client = new KeycloakAdminClient(properties);
        vorher = logger.getLevel();
        logger.setLevel(Level.DEBUG);
        zeilen.start();
        logger.addAppender(zeilen);
    }

    @AfterEach
    void beenden() {
        logger.detachAppender(zeilen);
        logger.setLevel(vorher);
        keycloak.stop(0);
    }

    private void nurInterneKennungen() {
        assertThat(zeilen.list).as("das Anlegen wird protokolliert").isNotEmpty();
        assertThat(zeilen.list).extracting(ILoggingEvent::getFormattedMessage).allSatisfy(zeile ->
                assertThat(zeile).doesNotContain(BENUTZERNAME).doesNotContain(EMAIL).doesNotContain("ines"));
        assertThat(zeilen.list).extracting(ILoggingEvent::getFormattedMessage)
                .anySatisfy(zeile -> assertThat(zeile).contains(KONTO));
    }

    @Test
    void einKundenkontoWirdMitKontoUndMandantProtokolliertNichtMitNamen() {
        UUID mandant = UUID.randomUUID();

        client.createCustomerUser(mandant, BENUTZERNAME, EMAIL, "Ines", "Ahrenberg", null, false);

        nurInterneKennungen();
        assertThat(zeilen.list).extracting(ILoggingEvent::getFormattedMessage)
                .anySatisfy(zeile -> assertThat(zeile).contains(mandant.toString()));
    }

    @Test
    void einPartnerkontoWirdMitKontoProtokolliertNichtMitNamen() {
        client.createPartnerUser(BENUTZERNAME, EMAIL, "Ines", "Ahrenberg", null, false);

        nurInterneKennungen();
    }
}
