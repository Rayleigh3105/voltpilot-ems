package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.AbweichungService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.web.dto.AbweichungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.servlet.http.HttpServletRequest;
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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Auffälligkeiten an einer Kennzahl (UEMS AP-18 IP-16, A1, A2, RE1/RE2): die Vermerke der Naht (IP-15) lesen und
 * einmalig beantworten — {@code abweichung} eröffnet AW-… mit allen offenen Vermerken derselben Kennzahl × Fassung,
 * {@code zur_kenntnis} mit Begründung. Die Arbeit macht {@link AbweichungService}.
 *
 * <p><b>Rechte:</b> die Antwort {@code verbesserung.verwalten} an der Geltung der Kennzahl (403 {@code recht_fehlt});
 * Lesen {@code verbesserung.ansehen} als Kennung im Kommentar — Zaun über die Kennzahl und {@code standort_id}, außerhalb
 * 404.
 */
@RestController
@RequestMapping("/api/v1/kennzahlen/{id}/auffaelligkeiten")
public class AuffaelligkeitController {

    private final AbweichungService abweichungen;
    private final ObjectMapper streng;

    public AuffaelligkeitController(AbweichungService abweichungen, ObjectMapper json) {
        this.abweichungen = abweichungen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code verbesserung.ansehen} (Zaun über die Kennzahl). Die Vermerke nach Monat, beantwortete mit ihrer
     * Antwort; {@code zustand} ({@code offen · beantwortet}) filtert, {@code offen} zählt immer alle offenen.
     */
    @GetMapping
    public AbweichungDto.Vermerke liste(@PathVariable UUID id, @RequestParam(required = false) String zustand,
            HttpServletRequest anfrage) {
        return abweichungen.vermerke(id, anfrage.getParameterMap().keySet(), zustand);
    }

    /**
     * Recht: {@code verbesserung.verwalten} an der Geltung der Kennzahl. Die einmalige Antwort (sonst 409
     * {@code auffaelligkeit_beantwortet}): {@code abweichung} mit Verantwortlichem und Frist eröffnet AW-… (201),
     * {@code zur_kenntnis} mit Begründung 10–500 (200, sonst 422 {@code begruendung_fehlt}).
     */
    @PostMapping("/{aid}/antwort")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<AbweichungDto.Beantwortet> antwort(@PathVariable UUID id, @PathVariable UUID aid,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        AbweichungDto.Beantwortet b = abweichungen.antworten(id, aid, lies(body, AbweichungDto.Antwort.class),
                akteur(auth));
        return ResponseEntity.status(b.abweichung() == null ? HttpStatus.OK : HttpStatus.CREATED).body(b);
    }

    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw VerbesserungAbgelehnt.anfrage(e.getPropertyName());
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(VerbesserungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(VerbesserungAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Die Kennzahl lehnt ab (404 außerhalb der Sicht, 403 ohne Recht an der Geltung). */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> kennzahl(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine Auffälligkeit, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new VerbesserungAbgelehnt(404, "nicht_gefunden", "Diese Auffälligkeit gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(VerbesserungAbgelehnt.anfrage(""));
    }
}
