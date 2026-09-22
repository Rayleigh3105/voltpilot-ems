package com.voltpilot.api.web;

import com.voltpilot.api.uems.BewertungUmfangAbgelehnt;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice(assignableTypes={BewertungUmfangController.class,BewertungRanglisteController.class})
public class BewertungUmfangFehlerHandler {
    @ExceptionHandler(BewertungUmfangAbgelehnt.class)
    public ResponseEntity<Map<String,Object>> abgelehnt(BewertungUmfangAbgelehnt e) {
        return ResponseEntity.status(e.status()).body(Map.of("code",e.code(),"message",e.getMessage()));
    }
    @ExceptionHandler({org.springframework.http.converter.HttpMessageNotReadableException.class,
            org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Map<String,Object>> anfrage(Exception e) { return abgelehnt(BewertungUmfangAbgelehnt.anfrage()); }
}
