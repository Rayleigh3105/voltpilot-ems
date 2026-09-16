package com.voltpilot.api.benutzer;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminProperties;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

class StartpasswortGeheimhaltungTest {
    @Test void auchEinZurueckgespiegeltesPasswortImKeycloakFehlerWirdNichtProtokolliert() throws Exception {
        Startpasswort passwort = Startpasswort.erzeugen();
        ObjectMapper json = new ObjectMapper();
        AtomicBoolean temporary = new AtomicBoolean();
        AtomicBoolean wertStimmt = new AtomicBoolean();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            boolean token = exchange.getRequestURI().getPath().endsWith("/token");
            if (!token) {
                var request = json.readTree(body);
                var credential = request.has("credentials") ? request.path("credentials").get(0) : request;
                temporary.set(credential.path("temporary").asBoolean());
                wertStimmt.set(passwort.wert().equals(credential.path("value").asText()));
            }
            byte[] antwort = (token ? "{\"access_token\":\"test-token\",\"expires_in\":600}"
                    : json.writeValueAsString(java.util.Map.of("error", passwort.wert()))).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(token ? 200 : 400, antwort.length);
            exchange.getResponseBody().write(antwort); exchange.close();
        });
        server.start();
        Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
        Level level = root.getLevel();
        List<ch.qos.logback.core.Appender<ILoggingEvent>> ausgaben = new ArrayList<>();
        root.iteratorForAppenders().forEachRemaining(ausgaben::add); ausgaben.forEach(root::detachAppender);
        ListAppender<ILoggingEvent> logs = new ListAppender<>(); logs.start(); root.addAppender(logs); root.setLevel(Level.DEBUG);
        try {
            KeycloakAdminProperties properties = new KeycloakAdminProperties();
            properties.setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
            KeycloakAdminClient client = new KeycloakAdminClient(properties);
            for (boolean neu : List.of(true, false)) {
                boolean abgelehnt = false;
                try {
                    if (neu) client.createCustomerUser(UUID.randomUUID(), "ines", "ines@ahrenberg.example", null, null, passwort.wert(), true);
                    else client.resetPassword("ines", passwort.wert(), true);
                } catch (KeycloakAdminClient.KeycloakAdminException ex) {
                    abgelehnt = ex.status() == 400;
                    assertThat(ex.toString().contains(passwort.wert())).isFalse();
                    assertThat(ex.getCause()).isNull();
                }
                assertThat(abgelehnt).isTrue(); assertThat(temporary.get()).isTrue(); assertThat(wertStimmt.get()).isTrue();
            }
            assertThat(logs.list.stream().noneMatch(e -> e.getFormattedMessage().contains(passwort.wert()))).isTrue();
            assertThat(passwort.toString().contains(passwort.wert())).isFalse();
            assertThat(json.readTree(json.writeValueAsString(passwort)).asText().equals(passwort.wert())).isTrue();
        } finally {
            root.setLevel(level); root.detachAppender(logs); ausgaben.forEach(root::addAppender); server.stop(0);
        }
    }
}
