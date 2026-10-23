package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Die Anfrage-Kennung ({@value #KOPF}) für das Anlegen (Anlage-Flow a1, Befund B3): ging die Antwort
 * auf „Weiter“ verloren, legte das Wiederholen die Anlage doppelt an. Das Portal sendet je Formular
 * eine feste Kennung; die api merkt sich Kennung, Fingerabdruck der Anfrage und Antwort je
 * Kundenbereich und Route (Tabelle {@code anfrage_kennung}, 24 h) und antwortet bei derselben
 * Kennung mit derselben Antwort, statt ein zweites Mal anzulegen.
 *
 * <p>Ohne den Kopf bleibt alles, wie es war. Eine Kennung mit einer ANDEREN Anfrage ist ein Fehler
 * (422 {@code anfrage_kennung_anders}), nie eine fremde Antwort. Gemerkt wird nur der Erfolg: eine
 * Ablehnung (400, 409, 422) darf der Kunde mit derselben Kennung korrigiert wiederholen.
 *
 * <p>Gleichzeitige Anfragen mit derselben Kennung reiht {@link #sperren} bis zum Ende der Transaktion
 * hintereinander (Advisory-Lock); wer danach kommt, findet die Antwort.
 */
@Component
public class AnfrageKennungen {

    /** Der Kopf, wie ihn das Portal sendet (der verbreitete Name, IETF-Entwurf „Idempotency-Key“). */
    public static final String KOPF = "Idempotency-Key";

    private static final Pattern FORM = Pattern.compile("[A-Za-z0-9:._-]{8,200}");

    /** Eine gemerkte Antwort. */
    public record Gemerkt(int status, String antwort) {
    }

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public AnfrageKennungen(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Die Kennung aus dem Kopf - {@code null} ohne Kopf; eine falsche Form ist 400. */
    public static String kennung(String kopf) {
        if (kopf == null || kopf.isBlank()) {
            return null;
        }
        String k = kopf.trim();
        if (!FORM.matcher(k).matches()) {
            throw new Abgelehnt(HttpStatus.BAD_REQUEST, "anfrage_kennung_ungueltig",
                    "Die Anfrage-Kennung hat 8 bis 200 Zeichen aus Buchstaben, Ziffern und : . _ -");
        }
        return k;
    }

    /** Der Fingerabdruck der gelesenen Anfrage (SHA-256 über ihre JSON-Form). */
    public String fingerabdruck(Object anfrage) {
        try {
            byte[] roh = json.writeValueAsBytes(anfrage);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(roh));
        } catch (JsonProcessingException | NoSuchAlgorithmException e) {
            throw new IllegalStateException("Fingerabdruck der Anfrage", e);
        }
    }

    /** Reiht gleichzeitige Anfragen mit derselben Kennung hintereinander - nur in einer Transaktion. */
    public void sperren(String route, String kennung) {
        jdbc.queryForList("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                mandant() + "|" + route + "|" + kennung);
    }

    /**
     * Die gemerkte Antwort zu dieser Kennung (höchstens 24 h alt) - oder leer. Dieselbe Kennung mit
     * einer anderen Anfrage ist 422.
     */
    public Optional<Gemerkt> gemerkt(String route, String kennung, String fingerabdruck) {
        List<Map<String, Object>> zeilen = jdbc.queryForList("""
                SELECT fingerabdruck, status, antwort FROM anfrage_kennung
                 WHERE tenant_id = ? AND route = ? AND kennung = ?
                   AND angelegt_am > now() - interval '24 hours'""", mandant(), route, kennung);
        if (zeilen.isEmpty()) {
            return Optional.empty();
        }
        Map<String, Object> z = zeilen.get(0);
        if (!fingerabdruck.equals(z.get("fingerabdruck"))) {
            throw new Abgelehnt(HttpStatus.UNPROCESSABLE_ENTITY, "anfrage_kennung_anders",
                    "Diese Anfrage wurde schon mit anderen Angaben gesendet. Bitte laden Sie die Seite neu.");
        }
        return Optional.of(new Gemerkt(((Number) z.get("status")).intValue(), (String) z.get("antwort")));
    }

    /** Merkt die Antwort (und räumt abgelaufene Kennungen des Kundenbereichs ab). */
    public void merken(String route, String kennung, String fingerabdruck, HttpStatus status, Object antwort) {
        String text;
        try {
            text = json.writeValueAsString(antwort);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Antwort merken", e);
        }
        UUID tenant = mandant();
        jdbc.update("DELETE FROM anfrage_kennung WHERE tenant_id = ? AND angelegt_am <= now() - interval '24 hours'",
                tenant);
        jdbc.update("""
                INSERT INTO anfrage_kennung (tenant_id, route, kennung, fingerabdruck, status, antwort)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (tenant_id, route, kennung) DO UPDATE
                   SET fingerabdruck = EXCLUDED.fingerabdruck, status = EXCLUDED.status,
                       antwort = EXCLUDED.antwort, angelegt_am = now()""",
                tenant, route, kennung, fingerabdruck, status.value(), text);
    }

    /** Die gemerkte Antwort, wie sie das erste Mal ging - mit dem Kopf {@code Idempotent-Replayed}. */
    public static ResponseEntity<String> antwort(Gemerkt g) {
        return ResponseEntity.status(g.status()).contentType(MediaType.APPLICATION_JSON)
                .header("Idempotent-Replayed", "true").body(g.antwort());
    }

    private static UUID mandant() {
        UUID t = TenantContext.get();
        if (t == null) {
            throw new IllegalStateException("Anfrage-Kennung ohne Kundenbereich");
        }
        return t;
    }

    /** Eine Ablehnung der Anfrage-Kennung: {@code {code, message}}. */
    public static final class Abgelehnt extends RuntimeException {
        private final HttpStatus status;
        private final String code;

        Abgelehnt(HttpStatus status, String code, String message) {
            super(message);
            this.status = status;
            this.code = code;
        }
    }

    /** Die Antwort-Form der Ablehnung an den Routen, die eine Kennung annehmen. */
    @RestControllerAdvice(assignableTypes = {SiteController.class, StandortController.class})
    public static class AbgelehntHandler {
        @ExceptionHandler(Abgelehnt.class)
        public ResponseEntity<Map<String, Object>> abgelehnt(Abgelehnt e) {
            return ResponseEntity.status(e.status).body(Map.of("code", e.code, "message", e.getMessage()));
        }
    }
}
