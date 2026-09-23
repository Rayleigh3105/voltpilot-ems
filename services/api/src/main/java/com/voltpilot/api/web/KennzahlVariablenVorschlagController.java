package com.voltpilot.api.web;

import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.VariablenVorschlag;
import com.voltpilot.api.web.dto.VariablenVorschlagDto;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * Der Variablen-Vorschlag einer Kennzahl aus dem Energieeinsatz (UEMS AP-17 IP-11a, V4, W1): Verweise als Kandidaten,
 * Wortlaute „ohne Zahl“, die Abhängigkeit von Variable 1 als Hinweis (G4). Die Arbeit macht {@link VariablenVorschlag};
 * einen Schreibweg gibt es hier nicht — übernommen wird erst in eine Fassung der Bezugsbasis (IP-11b).
 *
 * <p><b>Rechte:</b> wie die Kennzahl lesen ({@code messwerte.ansehen}); eine Kennzahl aus einem fremden Kundenbereich
 * oder außerhalb der Sichtbarkeit ist 404, nie 403.
 */
@RestController
@RequestMapping("/api/v1/kennzahlen")
public class KennzahlVariablenVorschlagController {

    private final VariablenVorschlag vorschlag;

    public KennzahlVariablenVorschlagController(VariablenVorschlag vorschlag) {
        this.vorschlag = vorschlag;
    }

    /**
     * Recht: {@code messwerte.ansehen} (AP-11 R2, Zaun über die Kennzahl). {@code referenzperiode} optional
     * ({@code JJJJ-MM/JJJJ-MM}); ohne sie die zwölf abgeschlossenen Monate vor dem laufenden.
     */
    @GetMapping("/{id}/variablen-vorschlag")
    public VariablenVorschlagDto.Vorschlag variablenVorschlag(@PathVariable UUID id,
            @RequestParam(required = false) String referenzperiode, HttpServletRequest anfrage) {
        return vorschlag.vorschlag(id, anfrage.getParameterMap().keySet(), referenzperiode);
    }

    /** {@code {code, message, …Fakten}} — dieselbe Form wie jede Ablehnung der Kennzahl-Schnittstelle. */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }
}
