package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.BilanzAbgelehnt;
import com.voltpilot.api.uems.BilanzService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.BilanzDto;
import java.net.URI;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Bilanz je Anlage (UEMS AP-10 IP-9, E3/E18): Zufluss, Abfluss, zugeordnet und Rest je Hauptzähler —
 * der Rest je Tag aus der Stellung, nie gespeichert — und der Vorschlag „Rest anlegen“. Die Arbeit macht
 * {@link BilanzService}, jede Zahl {@code BilanzAbleitung}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die Mandanten-RLS —
 * eine fremde Anlage ist 404, nie 403. Jede Route nennt im Kommentar ihre Kennung aus
 * {@code docs/contracts/v2/rechte-matrix.json} ({@code RechteKennungenDerRoutenTest}); durchgesetzt wird sie
 * hier nicht.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein unbekanntes Feld (auch camelCase) ist 400
 * {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/bilanz")
public class BilanzController {

    private final BilanzService dienst;
    private final ObjectMapper streng;

    public BilanzController(BilanzService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code messstelle.ansehen} (AP-10 §4.10: „Lesen der Bilanz, Verteilung und Herkunft“). Die
     * Periode {@code tag} · {@code monat} (Vorgabe) · {@code jahr}, die {@code am} enthält (Vorgabe: heute
     * in der Zeitzone des Standorts).
     */
    @GetMapping
    public BilanzDto.Bilanz bilanz(@PathVariable UUID siteId, @RequestParam(required = false) String periode,
            @RequestParam(required = false) String am) {
        return dienst.bilanz(siteId, periode, tag(am));
    }

    /**
     * Recht: {@code messstelle.formel} (AP-10 §4.10 — eine berechnete Messstelle anlegen). Bestätigt den
     * Vorschlag „Rest anlegen“ eines Hauptzählers: 201 mit der neuen Messstelle, 200 {@code neu = false},
     * wenn er schon einen Rest hat — es entsteht nie ein zweiter.
     */
    @PostMapping("/rest")
    public ResponseEntity<BilanzDto.RestAngelegt> restAnlegen(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        BilanzDto.RestAngelegt r = dienst.restAnlegen(siteId, lies(body), akteur(auth));
        if (!r.neu()) {
            return ResponseEntity.ok(r);
        }
        return ResponseEntity.created(URI.create("/api/v1/messstellen/" + r.messstelle().id())).body(r);
    }

    // ----------------------------------------------------------------------------- Gerüst

    private BilanzDto.RestAnlegen lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw BilanzAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, BilanzDto.RestAnlegen.class);
        } catch (UnrecognizedPropertyException e) {
            throw BilanzAbgelehnt.anfrage(pfad(e), "„" + pfad(e) + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            throw BilanzAbgelehnt.anfrage(pfad(e), "„" + pfad(e) + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw BilanzAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    private static String pfad(JsonMappingException e) {
        StringBuilder s = new StringBuilder();
        for (JsonMappingException.Reference r : e.getPath()) {
            if (r.getFieldName() != null) {
                s.append(s.isEmpty() ? "" : ".").append(r.getFieldName());
            }
        }
        return s.toString();
    }

    private static LocalDate tag(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw BilanzAbgelehnt.anfrage("am", "„am“ ist ein Tag (JJJJ-MM-TT).");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}}. */
    @ExceptionHandler(BilanzAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BilanzAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID ohne UUID-Form: dieselbe Form wie jede andere Ablehnung. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineForm(MethodArgumentTypeMismatchException e) {
        return abgelehnt(BilanzAbgelehnt.anfrage(e.getName(), "„" + e.getName() + "“ hat nicht die erwartete Form."));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(BilanzAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    /** 401/403/404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
