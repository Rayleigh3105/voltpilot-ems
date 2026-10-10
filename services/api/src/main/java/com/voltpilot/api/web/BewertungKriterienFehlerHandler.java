package com.voltpilot.api.web;

import com.voltpilot.api.uems.BewertungKriterienAbgelehnt;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice(assignableTypes={BewertungKriterienController.class})
public class BewertungKriterienFehlerHandler {
    @ExceptionHandler(BewertungKriterienAbgelehnt.class)
    public ResponseEntity<Map<String,Object>> abgelehnt(BewertungKriterienAbgelehnt e) {
        return ResponseEntity.status(e.status()).body(Map.of("code",e.code(),"message",e.getMessage()));
    }
    @ExceptionHandler({org.springframework.http.converter.HttpMessageNotReadableException.class,
            org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Map<String,Object>> anfrage(Exception e) { return abgelehnt(BewertungKriterienAbgelehnt.anfrage()); }
}
