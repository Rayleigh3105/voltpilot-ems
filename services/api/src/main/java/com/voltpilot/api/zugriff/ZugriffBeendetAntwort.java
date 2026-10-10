package com.voltpilot.api.zugriff;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Rendert {@link ZugriffBeendet} für jede Route gleich (UEMS AP-03 IP-9) — 404 mit dem Körper der UEMS-Ablehnungen.
 *
 * <p>Wie {@link RechtFehlt} ist {@link ZugriffBeendet} bewusst KEINE {@code ResponseStatusException}: die
 * Controller-eigenen {@code @ExceptionHandler} für jene formen sie sonst in ihre eigene 404 um, und der Grund ginge
 * verloren. Der {@link ZugriffFilter} steht VOR dem {@code DispatcherServlet} und schreibt denselben Körper selbst.
 */
@RestControllerAdvice
public class ZugriffBeendetAntwort {

    @ExceptionHandler(ZugriffBeendet.class)
    public ResponseEntity<Map<String, Object>> beendet(ZugriffBeendet e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(e.koerper());
    }
}
