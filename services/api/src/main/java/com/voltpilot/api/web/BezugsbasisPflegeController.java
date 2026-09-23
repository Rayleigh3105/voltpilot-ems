package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.BezugsbasisPflegeService;
import com.voltpilot.api.uems.BezugsbasisPflegeService.Abgelehnt;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Pflege einer laufenden Bezugsbasis (UEMS AP-17 IP-17, F4/F5, R13; Vertrag {@code docs/contracts/v2/bezugsbasis.md}
 * „Routen der Pflege“): „geprüft, bleibt“, beenden — und die Übersicht am Unternehmen. Anlegen, Fassungen und Freigabe
 * sind {@code BezugsbasisController} (IP-7/IP-8), nicht hier.
 *
 * <p><b>Rechte:</b> Schreiben {@code bezugsbasis.verwalten} am Geltungsbereich der Kennzahl (der Interceptor prüft vor,
 * die genaue Prüfung macht {@code KennzahlService.fuerBezugsbasis}, wie IP-7); Lesen {@code bezugsbasis.ansehen} über die
 * Sichtbarkeit der Kennzahl. Die Anfrage wird streng gelesen: ein unbekanntes Feld ist 400 {@code anfrage_ungueltig}.
 */
@RestController
public class BezugsbasisPflegeController {

    private static final Set<String> BLEIBT = Set.of("begruendung");
    private static final Set<String> BEENDEN = Set.of("tag", "grund", "begruendung", "rueckwirkend");

    private final BezugsbasisPflegeService pflege;

    public BezugsbasisPflegeController(BezugsbasisPflegeService pflege) {
        this.pflege = pflege;
    }

    /**
     * Recht: {@code bezugsbasis.verwalten}. F5 „geprüft, bleibt“: Begründung (10–500 Zeichen) als Protokolleintrag; die
     * Frist beginnt heute neu, offene Anstöße der laufenden Fassung gelten als beantwortet ({@code bleibt}).
     */
    @PostMapping("/api/v1/kennzahlen/{id}/bezugsbasen/{bid}/bleibt")
    @Recht(value = "bezugsbasis.verwalten", ziel = RechtZiel.DIENST)
    public BezugsbasisPflegeService.Zustand bleibt(@PathVariable UUID id, @PathVariable UUID bid,
            @RequestBody JsonNode body, Authentication auth) {
        streng(body, BLEIBT);
        return pflege.bleibt(id, bid, text(body, "begruendung"), akteur(auth));
    }

    /**
     * Recht: {@code bezugsbasis.verwalten}. F4 beenden: {@code tag} (letzter Tag, JJJJ-MM-TT), {@code grund} (A1),
     * {@code begruendung} (10–500), {@code rueckwirkend} für einen Tag vor heute. Nie gelöscht.
     */
    @PostMapping("/api/v1/kennzahlen/{id}/bezugsbasen/{bid}/beenden")
    @Recht(value = "bezugsbasis.verwalten", ziel = RechtZiel.DIENST)
    public BezugsbasisPflegeService.Zustand beenden(@PathVariable UUID id, @PathVariable UUID bid,
            @RequestBody JsonNode body, Authentication auth) {
        streng(body, BEENDEN);
        JsonNode r = body.get("rueckwirkend");
        if (r != null && !r.isNull() && !r.isBoolean()) {
            throw new Abgelehnt400("rueckwirkend");
        }
        return pflege.beenden(id, bid, text(body, "tag"), text(body, "grund"), text(body, "begruendung"),
                r != null && r.asBoolean(false), akteur(auth));
    }

    /**
     * Recht: {@code bezugsbasis.ansehen} (über die Sichtbarkeit der Kennzahl). Die Übersicht am Unternehmen: freigegeben ·
     * vorläufig · Anstoß liegt vor · Überprüfung fällig, dazu die fälligen Basen. Frist beim Abruf abgeleitet (R13).
     */
    @GetMapping("/api/v1/bezugsbasen/uebersicht")
    public BezugsbasisPflegeService.Uebersicht uebersicht() {
        return pflege.uebersicht();
    }

    // ------------------------------------------------------------------------------ Gerüst

    /** Ein Feld, das es an der Route nicht gibt, oder ein Feld falschen Typs. */
    static final class Abgelehnt400 extends RuntimeException {
        final String feld;

        Abgelehnt400(String feld) {
            super("Die Anfrage ist ungültig.");
            this.feld = feld;
        }
    }

    private static void streng(JsonNode body, Set<String> erlaubt) {
        if (body == null || !body.isObject()) {
            throw new Abgelehnt400("");
        }
        for (Iterator<String> it = body.fieldNames(); it.hasNext(); ) {
            String f = it.next();
            if (!erlaubt.contains(f)) {
                throw new Abgelehnt400(f);
            }
        }
    }

    private static String text(JsonNode body, String feld) {
        JsonNode n = body.get(feld);
        if (n == null || n.isNull()) {
            return null;
        }
        if (!n.isTextual()) {
            throw new Abgelehnt400(feld);
        }
        return n.asText();
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    @ExceptionHandler(Abgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(Abgelehnt e) {
        return antwort(e.status(), e.code(), e.getMessage(), Map.of());
    }

    /** Kennzahl nicht da (404) bzw. Recht fehlt (403 mit {@code rolle_noetig}) — derselbe Satz wie an der Kennzahl. */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> kennzahl(KennzahlAbgelehnt e) {
        return antwort(e.status(), e.code(), e.getMessage(), e.fakten());
    }

    @ExceptionHandler(Abgelehnt400.class)
    public ResponseEntity<Map<String, Object>> ungueltig(Abgelehnt400 e) {
        return antwort(400, "anfrage_ungueltig", e.getMessage(), Map.of("feld", e.feld));
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return antwort(404, "nicht_gefunden", "Diese Bezugsbasis gibt es nicht.", Map.of());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return antwort(400, "anfrage_ungueltig", "Die Anfrage ist ungültig.", Map.of("feld", ""));
    }

    private static ResponseEntity<Map<String, Object>> antwort(int status, String code, String satz,
            Map<String, Object> fakten) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", satz);
        body.putAll(fakten);
        return ResponseEntity.status(status).body(body);
    }
}
