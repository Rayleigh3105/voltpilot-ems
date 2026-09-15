package com.voltpilot.api.zugriff;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Rendert {@link RechtFehlt} für jede Route gleich — geworfen vom {@link RechtInterceptor} vor dem Handler oder von einer
 * genauen Prüfung im Handler. Ein {@code @ExceptionHandler} am Controller ginge vor; keiner fängt {@code Exception}
 * allgemein, und {@link RechtFehlt} ist bewusst KEINE {@code ResponseStatusException}, damit die Controller-eigenen
 * Handler für jene sie nicht umformen.
 */
@RestControllerAdvice
public class RechtFehltAntwort {

    @ExceptionHandler(RechtFehlt.class)
    public ResponseEntity<Map<String, Object>> rechtFehlt(RechtFehlt e) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(e.koerper());
    }
}
