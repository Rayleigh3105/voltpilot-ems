package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.EnergiemanagementTeilVermerkService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.EnergiemanagementTeilVermerkDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
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
 * UEMS AP-19, Konzept Nachweisen n1, Runde 2, Entscheid 5: „Trifft bei uns zurzeit nicht zu“ je Teil des Überblicks.
 * Die Arbeit macht {@link EnergiemanagementTeilVermerkService}; im Verzeichnis steht jeder Vermerk über
 * {@code TeilVermerkVerzeichnis}.
 *
 * <p><b>Rechte:</b> Schreibrouten {@code energiemanagement.verwalten} am Unternehmen (403 {@code recht_fehlt}, auch
 * „Einsicht“); Lesen {@code energiemanagement.ansehen} als Kennung im Kommentar, nur unternehmensweit sichtbar. Ein
 * Vermerk wird nie gelöscht: es gibt keine Löschroute, „aufheben“ beendet ihn einmal.
 */
@RestController
@RequestMapping("/api/v1/energiemanagement")
public class EnergiemanagementTeilVermerkController {

    private final EnergiemanagementTeilVermerkService dienst;
    private final ObjectMapper streng;

    public EnergiemanagementTeilVermerkController(EnergiemanagementTeilVermerkService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }

    /**
     * Recht: {@code energiemanagement.ansehen}, nur unternehmensweit. Die Vermerke am Abruf: geltende zuerst in der
     * Folge des Vokabulars {@code teil}, dann aufgehobene, die zuletzt aufgehobene zuerst.
     */
    @GetMapping("/teil-vermerke")
    public EnergiemanagementTeilVermerkDto.Vermerke vermerke() {
        return dienst.vermerke();
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Vermerkt „trifft zurzeit nicht zu“ für einen Teil:
     * Teil, Satz und „entschieden von“, wahlfrei der Tag der Entscheidung (Vorgabe heute); ein geltender Vermerk für
     * denselben Teil 409 {@code vermerk_besteht}.
     */
    @PostMapping("/teil-vermerke")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<EnergiemanagementTeilVermerkDto.Vermerk> anlegen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        UUID id = dienst.anlegen(lies(body), akteur(auth));
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.vermerk(id));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Hebt den Vermerk einmal auf, jetzt; schon aufgehoben
     * 409 {@code vermerk_aufgehoben}. Danach kann der Teil wieder vermerkt werden, als neuer Vermerk.
     */
    @PostMapping("/teil-vermerke/{id}/aufheben")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public EnergiemanagementTeilVermerkDto.Vermerk aufheben(@PathVariable UUID id, Authentication auth) {
        dienst.aufheben(id, akteur(auth));
        return dienst.vermerk(id);
    }

    private EnergiemanagementTeilVermerkDto.Anlegen lies(JsonNode body) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw EnergiemanagementAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, EnergiemanagementTeilVermerkDto.Anlegen.class);
        } catch (UnrecognizedPropertyException e) {
            throw EnergiemanagementAbgelehnt.anfrage(e.getPropertyName());
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw EnergiemanagementAbgelehnt.anfrage("");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(EnergiemanagementAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(EnergiemanagementAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie ein Vermerk, den es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(EnergiemanagementTeilVermerkService.vermerkFehlt());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(EnergiemanagementAbgelehnt.anfrage(""));
    }
}
