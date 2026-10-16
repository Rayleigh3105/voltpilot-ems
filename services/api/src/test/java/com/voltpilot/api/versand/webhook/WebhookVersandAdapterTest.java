package com.voltpilot.api.versand.webhook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Der Webhook-Adapter auf Drahtebene (Signatur, Statuscode-Zuordnung) gegen einen lokalen
 * HTTP-Fänger - mit der permissiven Ziel-Prüfung (package-sichtbarer Konstruktor), weil die echte
 * SSRF-Prüfung einen Loopback-Fänger sonst zu Recht sperren würde; sie selbst ist vollständig
 * unabhängig davon unit-getestet ({@link WebhookZielPruefungTest}). Kein Docker nötig.
 */
class WebhookVersandAdapterTest {

    private HttpServer server;

    @AfterEach
    void beenden() {
        if (server != null) {
            server.stop(0);
        }
    }

    private String starten(int status, AtomicReference<String> koerperAus,
            AtomicReference<String> signaturAus) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/webhook", exchange -> {
            byte[] koerper = exchange.getRequestBody().readAllBytes();
            koerperAus.set(new String(koerper, StandardCharsets.UTF_8));
            signaturAus.set(exchange.getRequestHeaders().getFirst("X-VoltPilot-Signature"));
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
        });
        server.start();
        // Der lokale Fänger spricht nur HTTP - die permissive Test-Ziel-Prüfung lässt das Schema
        // ungeprüft durch; die echte Prüfung (nur https) ist in WebhookZielPruefungTest abgedeckt.
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/webhook";
    }

    @Test
    void signiertDenKoerperUndSetztDenErwartetenHeader() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> signatur = new AtomicReference<>();
        String url = starten(200, koerper, signatur);
        WebhookVersandAdapter adapter = new WebhookVersandAdapter(TestZielPruefung.IMMER_ERLAUBT);

        adapter.senden(url, "mein-geheimnis", "{\"text\":\"hallo\"}");

        assertThat(koerper.get()).isEqualTo("{\"text\":\"hallo\"}");
        assertThat(signatur.get()).startsWith("sha256=").isEqualTo("sha256=" + hmac("mein-geheimnis", koerper.get()));
    }

    @Test
    void einErfolgreicherStatusWirftKeineAusnahme() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> signatur = new AtomicReference<>();
        String url = starten(204, koerper, signatur);
        WebhookVersandAdapter adapter = new WebhookVersandAdapter(TestZielPruefung.IMMER_ERLAUBT);

        adapter.senden(url, "geheimnis", "{}");
    }

    @Test
    void vierZehnZehnWirdAlsAbgelaufenEingeordnet() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> signatur = new AtomicReference<>();
        String url = starten(410, koerper, signatur);
        WebhookVersandAdapter adapter = new WebhookVersandAdapter(TestZielPruefung.IMMER_ERLAUBT);

        assertThatThrownBy(() -> adapter.senden(url, "geheimnis", "{}"))
                .isInstanceOf(WebhookException.class)
                .extracting(e -> ((WebhookException) e).abgelaufen())
                .isEqualTo(true);
    }

    @Test
    void einServerfehlerWirdNichtAlsAbgelaufenEingeordnet() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> signatur = new AtomicReference<>();
        String url = starten(503, koerper, signatur);
        WebhookVersandAdapter adapter = new WebhookVersandAdapter(TestZielPruefung.IMMER_ERLAUBT);

        assertThatThrownBy(() -> adapter.senden(url, "geheimnis", "{}"))
                .isInstanceOf(WebhookException.class)
                .extracting(e -> ((WebhookException) e).abgelaufen())
                .isEqualTo(false);
    }

    @Test
    void einUnsicheresZielWirdAlsAbgelaufenEingeordnetOhneEinenVerbindungsversuch() {
        WebhookVersandAdapter adapter = new WebhookVersandAdapter();

        assertThatThrownBy(() -> adapter.senden("http://127.0.0.1/webhook", "geheimnis", "{}"))
                .isInstanceOf(WebhookException.class)
                .extracting(e -> ((WebhookException) e).abgelaufen())
                .isEqualTo(true);
    }

    private static String hmac(String geheimnis, String koerper) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(geheimnis.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] rohe = mac.doFinal(koerper.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(rohe.length * 2);
            for (byte b : rohe) {
                hex.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Nur für diesen Drahtebene-Test: lässt jedes Ziel durch, inklusive Loopback. */
    private enum TestZielPruefung implements WebhookVersandAdapter.ZielValidator {
        IMMER_ERLAUBT;

        @Override
        public URI pruefenUndAufloesen(String url) {
            return URI.create(url);
        }
    }
}
