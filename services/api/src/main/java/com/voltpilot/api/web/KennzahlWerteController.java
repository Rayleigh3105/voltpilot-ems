package com.voltpilot.api.web;

import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.KennzahlWerteService;
import com.voltpilot.api.uems.WertVersionenRegeln;
import com.voltpilot.api.web.dto.KennzahlDto;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * Die Werte einer Kennzahl lesen (UEMS AP-11 IP-7): je Periode Zahl, Zustand, Richtung, Abdeckung, Kennzeichen,
 * Version, gelesene Fassung und die Herkunft — und die Versions-Historie einer Periode. Die Arbeit macht
 * {@link KennzahlWerteService}; die Definition bleibt bei {@code KennzahlController} (IP-5).
 *
 * <p><b>Rechte:</b> das Ansehen trägt {@code messwerte.ansehen} als Kennung im Kommentar
 * ({@code RechteKennungenDerRoutenTest}); durchgesetzt wird es hier NICHT (die Sichtbarkeit R-A1 ∧ R-A6 bringt AP-03
 * IP-11). Eine Kennzahl aus einem fremden Kundenbereich ist 404, nie 403.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein fehlender, falsch geformter oder unbekannter Parameter ist 400
 * {@code anfrage_ungueltig} mit {@code feld}; eine Version, die es an keinem Schritt gibt, ist 404
 * {@code version_gibt_es_nicht} in der Form der Messstelle (AP-08 IP-18).
 */
@RestController
@RequestMapping("/api/v1/kennzahlen")
public class KennzahlWerteController {

    private final KennzahlWerteService werte;

    public KennzahlWerteController(KennzahlWerteService werte) {
        this.werte = werte;
    }

    /**
     * Recht: {@code messwerte.ansehen} (AP-11 R2 „Kennzahlen und ihre Werte ansehen“). {@code periode} tag · woche ·
     * monat · jahr; {@code von} der erste Tag einer Periode, {@code bis} der LETZTE Tag einer Periode (JJJJ-MM-TT,
     * einschließlich); {@code version} optional. Ungerundet — gerundet wird nur im Portal.
     */
    @GetMapping("/{id}/werte")
    public KennzahlDto.Werte werte(@PathVariable UUID id, @RequestParam(required = false) String periode,
            @RequestParam(required = false) String von, @RequestParam(required = false) String bis,
            @RequestParam(required = false) String version, HttpServletRequest anfrage) {
        return werte.werte(id, anfrage.getParameterMap().keySet(), periode, von, bis, version);
    }

    /**
     * Recht: {@code messwerte.ansehen} (AP-11 V6 „wer, wann, warum, was vorher“). Die Versions-Historie EINER Periode:
     * {@code periode} und {@code von}, ihr erster Tag.
     */
    @GetMapping("/{id}/werte/versionen")
    public KennzahlDto.Historie versionen(@PathVariable UUID id, @RequestParam(required = false) String periode,
            @RequestParam(required = false) String von, HttpServletRequest anfrage) {
        return werte.historie(id, anfrage.getParameterMap().keySet(), periode, von);
    }

    /** 404 {@code version_gibt_es_nicht}: benannt, mit der neuesten — nie leer, nie stillschweigend die höchste. */
    @ExceptionHandler(WertVersionenRegeln.VersionGibtEsNicht.class)
    public ResponseEntity<Map<String, Object>> versionGibtEsNicht(WertVersionenRegeln.VersionGibtEsNicht e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", WertVersionenRegeln.VersionGibtEsNicht.CODE);
        body.put("message", e.getMessage());
        body.put("feld", "version");
        body.put("grund", WertVersionenRegeln.VersionGibtEsNicht.CODE);
        body.put("version", e.version());
        body.put("hoechste_version", e.hoechste());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(body);
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
