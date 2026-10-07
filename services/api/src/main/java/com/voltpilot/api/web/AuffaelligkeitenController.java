package com.voltpilot.api.web;

import com.voltpilot.api.uems.AbweichungService;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.web.dto.AbweichungDto;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Offene Auffälligkeiten unter Verbessern (UEMS AP-18 IP-16, Verbessern-Konzept v1 Entscheid 4): die Vermerke über alle
 * sichtbaren Kennzahlen in einer Liste - der Reiter „Abweichungen“ zeigt zuerst, was auf eine Antwort wartet, das
 * Energieziel weist darauf hin. Beantwortet wird weiter an der Kennzahl ({@link AuffaelligkeitController}); die Arbeit
 * macht {@link AbweichungService}.
 *
 * <p><b>Rechte:</b> Lesen {@code verbesserung.ansehen} als Kennung im Kommentar - Zaun wie an der Kennzahl: RLS über
 * {@code standort_id}, dazu je Kennzahl ihre Sicht; was außerhalb liegt, fehlt in der Liste.
 */
@RestController
@RequestMapping("/api/v1/auffaelligkeiten")
public class AuffaelligkeitenController {

    private final AbweichungService abweichungen;

    public AuffaelligkeitenController(AbweichungService abweichungen) {
        this.abweichungen = abweichungen;
    }

    /**
     * Recht: {@code verbesserung.ansehen} (Zaun über Standort und Kennzahl). Die Vermerke aller sichtbaren Kennzahlen,
     * ältester Monat zuerst; {@code zustand} ({@code offen · beantwortet}) filtert, {@code offen} zählt immer alle
     * sichtbaren offenen; ein anderer Parameter 400.
     */
    @GetMapping
    public AbweichungDto.AlleVermerke liste(@RequestParam(required = false) String zustand,
            HttpServletRequest anfrage) {
        return abweichungen.alleVermerke(anfrage.getParameterMap().keySet(), zustand);
    }

    /** {@code {code, message, …Fakten}} - wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(VerbesserungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(VerbesserungAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }
}
