package com.voltpilot.api.web;

import com.voltpilot.api.uems.MessmittelAbgelehnt;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** AP-16 IP-15/IP-17: {@code code}, {@code feld} und Kundensatz der Messmittel- und Toleranz-Routen. */
@RestControllerAdvice(assignableTypes = {MessmittelController.class, VergleichToleranzController.class})
public class MessmittelFehlerHandler {
    @ExceptionHandler(MessmittelAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MessmittelAbgelehnt e) {
        return ResponseEntity.status(e.status())
                .body(Map.of("code", e.code(), "feld", e.feld(), "message", e.getMessage()));
    }

    @ExceptionHandler({org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Map<String, Object>> anfrage(Exception e) {
        return abgelehnt(MessmittelAbgelehnt.anfrage("id", "Bitte prüfen Sie die Angaben Ihrer Anfrage."));
    }
}
