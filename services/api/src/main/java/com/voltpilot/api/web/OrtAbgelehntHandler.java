package com.voltpilot.api.web;

import com.voltpilot.api.uems.OrtAbgelehnt;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Die Antwort-Form jeder Ablehnung der Ortsstruktur: {@code {code, message, …Fakten}} mit dem
 * Status aus {@link OrtAbgelehnt.Grund} — dieselbe Form wie die Messstellen-Schnittstelle.
 * Nur für die Controller der Ortsstruktur (IP-5 trägt seinen hier ein); die übrige API
 * behält ihre Fehlerform.
 */
@RestControllerAdvice(assignableTypes = {StandortController.class, UnternehmenController.class})
public class OrtAbgelehntHandler {

    @ExceptionHandler(OrtAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(OrtAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(OrtAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }
}
