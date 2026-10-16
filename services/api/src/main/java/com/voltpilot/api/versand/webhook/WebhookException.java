package com.voltpilot.api.versand.webhook;

/**
 * Ein Webhook-Versand ist fehlgeschlagen. {@link #abgelaufen()} unterscheidet ein ENDGÜLTIG totes
 * Ziel - HTTP 404/410 (derselbe Vertrag wie {@code WebPushException}, §7 "abgelaufene/ungültige
 * Ziele aufräumen") oder ein Ziel, das die SSRF-Prüfung nicht (mehr) besteht ({@link #ZIEL_UNSICHER})
 * - von einem vorübergehenden Fehler (Netz, 5xx), der wie jeder andere Fehlschlag erneut versucht
 * wird. Ein unsicheres Ziel wird absichtlich wie ein abgelaufenes behandelt: ein erneuter Versuch
 * würde nur denselben gesperrten Adressbereich erneut anfragen.
 */
public class WebhookException extends RuntimeException {

    /** Kein echter HTTP-Status - die SSRF-Prüfung hat das Ziel schon vor dem Verbindungsaufbau gesperrt. */
    public static final int ZIEL_UNSICHER = -1;

    private final int status;

    public WebhookException(int status, String message) {
        super(message);
        this.status = status;
    }

    public WebhookException(int status, String message, Throwable cause) {
        super(message, cause);
        this.status = status;
    }

    public int status() {
        return status;
    }

    public boolean abgelaufen() {
        return status == 404 || status == 410 || status == ZIEL_UNSICHER;
    }
}
