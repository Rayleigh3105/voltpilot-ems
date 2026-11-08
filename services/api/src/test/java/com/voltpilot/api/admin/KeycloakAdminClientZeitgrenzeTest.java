package com.voltpilot.api.admin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.web.client.RestClientException;

/**
 * Der Admin-Client gegen ein Keycloak, das die Verbindung annimmt und nie antwortet. Vorher baute
 * {@link KeycloakAdminClient} seine {@code SimpleClientHttpRequestFactory} ohne Zeitgrenzen, und die JDK-Verbindung
 * wartet dann unbegrenzt - der aufrufende Request-Thread (öffentliche Registrierung, Benutzerverwaltung) hing, und
 * hinter dem {@code synchronized} Token-Abruf jeder weitere Aufrufer mit. Jetzt scheitert der Aufruf begrenzt, wie bei
 * einem nicht erreichbaren Keycloak.
 */
class KeycloakAdminClientZeitgrenzeTest {

    private HttpServer keycloak;
    private final CountDownLatch freigeben = new CountDownLatch(1);

    @AfterEach
    void beenden() {
        freigeben.countDown();
        if (keycloak != null) {
            keycloak.stop(0);
        }
    }

    @Test
    @Timeout(20) // ohne Zeitgrenze hinge der Aufruf hier für immer - der Test scheitert statt zu hängen
    void einSchweigendesKeycloakBeendetDenAufrufNachDerZeitgrenze() throws Exception {
        keycloak = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        keycloak.createContext("/", anfrage -> {
            try {
                freigeben.await(15, TimeUnit.SECONDS); // annehmen, dann schweigen
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            anfrage.close();
        });
        keycloak.start();
        KeycloakAdminProperties properties = new KeycloakAdminProperties();
        properties.setBaseUrl("http://127.0.0.1:" + keycloak.getAddress().getPort());
        properties.setReadTimeout(Duration.ofMillis(300));
        KeycloakAdminClient client = new KeycloakAdminClient(properties);

        long start = System.nanoTime();
        assertThatThrownBy(() -> client.getUser("3b1f6c0e-5a2d-4e7b-8c91-0d2e4f6a8b10"))
                .isInstanceOf(RestClientException.class)
                .hasRootCauseInstanceOf(SocketTimeoutException.class);
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
    }

    @Test
    void dieVorgabenBegrenzenAufbauUndAntwort() {
        KeycloakAdminProperties properties = new KeycloakAdminProperties();
        assertThat(properties.getConnectTimeout()).isEqualTo(Duration.ofSeconds(5));
        assertThat(properties.getReadTimeout()).isEqualTo(Duration.ofSeconds(20));
    }
}
