package com.voltpilot.api.web;

import com.voltpilot.api.mispel.MispelNachweisAbgelehnt;
import com.voltpilot.api.mispel.MispelNachweisService;
import com.voltpilot.api.mispel.MsbAbgleichService;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.YearMonth;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Abgleich Gerät gegen Messstellenbetreiber einer Anlage im Monat (MiSpeL MP-15): die Zählrichtungen mit Ampel,
 * die größte Abweichung und ihre Wirkung — für den Satz in der Monatskarte und das Blatt „Abgleich“ (MP-18).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/mispel/abgrenzung")
public class SiteMispelAbgleichController {

    private final MsbAbgleichService abgleich;
    private final RechtPruefung rechte;

    public SiteMispelAbgleichController(MsbAbgleichService abgleich, RechtPruefung rechte) {
        this.abgleich = abgleich;
        this.rechte = rechte;
    }

    /** Recht: {@code messwerte.ansehen} (Leseweg der Anlage). Der Abgleich der Zählrichtungen im Monat. */
    @GetMapping("/monate/{monat}/abgleich")
    public MsbAbgleichService.AnlageMonat monat(@PathVariable UUID siteId, @PathVariable String monat) {
        rechte.pruefenLesen(RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
        YearMonth m;
        try {
            m = YearMonth.parse(monat);
        } catch (DateTimeParseException e) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "„" + monat + "“ ist kein Monat (JJJJ-MM).");
        }
        if (m.isBefore(MispelNachweisService.AB)) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "Die Festlegung gilt ab "
                    + MispelNachweisService.AB + ".");
        }
        MsbAbgleichService.AnlageMonat a = abgleich.anlage(siteId, m);
        if (a == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return a;
    }

    /** {@code {code, message}} wie der Nachweis. */
    @ExceptionHandler(MispelNachweisAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MispelNachweisAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        return ResponseEntity.status(e.status()).contentType(MediaType.APPLICATION_JSON).body(body);
    }
}
