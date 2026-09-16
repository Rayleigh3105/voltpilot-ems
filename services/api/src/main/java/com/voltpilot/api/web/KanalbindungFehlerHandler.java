package com.voltpilot.api.web;

import com.voltpilot.api.uems.KanalbindungFehler;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class KanalbindungFehlerHandler {
    @ExceptionHandler(KanalbindungFehler.class)
    public ResponseEntity<Map<String,String>> abgelehnt(KanalbindungFehler e) {
        return ResponseEntity.status(e.status()).body(Map.of("code",e.code(),"message",e.getMessage()));
    }
    /** Auch die vorhandenen Komponenten-Löschwege behalten die referenzierte Kanalhistorie. */
    @ExceptionHandler(org.springframework.dao.DataIntegrityViolationException.class)
    public ResponseEntity<Map<String,String>> beleg(org.springframework.dao.DataIntegrityViolationException e) {
        Throwable grund=e;
        while (grund.getCause()!=null) grund=grund.getCause();
        if (grund instanceof java.sql.SQLException p && "23514".equals(p.getSQLState())
                && p.getMessage()!=null && p.getMessage().contains("kanal_gebunden")) {
            return ResponseEntity.status(422).body(Map.of("code","kanal_gebunden",
                "message","Für diesen Zeitraum liefert ein Messkanal die Werte. Eine Eingabe oder ein Import ist hier nicht möglich."));
        }
        if (grund instanceof java.sql.SQLException p && "23503".equals(p.getSQLState())
                && p.getMessage()!=null && (p.getMessage().contains("bezugskanal_komponente_fk")
                    || p.getMessage().contains("bezugskanal_bezug_fk"))) {
            return ResponseEntity.status(409).body(Map.of("code","kanalbindung_vorhanden",
                "message","Eine Kanalbindung verweist auf diesen Eintrag. Seine Historie bleibt erhalten."));
        }
        throw e;
    }
}
