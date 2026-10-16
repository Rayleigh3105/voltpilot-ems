package com.voltpilot.api.versand.telegram;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Der Telegram-Bot-Adapter auf Drahtebene gegen einen lokalen HTTP-Fänger statt api.telegram.org
 * (Hausregel dieser Scheibe: "Tests gegen einen Stub-Adapter, nie gegen die echte Telegram-API") -
 * über den package-sichtbaren Konstruktor mit austauschbarer {@code apiBasis}. Kein Docker nötig.
 */
class TelegramBotAdapterTest {

    private HttpServer server;

    @AfterEach
    void beenden() {
        if (server != null) {
            server.stop(0);
        }
    }

    private TelegramBotAdapter starten(int status, String antwortKoerper, AtomicReference<String> koerperAus,
            AtomicReference<String> pfadAus) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            pfadAus.set(exchange.getRequestURI().getPath());
            koerperAus.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = antwortKoerper.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        return new TelegramBotAdapter("test-token", "http://127.0.0.1:" + server.getAddress().getPort());
    }

    @Test
    void sendetAnDenRichtigenPfadMitChatIdUndText() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> pfad = new AtomicReference<>();
        TelegramBotAdapter adapter = starten(200, "{\"ok\":true}", koerper, pfad);

        adapter.senden("12345", "Hallo Welt");

        assertThat(pfad.get()).isEqualTo("/bottest-token/sendMessage");
        assertThat(koerper.get()).isEqualTo("{\"chat_id\":\"12345\",\"text\":\"Hallo Welt\"}");
    }

    @Test
    void vierHundertDreiBlockiertWirdAlsAbgelaufenEingeordnet() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> pfad = new AtomicReference<>();
        TelegramBotAdapter adapter = starten(403,
                "{\"ok\":false,\"error_code\":403,\"description\":\"Forbidden: bot was blocked by the user\"}",
                koerper, pfad);

        assertThatThrownBy(() -> adapter.senden("12345", "x"))
                .isInstanceOf(TelegramException.class)
                .hasMessageContaining("blocked by the user")
                .extracting(e -> ((TelegramException) e).abgelaufen())
                .isEqualTo(true);
    }

    @Test
    void vierHundertChatNichtGefundenWirdAlsAbgelaufenEingeordnet() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> pfad = new AtomicReference<>();
        TelegramBotAdapter adapter = starten(400, "{\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: chat not found\"}",
                koerper, pfad);

        assertThatThrownBy(() -> adapter.senden("12345", "x"))
                .isInstanceOf(TelegramException.class)
                .extracting(e -> ((TelegramException) e).abgelaufen())
                .isEqualTo(true);
    }

    @Test
    void zuVieleAnfragenWirdNichtAlsAbgelaufenEingeordnet() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> pfad = new AtomicReference<>();
        TelegramBotAdapter adapter = starten(429, "{\"ok\":false,\"error_code\":429,\"description\":\"Too Many Requests\"}",
                koerper, pfad);

        assertThatThrownBy(() -> adapter.senden("12345", "x"))
                .isInstanceOf(TelegramException.class)
                .extracting(e -> ((TelegramException) e).abgelaufen())
                .isEqualTo(false);
    }

    @Test
    void einErfolgreicherStatusWirftKeineAusnahme() throws IOException {
        AtomicReference<String> koerper = new AtomicReference<>();
        AtomicReference<String> pfad = new AtomicReference<>();
        TelegramBotAdapter adapter = starten(200, "{\"ok\":true}", koerper, pfad);

        adapter.senden("12345", "x");
    }
}
