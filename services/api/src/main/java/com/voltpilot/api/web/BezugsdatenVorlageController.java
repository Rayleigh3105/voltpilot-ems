package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.BezugsdatenVorlageService;
import com.voltpilot.api.uems.BezugsgroesseAbgelehnt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.BezugsdatenVorlageDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** Geteilte Zuordnungs-Vorlagen des Kundenbereichs; Fassungen werden nie überschrieben (AP-09 IP-14). */
@RestController
@RequestMapping("/api/v1/bezugsdaten/vorlagen")
public class BezugsdatenVorlageController {

    private final BezugsdatenVorlageService vorlagen;
    private final ObjectMapper streng;

    public BezugsdatenVorlageController(BezugsdatenVorlageService vorlagen, ObjectMapper json) {
        this.vorlagen = vorlagen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
    }

    /**
     * Lesend: keine eigene Kennung; Mandanten-RLS begrenzt die Liste auf den Kundenbereich, der Zugriff auf die
     * Vorlagen, deren Bezüge alle sichtbar sind (AP-09 E12).
     */
    @GetMapping
    public BezugsdatenVorlageDto.Liste liste() {
        return vorlagen.liste();
    }

    /** Recht: {@code bezugsgroesse.importieren}. Ohne ID neu, mit ID eine neue Fassung. */
    @PostMapping
    @Recht(value = "bezugsgroesse.importieren", ziel = RechtZiel.DIENST)
    public ResponseEntity<BezugsdatenVorlageDto.Vorlage> speichern(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        BezugsdatenVorlageDto.Anfrage anfrage;
        try {
            anfrage = body == null ? null : streng.treeToValue(body, BezugsdatenVorlageDto.Anfrage.class);
        } catch (UnrecognizedPropertyException e) {
            throw BezugsgroesseAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            List<String> teile = e.getPath().stream()
                    .map(r -> r.getFieldName() != null ? r.getFieldName() : String.valueOf(r.getIndex())).toList();
            throw BezugsgroesseAbgelehnt.anfrage(teile.isEmpty() ? "anfrage" : String.join(".", teile));
        } catch (JsonProcessingException e) {
            throw BezugsgroesseAbgelehnt.anfrage("anfrage");
        }
        BezugsdatenVorlageDto.Vorlage neu = vorlagen.speichern(anfrage, akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/bezugsdaten/vorlagen/" + neu.vorlageId())).body(neu);
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    @ExceptionHandler(BezugsgroesseAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BezugsgroesseAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }
}
