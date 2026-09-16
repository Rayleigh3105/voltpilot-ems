package com.voltpilot.api.zugriff;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** Rendert {@link ZugriffAbgelehnt} für jede Route gleich (UEMS AP-03 IP-9). */
@RestControllerAdvice
public class ZugriffAbgelehntAntwort {

    @ExceptionHandler(ZugriffAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(ZugriffAbgelehnt e) {
        return ResponseEntity.status(e.http()).body(e.koerper());
    }
}
