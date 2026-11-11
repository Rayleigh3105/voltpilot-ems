package com.voltpilot.api.versand.telegram;

/**
 * Ein Telegram-Versand ist fehlgeschlagen. {@link #abgelaufen()} unterscheidet ein ENDGÜLTIG totes
 * Ziel - die Person hat den Bot blockiert (403) oder der Chat existiert nicht mehr (400/404,
 * derselbe Vertrag wie {@code WebPushException}, §7 "abgelaufene/ungültige Ziele aufräumen") - von
 * einem vorübergehenden Fehler (Netz, 429, 5xx), der wie jeder andere Fehlschlag erneut versucht wird.
 */
public class TelegramException extends RuntimeException {

    private final int status;

    public TelegramException(int status, String message) {
        super(message);
        this.status = status;
    }

    public TelegramException(int status, String message, Throwable cause) {
        super(message, cause);
        this.status = status;
    }

    public int status() {
        return status;
    }

    public boolean abgelaufen() {
        return status == 400 || status == 403 || status == 404;
    }
}
