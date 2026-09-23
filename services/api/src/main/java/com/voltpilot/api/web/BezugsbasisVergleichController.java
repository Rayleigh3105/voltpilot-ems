package com.voltpilot.api.web;

import com.voltpilot.api.uems.BezugsbasisAbgelehnt;
import com.voltpilot.api.uems.BezugsbasisVergleich;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
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
 * Der Vergleich einer Kennzahl mit ihrer Bezugsbasis (UEMS AP-17 IP-19, U1–U6; Vertrag Bezugsbasis §16 „Vergleich“).
 * Nur Lesen; die Arbeit macht {@link BezugsbasisVergleich}. Anlegen und Fassungen stehen in
 * {@code BezugsbasisController} (IP-7).
 *
 * <p><b>Rechte:</b> {@code bezugsbasis.ansehen} als Kennung im Kommentar; die Sichtbarkeit kommt über die Kennzahl —
 * außerhalb der Sicht oder aus einem fremden Kundenbereich 404, nie 403.
 */
@RestController
@RequestMapping("/api/v1/kennzahlen")
public class BezugsbasisVergleichController {

    private final BezugsbasisVergleich vergleich;

    public BezugsbasisVergleichController(BezugsbasisVergleich vergleich) {
        this.vergleich = vergleich;
    }

    /**
     * Recht: {@code bezugsbasis.ansehen} (Zaun über die Kennzahl). {@code basis} optional ({@code BB-…}, ohne: die
     * laufende); {@code von}/{@code bis} optional ({@code JJJJ-MM}, ohne: die zwölf abgeschlossenen Monate vor dem
     * laufenden).
     */
    @GetMapping("/{id}/vergleich")
    public BezugsbasisVergleichDto.Vergleich vergleich(@PathVariable UUID id,
            @RequestParam(required = false) String basis, @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis, HttpServletRequest anfrage) {
        return vergleich.vergleich(id, anfrage.getParameterMap().keySet(), basis, von, bis);
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(BezugsbasisAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BezugsbasisAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Die Kennzahl selbst lehnt ab (404 außerhalb der Sicht). */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> kennzahl(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine Kennzahl, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return kennzahl(KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }
}
