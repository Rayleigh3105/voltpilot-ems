package com.voltpilot.api.web;

import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.uems.MessstelleWerteService;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Lese-Modell „Werte je Messstelle“ (UEMS AP-08 IP-9): Menge bzw. Mittel/Min/Max je Schritt
 * eines Rasters, und nie ohne Zustand, Abdeckung und Kennzeichen. Die Arbeit macht
 * {@link MessstelleWerteService}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS — eine fremde Messstelle ist 404, nie 403. Die Route nennt ihre Kennung aus
 * {@code docs/contracts/v2/rechte-matrix.json} im Kommentar ({@code RechteKennungenDerRoutenTest});
 * durchgesetzt wird sie hier NICHT.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein unbekanntes Raster, ein Zeitpunkt neben dem Raster,
 * {@code von} nicht vor {@code bis}, ein Tag, den es nicht gibt, oder zu viele Schritte sind 400
 * {@code anfrage_ungueltig} mit {@code feld} und {@code grund} — nie ein technischer Fehler.
 */
@RestController
@RequestMapping("/api/v1/messstellen")
public class MessstelleWerteController {

    private final MessstelleWerteService werte;

    public MessstelleWerteController(MessstelleWerteService werte) {
        this.werte = werte;
    }

    /**
     * Recht: {@code messwerte.ansehen} (AP-08 §4.8 „Werte, Zustände, Kennzeichen, Versionen ansehen“).
     * {@code raster} viertelstunde · stunde · tag · monat · jahr; {@code von}/{@code bis} ein Tag
     * (JJJJ-MM-TT, {@code bis} = letzter Tag einschließlich) oder ein Zeitpunkt mit Versatz
     * ({@code bis} ausschließlich), beide auf den Grenzen des Rasters in der Zeitzone des Standorts;
     * {@code version} optional.
     */
    @GetMapping("/{kennzeichen}/werte")
    public MessstelleWerteDto.Werte werte(@PathVariable String kennzeichen,
            @RequestParam(required = false) String raster,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis,
            @RequestParam(required = false) String version) {
        return werte.werte(kennzeichen, raster, von, bis, version);
    }

    /** {@code {code, message, feld, grund}} — dieselbe Form wie jede Ablehnung der Messstellen-Schnittstelle. */
    @ExceptionHandler(MessstelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MessstelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** 404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
