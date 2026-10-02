package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.ZaehlerrolleAbgelehnt;
import com.voltpilot.api.uems.ZaehlerrolleService;
import com.voltpilot.api.web.dto.ZaehlerrolleDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Zählerrolle einer Messstelle nach der MiSpeL-Festlegung (MP-6, Vertrag
 * {@code docs/contracts/v2/mispel-zaehlerrolle.md}): Z1/Z2/Z3 mit Zählpunkt, Messstellenbetreiber, Eichstatus
 * und Wertequelle, als Fassungen ab einem Tag. Die Arbeit macht {@link ZaehlerrolleService}.
 *
 * <p><b>Rechte</b> wie die übrigen Messstellen-Routen ({@link MessstelleController}): lesen über den Leseweg
 * der Messstelle (außerhalb des Zugriffs 404), setzen mit {@code messstelle.bearbeiten}. Die Anfrage wird streng
 * gelesen: ein unbekanntes Feld ist 400 {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1/messstellen/{id}/zaehlerrolle")
public class MessstelleZaehlerrolleController {

    private final ZaehlerrolleService rollen;
    private final RechtPruefung rechte;
    private final ObjectMapper streng;

    public MessstelleZaehlerrolleController(ZaehlerrolleService rollen, RechtPruefung rechte, ObjectMapper json) {
        this.rollen = rollen;
        this.rechte = rechte;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);
    }

    /**
     * Recht: {@code messstelle.ansehen}. Die Fassung am Tag {@code am} (fehlend = heute), die Größe der
     * Festlegung, die Befunde der Plausibilität mit Fundstelle, das Urteil und alle Fassungen.
     */
    @GetMapping
    public ZaehlerrolleDto.Ansicht ansehen(@PathVariable UUID id,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate am) {
        imZugriff(id);
        return ZaehlerrolleDto.aus(rollen.ansicht(id, am));
    }

    /** Recht: {@code messstelle.bearbeiten}. Eine neue Fassung ab {@code gueltig_ab}; Antwort: die Ansicht an dem Tag. */
    @PutMapping
    @Recht(value = "messstelle.bearbeiten", ziel = RechtZiel.MESSSTELLE)
    public ZaehlerrolleDto.Ansicht setzen(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        ZaehlerrolleService.Aendern a = lies(body);
        rollen.setzen(id, a, ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an.")));
        return ZaehlerrolleDto.aus(rollen.ansicht(id, a.gueltigAb()));
    }

    private void imZugriff(UUID id) {
        rechte.pruefenLesen(RechtZiel.MESSSTELLE, id,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
    }

    private ZaehlerrolleService.Aendern lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw ZaehlerrolleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, ZaehlerrolleService.Aendern.class);
        } catch (UnrecognizedPropertyException e) {
            throw ZaehlerrolleAbgelehnt.anfrage(e.getPropertyName(), "„" + e.getPropertyName() + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName();
            throw ZaehlerrolleAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw ZaehlerrolleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code {code, message, …Fakten}}. */
    @ExceptionHandler(ZaehlerrolleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(ZaehlerrolleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keinTag(MethodArgumentTypeMismatchException e) {
        return abgelehnt(ZaehlerrolleAbgelehnt.anfrage(e.getName(), "„" + e.getName() + "“ ist ein Tag (JJJJ-MM-TT)."));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(ZaehlerrolleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
