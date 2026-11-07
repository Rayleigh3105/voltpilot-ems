package com.voltpilot.api.versand.webpush;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.params.ECPublicKeyParameters;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Der Web-Push-Adapter auf Drahtebene gegen einen lokalen HTTP-Fänger statt eines echten
 * Push-Diensts (dasselbe Muster wie {@code TelegramBotAdapterTest}). Vorher hatte
 * {@link WebPushAdapter#senden} nur einen Verbindungsaufbau-Zeitlimit; ein Dienst, der die
 * Verbindung annimmt und dann nie antwortet, ließ den Versand-Thread unbegrenzt hängen. Der zweite
 * Fall hier belegt, dass die neue Antwort-Zeitgrenze diesen Fall tatsächlich beendet - deutlich vor
 * dem Zeitpunkt, zu dem der Fänger selbst irgendwann (zu spät) antworten würde.
 */
class WebPushAdapterTest {

    private HttpServer server;

    @AfterEach
    void beenden() {
        if (server != null) {
            server.stop(0);
        }
    }

    private WebPushAdapter adapter(Duration antwortZeitgrenze) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        return new WebPushAdapter(platzhalter(65), platzhalterPrivatschluessel(), "mailto:test@voltpilot.de",
                antwortZeitgrenze);
    }

    private WebPushAdapter.Abo abo(String pfad) throws Exception {
        return new WebPushAdapter.Abo(
                "http://127.0.0.1:" + server.getAddress().getPort() + pfad, gueltigerP256dh(), gueltigerAuth());
    }

    @Test
    void sendetErfolgreichAnEinenLokalenTestEndpunkt() throws Exception {
        AtomicReference<String> ttl = new AtomicReference<>();
        WebPushAdapter adapter = adapter(Duration.ofSeconds(5));
        server.createContext("/push", exchange -> {
            ttl.set(exchange.getRequestHeaders().getFirst("TTL"));
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(201, -1);
            exchange.close();
        });
        server.start();

        adapter.senden(abo("/push"), "{\"titel\":\"x\"}");

        assertThat(ttl.get()).isEqualTo(String.valueOf(Duration.ofHours(4).toSeconds()));
    }

    @Test
    void eineVerbindungOhneAntwortBrichtNachDerZeitgrenzeAbStattUnbegrenztZuHaengen() throws Exception {
        // Der Fänger NIMMT die Verbindung an, antwortet aber erst, lange nachdem ein Client längst
        // aufgegeben haben müsste - das PRÜFT genau den Unterschied zwischen Verbindungsaufbau- und
        // Antwort-Zeitgrenze (die erste schützt hier nicht).
        WebPushAdapter adapter = adapter(Duration.ofMillis(300));
        server.createContext("/haengt", exchange -> {
            try {
                new CountDownLatch(1).await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();

        long start = System.nanoTime();
        assertThatThrownBy(() -> adapter.senden(abo("/haengt"), "{\"titel\":\"x\"}"))
                .isInstanceOf(WebPushException.class);
        long dauerMs = (System.nanoTime() - start) / 1_000_000;

        // Deutlich unter den 5 s, die der Fänger brauchen würde - sonst hätte die Zeitgrenze nicht gegriffen.
        assertThat(dauerMs).isLessThan(3_000);
    }

    private static String gueltigerP256dh() {
        SecureRandom zufall = new SecureRandom();
        AsymmetricCipherKeyPair schluesselpaar = P256.neuesSchluesselpaar(zufall);
        byte[] unkomprimiert65 = P256.unkomprimiertePunktBytes((ECPublicKeyParameters) schluesselpaar.getPublic());
        return Base64Url.encode(unkomprimiert65);
    }

    private static String gueltigerAuth() {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[16]);
    }

    private static String platzhalter(int laenge) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[laenge]);
    }

    /** BouncyCastle verlangt einen Skalar in [1, n-1] - lauter Nullen wären ungültig. */
    private static String platzhalterPrivatschluessel() {
        byte[] skalarEins = new byte[32];
        skalarEins[31] = 1;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(skalarEins);
    }
}
