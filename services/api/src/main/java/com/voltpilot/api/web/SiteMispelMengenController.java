package com.voltpilot.api.web;

import com.voltpilot.api.mispel.MispelMengenService;
import com.voltpilot.api.mispel.MispelNachweisAbgelehnt;
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
 * Die Kundenansicht der Abgrenzungsoption (MP-18, BK-18 Variante A, Verlauf › Erlöse): je Monat und Jahr die Mengen
 * nach Anlage 1 in den Farben der Festlegung, Stand und „Was das wert ist“ — gelesen aus den gespeicherten Läufen
 * (MP-8, MP-21) über {@link MispelMengenService}. Den Nachweis selbst liefern die Routen von MP-16
 * ({@link SiteMispelNachweisController}).
 *
 * <p>Immer 200 für eine sichtbare Anlage: {@code abgrenzung = false} heißt „keine Bestimmung nach Anlage 1 in diesem
 * Zeitraum“ (das Portal zeigt dann keine Karte); ein Monat ohne Lauf hat leere {@code teile}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/mispel/abgrenzung")
public class SiteMispelMengenController {

    private final MispelMengenService mengen;
    private final RechtPruefung rechte;

    public SiteMispelMengenController(MispelMengenService mengen, RechtPruefung rechte) {
        this.mengen = mengen;
        this.rechte = rechte;
    }

    /** Recht: {@code messwerte.ansehen} (Leseweg der Anlage). Der Monat: Teile mit Mengen, Stand und Wert. */
    @GetMapping("/monate/{monat}")
    public MispelMengenService.Monat monat(@PathVariable UUID siteId, @PathVariable String monat) {
        imZugriff(siteId);
        MispelMengenService.Monat m = mengen.monat(siteId, monat(monat));
        if (m == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return m;
    }

    /** Recht: {@code messwerte.ansehen} (Leseweg der Anlage). Das Jahr: eine Zeile je Monat, Wert und Frist. */
    @GetMapping("/jahre/{jahr}")
    public MispelMengenService.Jahr jahr(@PathVariable UUID siteId, @PathVariable String jahr) {
        imZugriff(siteId);
        if (!jahr.matches("\\d{4}")) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "„" + jahr + "“ ist kein Jahr (JJJJ).");
        }
        MispelMengenService.Jahr j = mengen.jahr(siteId, Integer.parseInt(jahr));
        if (j == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return j;
    }

    private void imZugriff(UUID siteId) {
        rechte.pruefenLesen(RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
    }

    private static YearMonth monat(String monat) {
        try {
            return YearMonth.parse(monat);
        } catch (DateTimeParseException e) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "„" + monat + "“ ist kein Monat (JJJJ-MM).");
        }
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
