package com.voltpilot.api.web;

import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.EnergiemanagementVerzeichnisService;
import com.voltpilot.api.web.dto.EnergiemanagementVerzeichnisDto;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * UEMS AP-19 IP-8: das Verzeichnis im Energiemanagement (VZ1–VZ4, KS2) — jede Entscheidung und jeder Nachweis mit
 * Person, Tag, Fassung oder Nr., Prüfsumme und dem Ort des Originals, als JSON oder als CSV für das System des Kunden.
 * Die Arbeit macht {@link EnergiemanagementVerzeichnisService}.
 *
 * <p><b>Rechte:</b> Lesen {@code energiemanagement.ansehen} als Kennung im Kommentar; der Zaun ist der jeder Quelle
 * (die Dienste lesen mit den Rechten des Aufrufers). Die CSV hat dasselbe Recht wie die Seite und wird nicht eigens
 * protokolliert (VZ4) — auch „Einsicht“ darf sie abrufen (RE3, Z4).
 */
@RestController
@RequestMapping("/api/v1/energiemanagement")
public class EnergiemanagementVerzeichnisController {

    private final EnergiemanagementVerzeichnisService dienst;

    public EnergiemanagementVerzeichnisController(EnergiemanagementVerzeichnisService dienst) {
        this.dienst = dienst;
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Das Verzeichnis am Abruf — elf Gruppen, mit {@code gruppe} nur diese;
     * {@code von}/{@code bis} filtern den Tag (beide eingeschlossen), {@code person} die Zeilen in ihrem Namen;
     * {@code format=csv} liefert dieselben Zeilen als Datei.
     */
    @GetMapping("/verzeichnis")
    public ResponseEntity<?> verzeichnis(@RequestParam(required = false) String gruppe,
            @RequestParam(required = false) String von, @RequestParam(required = false) String bis,
            @RequestParam(required = false) String person, @RequestParam(required = false) String format) {
        if (format != null && !format.equals("csv") && !format.equals("json")) {
            throw EnergiemanagementAbgelehnt.anfrage("format");
        }
        EnergiemanagementVerzeichnisDto.Verzeichnis v = dienst.lesen(leer(gruppe), tag(von, "von"), tag(bis, "bis"),
                id(person));
        if (!"csv".equals(format)) {
            return ResponseEntity.ok(v);
        }
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=verzeichnis-"
                        + v.stichtag().toLocalDate() + ".csv")
                .body(EnergiemanagementVerzeichnisService.csv(v));
    }

    private static String leer(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private static LocalDate tag(String tag, String feld) {
        if (leer(tag) == null) {
            return null;
        }
        try {
            return LocalDate.parse(tag.strip());
        } catch (DateTimeParseException e) {
            throw EnergiemanagementAbgelehnt.anfrage(feld);
        }
    }

    private static UUID id(String person) {
        if (leer(person) == null) {
            return null;
        }
        try {
            return UUID.fromString(person.strip());
        } catch (IllegalArgumentException e) {
            throw EnergiemanagementAbgelehnt.personFehlt();
        }
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
