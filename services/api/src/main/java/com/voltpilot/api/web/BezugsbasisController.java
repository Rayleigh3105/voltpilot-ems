package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.BezugsbasisAbgelehnt;
import com.voltpilot.api.uems.BezugsbasisService;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.BezugsbasisDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Bezugsbasis anlegen und eine Fassung als Entwurf mit Vorschau bilden, die gespeicherte Kopie lesen (UEMS AP-17
 * IP-7, Vertrag {@code bezugsbasis.md} „Routen“). Freigeben, Ablehnen, Beenden und der Verantwortliche folgen mit IP-8.
 */
@RestController
@RequestMapping("/api/v1/kennzahlen/{id}/bezugsbasen")
public class BezugsbasisController {

    private final BezugsbasisService bezugsbasen;
    private final ObjectMapper streng;

    public BezugsbasisController(BezugsbasisService bezugsbasen, ObjectMapper json) {
        this.bezugsbasen = bezugsbasen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code bezugsbasis.verwalten} an der Geltung der Kennzahl (Standort-Zaun über die Kennzahl). Legt die
     * Bezugsbasis BB-… an (B1: höchstens eine laufende je Kennzahl, sonst 409 {@code bezugsbasis_laeuft}); der
     * Verantwortliche ist der der Kennzahl (B4).
     */
    @PostMapping
    @Recht(value = "bezugsbasis.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<BezugsbasisDto.Bezugsbasis> anlegen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        BezugsbasisDto.Bezugsbasis neu = bezugsbasen.anlegen(id, lies(body, BezugsbasisDto.Anlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/kennzahlen/" + id + "/bezugsbasen/" + neu.id())).body(neu);
    }

    /** Recht: {@code bezugsbasis.ansehen}. Die Bezugsbasis mit ihren Fassungen; Sichtbarkeit über die Kennzahl (404). */
    @GetMapping("/{bid}")
    public BezugsbasisDto.Bezugsbasis eine(@PathVariable UUID id, @PathVariable UUID bid) {
        return bezugsbasen.eine(id, bid);
    }

    /**
     * Recht: {@code bezugsbasis.verwalten} an der Geltung der Kennzahl. Bildet eine Fassung als Entwurf mit Vorschau
     * (F1): Referenzperiode P1, Methode {@code verhaeltnis} (andere 422 {@code methode_noch_nicht_gebaut}), Grundlage
     * als Kopie mit Prüfsumme (F3), Basiswert Σ ÷ Σ (M1), Datenlage P2/P3. Ein offener Entwurf wird neu gebildet.
     */
    @PostMapping("/{bid}/fassungen")
    @Recht(value = "bezugsbasis.verwalten", ziel = RechtZiel.DIENST)
    public BezugsbasisDto.Fassung entwerfen(@PathVariable UUID id, @PathVariable UUID bid,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return bezugsbasen.entwerfen(id, bid, lies(body, BezugsbasisDto.Entwurf.class), akteur(auth));
    }

    /** Recht: {@code bezugsbasis.ansehen}. Die gespeicherte Fassung — byte-gleich zur Vorschau ihres Entwurfs. */
    @GetMapping("/{bid}/fassungen/{n}")
    public BezugsbasisDto.Fassung fassung(@PathVariable UUID id, @PathVariable UUID bid, @PathVariable int n) {
        return bezugsbasen.fassung(id, bid, n);
    }

    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw anfrage("");
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw anfrage(e.getPropertyName());
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw anfrage("");
        }
    }

    private static BezugsbasisAbgelehnt anfrage(String feld) {
        return new BezugsbasisAbgelehnt(400, "anfrage_ungueltig", "Die Anfrage ist so nicht lesbar.",
                Map.of("feld", feld));
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(BezugsbasisAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BezugsbasisAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Die Kennzahl selbst lehnt ab (404 außerhalb der Sicht, 403 ohne Recht an ihrer Geltung). */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> kennzahl(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new BezugsbasisAbgelehnt(404, "nicht_gefunden", "Diese Bezugsbasis gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(anfrage(""));
    }
}
