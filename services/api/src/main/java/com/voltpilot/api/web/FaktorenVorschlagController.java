package com.voltpilot.api.web;

import com.voltpilot.api.uems.FaktorenVorschlag;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.web.dto.FaktorenVorschlagDto;
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
 * Der Vorschlag der statischen Faktoren einer Kennzahl (UEMS AP-17 IP-16a, V3, E6 = A) — eine Lese-Route ohne
 * Schreibweg; die Arbeit macht {@link FaktorenVorschlag}. Vertrag: {@code docs/contracts/v2/bezugsbasis.md} §14.
 *
 * <p><b>Rechte:</b> gelesen wird wie die Kennzahl ({@code messwerte.ansehen} als Kennung im Kommentar,
 * {@code RechteKennungenDerRoutenTest}); der Zaun ist die Kennzahl selbst: wer sie nicht ganz sieht, bekommt 404,
 * nie 403 und nie einen Teil der Struktur.
 */
@RestController
@RequestMapping("/api/v1/kennzahlen")
public class FaktorenVorschlagController {

    private final FaktorenVorschlag vorschlag;

    public FaktorenVorschlagController(FaktorenVorschlag vorschlag) {
        this.vorschlag = vorschlag;
    }

    /**
     * Recht: {@code messwerte.ansehen} (AP-11 R2, Zaun über die Kennzahl). {@code stichtag} JJJJ-MM-TT, ohne ihn heute
     * in der Zeitzone der Kennzahl; ein anderer Parameter ist 400 {@code anfrage_ungueltig} mit {@code feld}.
     */
    @GetMapping("/{id}/faktoren-vorschlag")
    public FaktorenVorschlagDto.Vorschlag faktorenVorschlag(@PathVariable UUID id,
            @RequestParam(required = false) String stichtag, HttpServletRequest anfrage) {
        return vorschlag.vorschlag(id, anfrage.getParameterMap().keySet(), stichtag);
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
