package com.voltpilot.api.geraetesuche;

import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpStatus;

/**
 * Eine abgelehnte Anfrage an die Gerätesuche (OpenAPI {@code GeraetesucheAbgelehnt}): nichts gesendet, keine Suche
 * angelegt. Der Satz ist der für den Kunden; die Fakten nur beim Grund, zu dem sie gehören.
 */
public final class GeraetesucheAbgelehnt extends RuntimeException {

    private final HttpStatus status;
    private final String code;
    private final UUID suchId;
    private final Instant zuletztGesehen;
    private final Instant wiederAb;

    private GeraetesucheAbgelehnt(HttpStatus status, String code, String message, UUID suchId, Instant zuletztGesehen,
            Instant wiederAb) {
        super(message, null, false, false);
        this.status = status;
        this.code = code;
        this.suchId = suchId;
        this.zuletztGesehen = zuletztGesehen;
        this.wiederAb = wiederAb;
    }

    /** Fremde Anlage, Box nicht an dieser Anlage, unbekannte Suche — nie 403. */
    public static GeraetesucheAbgelehnt nichtGefunden() {
        return new GeraetesucheAbgelehnt(HttpStatus.NOT_FOUND, "nicht_gefunden",
                "Diese Anlage, Box oder Suche gibt es hier nicht.", null, null, null);
    }

    public static GeraetesucheAbgelehnt anfrageUngueltig(String warum) {
        return new GeraetesucheAbgelehnt(HttpStatus.BAD_REQUEST, "anfrage_ungueltig", warum, null, null, null);
    }

    public static GeraetesucheAbgelehnt laeuftSchon(UUID suchId) {
        return new GeraetesucheAbgelehnt(HttpStatus.CONFLICT, "laeuft_schon",
                "Diese Box sucht gerade schon. Sie können der laufenden Suche zusehen.", suchId, null, null);
    }

    public static GeraetesucheAbgelehnt nichtUnterstuetzt() {
        return new GeraetesucheAbgelehnt(HttpStatus.CONFLICT, "nicht_unterstuetzt",
                "Update nötig für: Gerätesuche. Diese Box kann noch nicht nach Geräten suchen.", null, null, null);
    }

    /** Auch, wenn der Auftrag die Box nicht erreicht hat: dann ist sie für die Cloud gerade nicht erreichbar. */
    public static GeraetesucheAbgelehnt boxOffline(Instant zuletztGesehen) {
        return new GeraetesucheAbgelehnt(HttpStatus.CONFLICT, "box_offline",
                "Die Box ist gerade nicht erreichbar. Versuchen Sie es erneut, wenn sie wieder verbunden ist.", null,
                zuletztGesehen, null);
    }

    public static GeraetesucheAbgelehnt zuOft(Instant wiederAb) {
        return new GeraetesucheAbgelehnt(HttpStatus.TOO_MANY_REQUESTS, "zu_oft",
                "Diese Box hat in der letzten Stunde schon sechsmal gesucht. Die nächste Suche geht später wieder.",
                null, null, wiederAb);
    }

    public HttpStatus status() {
        return status;
    }

    public String code() {
        return code;
    }

    public UUID suchId() {
        return suchId;
    }

    public Instant zuletztGesehen() {
        return zuletztGesehen;
    }

    public Instant wiederAb() {
        return wiederAb;
    }
}
