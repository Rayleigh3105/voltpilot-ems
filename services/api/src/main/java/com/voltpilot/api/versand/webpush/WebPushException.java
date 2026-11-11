package com.voltpilot.api.versand.webpush;

/**
 * Ein Push-Versand ist fehlgeschlagen. {@link #abgelaufen()} unterscheidet ein ENDGÜLTIG ungültiges
 * Abo (HTTP 404/410 - der Push-Dienst kennt den Endpunkt nicht mehr, §7 "abgelaufene/ungültige Abos
 * aufräumen") von einem vorübergehenden Fehler (Netz, 5xx), der wie jeder andere Fehlschlag erneut
 * versucht wird.
 */
public class WebPushException extends RuntimeException {

    private final int status;

    public WebPushException(int status, String message) {
        super(message);
        this.status = status;
    }

    public WebPushException(int status, String message, Throwable cause) {
        super(message, cause);
        this.status = status;
    }

    public int status() {
        return status;
    }

    public boolean abgelaufen() {
        return status == 404 || status == 410;
    }
}
