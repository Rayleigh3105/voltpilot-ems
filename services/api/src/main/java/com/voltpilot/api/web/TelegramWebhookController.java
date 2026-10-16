package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.versand.ZustellwegService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der Telegram-Update-Webhook (Alerting Scheibe 6, Konzept §7 Scheibe 6 Punkt 2): Telegram ruft ihn
 * auf, sobald die Person den Start-Link geöffnet und den Bot gestartet hat - die Nachricht
 * {@code /start <token>} verknüpft die Chat-ID mit der wartenden Person ({@link ZustellwegService#telegramVerbindungBestaetigen}).
 *
 * <p>KEINE Anmeldung (Telegram selbst ruft ihn auf, ohne Benutzer-Token) - geschützt über Telegrams
 * eigenen {@code secret_token}-Mechanismus ({@code X-Telegram-Bot-Api-Secret-Token}, beim
 * {@code setWebhook}-Aufruf einmalig hinterlegt); ein leerer Geheimwert (lokal/Testlauf) lässt jeden
 * Aufruf durch - die eigentliche Sicherung bleibt der 256-Bit-Verbindungs-Token selbst, den nur die
 * anfordernde Person kennt. Antwortet IMMER mit 200, auch wenn der Token unbekannt/abgelaufen war
 * oder die Nachricht kein {@code /start} trug - Telegram wiederholt einen nicht-2xx-Update sonst
 * endlos.
 */
@RestController
@RequestMapping("/api/v1/zustellwege/telegram")
public class TelegramWebhookController {

    private static final String START_PRAEFIX = "/start ";

    private final ZustellwegService zustellwege;
    private final String webhookSecret;

    public TelegramWebhookController(ZustellwegService zustellwege,
            @Value("${voltpilot.telegram.webhook-secret:}") String webhookSecret) {
        this.zustellwege = zustellwege;
        this.webhookSecret = webhookSecret;
    }

    @PostMapping("/webhook")
    public ResponseEntity<Void> webhook(@RequestBody JsonNode update,
            @RequestHeader(value = "X-Telegram-Bot-Api-Secret-Token", required = false) String secretHeader) {
        if (!webhookSecret.isBlank() && !webhookSecret.equals(secretHeader)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        String text = update.path("message").path("text").asText("");
        String chatId = update.path("message").path("chat").path("id").asText(null);
        if (chatId != null && text.startsWith(START_PRAEFIX)) {
            String token = text.substring(START_PRAEFIX.length()).trim();
            if (!token.isEmpty()) {
                zustellwege.telegramVerbindungBestaetigen(token, chatId);
            }
        }
        return ResponseEntity.ok().build();
    }
}
