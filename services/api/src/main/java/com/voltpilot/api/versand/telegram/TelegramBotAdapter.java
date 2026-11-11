package com.voltpilot.api.versand.telegram;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Der echte Telegram-Bot-Adapter (Alerting Scheibe 6, §9: "Bot-Token kommt zur Laufzeit aus der
 * Umgebung, nie ins Repo"). {@code apiBasis} ist austauschbar, damit ein lokaler HTTP-Fänger diese
 * Klasse selbst auf Drahtebene prüfen kann, OHNE die echte Telegram-API zu berühren (Hausregel).
 *
 * <p>Telegrams Bot-API antwortet auf einen Fehler mit dem HTTP-Status, der zum Fehler passt
 * ({@code 403} "blockiert", {@code 400}/{@code 404} "Chat nicht gefunden") UND einem JSON-Körper
 * {@code {"ok": false, "error_code": …, "description": …}} - der Status allein reicht für
 * {@link TelegramException#abgelaufen()}, der Beschreibungstext geht nur ins Log.
 */
public class TelegramBotAdapter implements TelegramAdapter {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Duration VERBINDUNGS_ZEITGRENZE = Duration.ofSeconds(5);
    private static final Duration GESAMT_ZEITGRENZE = Duration.ofSeconds(8);

    private final String botToken;
    private final String apiBasis;
    private final HttpClient http;

    public TelegramBotAdapter(String botToken) {
        this(botToken, "https://api.telegram.org");
    }

    /** Package-sichtbar für den Drahtebene-Test gegen einen lokalen HTTP-Fänger statt api.telegram.org. */
    TelegramBotAdapter(String botToken, String apiBasis) {
        this.botToken = botToken;
        this.apiBasis = apiBasis;
        this.http = HttpClient.newBuilder().connectTimeout(VERBINDUNGS_ZEITGRENZE).build();
    }

    @Override
    public void senden(String chatId, String text) {
        String koerper = "{\"chat_id\":" + jsonText(chatId) + ",\"text\":" + jsonText(text) + "}";
        HttpRequest request = HttpRequest.newBuilder(URI.create(apiBasis + "/bot" + botToken + "/sendMessage"))
                .header("Content-Type", "application/json")
                .timeout(GESAMT_ZEITGRENZE)
                .POST(HttpRequest.BodyPublishers.ofString(koerper, StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new TelegramException(0, e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new TelegramException(0, "Versand unterbrochen", e);
        }
        if (response.statusCode() / 100 != 2) {
            throw new TelegramException(response.statusCode(),
                    "Telegram antwortete " + response.statusCode() + ": " + beschreibung(response.body()));
        }
    }

    private static String beschreibung(String koerper) {
        try {
            JsonNode node = JSON.readTree(koerper);
            return node.path("description").asText(koerper);
        } catch (IOException e) {
            return koerper;
        }
    }

    private static String jsonText(String text) {
        String sicher = text == null ? "" : text.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", "");
        return "\"" + sicher + "\"";
    }
}
