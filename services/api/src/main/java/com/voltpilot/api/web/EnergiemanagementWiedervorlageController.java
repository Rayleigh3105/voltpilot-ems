package com.voltpilot.api.web;

import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.EnergiemanagementWiedervorlageService;
import com.voltpilot.api.web.dto.EnergiemanagementWiedervorlageDto;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * UEMS AP-19 IP-21: die Wiedervorlage im Energiemanagement (WV1–WV4, E10 = A) — was fällig ist und was in den
 * nächsten Tagen fällig wird, über alle Objekte, beim Abruf gelesen; als JSON oder als Kalender-Abzug (.ics). Die
 * Arbeit macht {@link EnergiemanagementWiedervorlageService}.
 *
 * <p><b>Rechte:</b> Lesen {@code energiemanagement.ansehen} als Kennung im Kommentar; der Zaun ist der jeder Quelle
 * (die Dienste lesen mit den Rechten des Aufrufers). Der Kalender-Abzug hat dasselbe Recht wie die Seite und wird nicht
 * eigens protokolliert — auch „Einsicht“ darf ihn laden (RE3, Z4). Nichts wird verschickt.
 */
@RestController
@RequestMapping("/api/v1/energiemanagement")
public class EnergiemanagementWiedervorlageController {

    private final EnergiemanagementWiedervorlageService dienst;

    public EnergiemanagementWiedervorlageController(EnergiemanagementWiedervorlageService dienst) {
        this.dienst = dienst;
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Die Wiedervorlage am Abruf — fällige Zeilen am längsten fällig zuerst,
     * die Vorschau der nächsten Tage; {@code format=ics} liefert dieselben Zeilen als Kalender-Abzug mit Stand-Vermerk.
     */
    @GetMapping("/wiedervorlage")
    public ResponseEntity<?> wiedervorlage(@RequestParam(required = false) String format) {
        if (format != null && !format.equals("ics") && !format.equals("json")) {
            throw EnergiemanagementAbgelehnt.anfrage("format");
        }
        EnergiemanagementWiedervorlageDto.Wiedervorlage w = dienst.lesen();
        if (!"ics".equals(format)) {
            return ResponseEntity.ok(w);
        }
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/calendar;charset=UTF-8"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=wiedervorlage-"
                        + w.stichtag().toLocalDate() + ".ics")
                .body(EnergiemanagementWiedervorlageService.ics(w));
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(EnergiemanagementAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(EnergiemanagementAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).contentType(MediaType.APPLICATION_JSON).body(body);
    }
}
