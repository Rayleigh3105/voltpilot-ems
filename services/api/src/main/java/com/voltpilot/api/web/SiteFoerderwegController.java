package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.mispel.FoerderwegAbgelehnt;
import com.voltpilot.api.mispel.FoerderwegService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.FoerderwegDto;
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
 * Der Förderweg je Einspeisestelle nach der MiSpeL-Festlegung (MP-5, Entscheid E2 = B, Vertrag
 * {@code docs/contracts/v2/mispel-foerderweg.md}): Einspeisevergütung, Marktprämie mit Ausschließlichkeits-,
 * Abgrenzungs- oder Pauschaloption, ungefördert — als Fassungen ab einem Tag. Die Arbeit macht
 * {@link FoerderwegService}.
 *
 * <p><b>Rechte</b> wie der Netzlade-Schalter an {@link SiteController}: setzen mit {@code anlage.verwalten}, lesen
 * über den Leseweg der Anlage (außerhalb des Zugriffs 404). Die Anfrage wird streng gelesen: ein unbekanntes Feld
 * ist 400 {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/foerderweg")
public class SiteFoerderwegController {

    private final FoerderwegService wege;
    private final RechtPruefung rechte;
    private final ObjectMapper streng;

    public SiteFoerderwegController(FoerderwegService wege, RechtPruefung rechte, ObjectMapper json) {
        this.wege = wege;
        this.rechte = rechte;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);
    }

    /**
     * Recht: {@code messwerte.ansehen} (Leseweg der Anlage). Der Förderweg am Tag {@code am} (fehlend = heute) mit
     * dem Begriff aus EEG und Festlegung, dem Formelsatz und seiner Bindung, Netzladen und allen Fassungen.
     */
    @GetMapping
    public FoerderwegDto.Ansicht ansehen(@PathVariable UUID siteId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate am) {
        imZugriff(siteId);
        FoerderwegService.Ansicht a = wege.ansicht(siteId, am);
        if (a == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return FoerderwegDto.aus(a);
    }

    /** Recht: {@code anlage.verwalten}. Eine neue Fassung ab {@code gueltig_ab}; Antwort: die Ansicht an dem Tag. */
    @PutMapping
    @Recht(value = "anlage.verwalten", ziel = RechtZiel.ANLAGE)
    public FoerderwegDto.Ansicht setzen(@PathVariable UUID siteId, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        imZugriff(siteId);
        FoerderwegService.Aendern a = lies(body);
        ProtokollAkteur wer = ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
        wege.setzen(siteId, a, wer.name());
        return FoerderwegDto.aus(wege.ansicht(siteId, a.gueltigAb()));
    }

    private void imZugriff(UUID siteId) {
        rechte.pruefenLesen(RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
    }

    private FoerderwegService.Aendern lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw FoerderwegAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, FoerderwegService.Aendern.class);
        } catch (UnrecognizedPropertyException e) {
            throw FoerderwegAbgelehnt.anfrage(e.getPropertyName(), "„" + e.getPropertyName() + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName();
            throw FoerderwegAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw FoerderwegAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code {code, message, …Fakten}}. */
    @ExceptionHandler(FoerderwegAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(FoerderwegAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keinTag(MethodArgumentTypeMismatchException e) {
        return abgelehnt(FoerderwegAbgelehnt.anfrage(e.getName(), "„" + e.getName() + "“ ist ein Tag (JJJJ-MM-TT)."));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(FoerderwegAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
