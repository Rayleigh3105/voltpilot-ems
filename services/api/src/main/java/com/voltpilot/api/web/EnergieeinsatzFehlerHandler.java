package com.voltpilot.api.web;

import com.voltpilot.api.uems.EnergieeinsatzAbgelehnt;
import com.voltpilot.api.uems.BelegeImWeg;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice(assignableTypes = {EnergieeinsatzController.class, MessbedarfController.class,
        MessbedarfUebersichtController.class, BezugsgroesseController.class})
public class EnergieeinsatzFehlerHandler {
    @ExceptionHandler(EnergieeinsatzAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(EnergieeinsatzAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }
    @ExceptionHandler(BelegeImWeg.class)
    public ResponseEntity<Map<String, Object>> belege(BelegeImWeg e) {
        return ResponseEntity.status(409).body(e.koerper());
    }
    @ExceptionHandler({org.springframework.http.converter.HttpMessageNotReadableException.class,
            org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Map<String, Object>> anfrage(Exception e) {
        return abgelehnt(EnergieeinsatzController.anfrage());
    }
}
