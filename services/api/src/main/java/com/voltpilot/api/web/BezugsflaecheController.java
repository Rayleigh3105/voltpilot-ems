package com.voltpilot.api.web;

import com.voltpilot.api.uems.BezugsflaecheLesemodell;
import com.voltpilot.api.uems.BezugsgroesseAbgelehnt;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Bezugsflächen als Bezugsgrößen (UEMS AP-09 IP-6, E17): gelesen aus der Ortsstruktur, zum Stichtag
 * „letzter Tag der Periode“, mit den Übergängen als Kennzeichen (S3). Die Arbeit macht
 * {@link BezugsflaecheLesemodell}.
 *
 * <p><b>Nur lesen.</b> Diese Route hat bewusst KEINEN Schreibweg ({@code PUT}/{@code POST}/{@code DELETE}
 * antworten 405): eine Bezugsfläche, die hier geschrieben würde, wäre eine zweite Wahrheit neben der Fläche
 * am Gebäude. Geändert wird sie über {@code PUT /api/v1/orte/{id}/flaeche} (AP-02).
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} plus die Mandanten-RLS; die Kennung
 * steht im Kommentar der Route ({@code RechteKennungenDerRoutenTest}). Fehlerform und Sätze sind die der
 * Bezugsgrößen-Schnittstelle ({@link BezugsgroesseAbgelehnt}).
 */
@RestController
@RequestMapping("/api/v1/bezugsflaechen")
public class BezugsflaecheController {

    private final BezugsflaecheLesemodell bezugsflaechen;

    public BezugsflaecheController(BezugsflaecheLesemodell bezugsflaechen) {
        this.bezugsflaechen = bezugsflaechen;
    }

    /**
     * Recht: {@code messwerte.ansehen} (AP-09 §4.11 „Bezugsgrößen und Werte … ansehen“). {@code periode_art}
     * (tag · woche · monat · jahr), {@code von} und {@code bis} (Tage, der letzte einschließlich) sind Pflicht;
     * gefragt sind alle Perioden, die den Zeitraum berühren.
     */
    @GetMapping
    public BezugsgroesseDto.Bezugsflaechen werte(
            @RequestParam(name = "periode_art", required = false) String periodeArt,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis) {
        return bezugsflaechen.werte(periodeArt == null || periodeArt.isBlank() ? null : periodeArt,
                tag("von", von), tag("bis", bis));
    }

    private static LocalDate tag(String feld, String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw BezugsgroesseAbgelehnt.anfrage(feld);
        }
    }

    /** {@code {code, message, …Fakten}} — dieselbe Form wie jede Ablehnung der Bezugsgrößen. */
    @ExceptionHandler(BezugsgroesseAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BezugsgroesseAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }
}
