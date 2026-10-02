package com.voltpilot.api.web;

import com.voltpilot.api.mispel.MispelNachweis;
import com.voltpilot.api.mispel.MispelNachweisAbgelehnt;
import com.voltpilot.api.mispel.MispelNachweisPdf;
import com.voltpilot.api.mispel.MispelNachweisService;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.YearMonth;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Nachweis und Export der MiSpeL-Abgrenzungsoption (MP-16): die monatliche Mengenbestimmung und der Jahresnachweis für
 * die Mitteilung bis 31.05. (§ 21 Abs. 7 EnFG) als CSV und PDF, je für {@code empfaenger} = {@code lieferant},
 * {@code direktvermarkter} oder {@code netzbetreiber}. Die Arbeit machen {@link MispelNachweisService} und die reinen
 * {@link MispelNachweis}/{@link MispelNachweisPdf}; nur endgültige Zeiträume gelten als Nachweis, vorläufige gehen
 * sichtbar als vorläufig hinaus.
 *
 * <p><b>Rechte</b> wie der Bestand-Geräte-Export: gelesen über den Leseweg der Anlage (außerhalb des Zugriffs 404), die
 * Datei mit {@code export.standort} (sonst 403). Die Routen haben kein {@code produces} — Ablehnungen kommen als JSON
 * {@code {code, message}}. Ein Download-Knopf im Portal folgt erst nach dem abgestimmten Bedienkonzept (BK-18).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/mispel/abgrenzung")
public class SiteMispelNachweisController {

    private static final MediaType CSV = MediaType.parseMediaType("text/csv;charset=UTF-8");

    private final MispelNachweisService nachweise;
    private final RechtPruefung rechte;

    public SiteMispelNachweisController(MispelNachweisService nachweise, RechtPruefung rechte) {
        this.nachweise = nachweise;
        this.rechte = rechte;
    }

    /** Recht: {@code export.standort} (dazu der Leseweg der Anlage). Der Monatsnachweis als CSV. */
    @GetMapping("/monate/{monat}/nachweis.csv")
    public ResponseEntity<byte[]> monatCsv(@PathVariable UUID siteId, @PathVariable String monat,
            @RequestParam(required = false) String empfaenger) {
        MispelNachweis.Empfaenger e = vorher(siteId, empfaenger);
        MispelNachweis.Monat m = nachweise.monat(siteId, monat(monat));
        return datei(MispelNachweis.csv(m, e), CSV, name(m.monat().toString(), e, m.giltAlsNachweis(), "csv"));
    }

    /** Recht: {@code export.standort} (dazu der Leseweg der Anlage). Der Monatsnachweis als PDF. */
    @GetMapping("/monate/{monat}/nachweis.pdf")
    public ResponseEntity<byte[]> monatPdf(@PathVariable UUID siteId, @PathVariable String monat,
            @RequestParam(required = false) String empfaenger) {
        MispelNachweis.Empfaenger e = vorher(siteId, empfaenger);
        MispelNachweis.Monat m = nachweise.monat(siteId, monat(monat));
        return datei(MispelNachweisPdf.datei(m, e), MediaType.APPLICATION_PDF,
                name(m.monat().toString(), e, m.giltAlsNachweis(), "pdf"));
    }

    /** Recht: {@code export.standort} (dazu der Leseweg der Anlage). Der Jahresnachweis als CSV. */
    @GetMapping("/jahre/{jahr}/nachweis.csv")
    public ResponseEntity<byte[]> jahrCsv(@PathVariable UUID siteId, @PathVariable String jahr,
            @RequestParam(required = false) String empfaenger) {
        MispelNachweis.Empfaenger e = vorher(siteId, empfaenger);
        MispelNachweis.Jahr j = nachweise.jahr(siteId, jahr(jahr));
        return datei(MispelNachweis.csv(j, e), CSV, name(String.valueOf(j.jahr()), e, j.giltAlsNachweis(), "csv"));
    }

    /** Recht: {@code export.standort} (dazu der Leseweg der Anlage). Der Jahresnachweis als PDF. */
    @GetMapping("/jahre/{jahr}/nachweis.pdf")
    public ResponseEntity<byte[]> jahrPdf(@PathVariable UUID siteId, @PathVariable String jahr,
            @RequestParam(required = false) String empfaenger) {
        MispelNachweis.Empfaenger e = vorher(siteId, empfaenger);
        MispelNachweis.Jahr j = nachweise.jahr(siteId, jahr(jahr));
        return datei(MispelNachweisPdf.datei(j, e), MediaType.APPLICATION_PDF,
                name(String.valueOf(j.jahr()), e, j.giltAlsNachweis(), "pdf"));
    }

    /** Erst die Anlage (404 außerhalb), dann das Recht (403), dann der Empfänger (400). */
    private MispelNachweis.Empfaenger vorher(UUID siteId, String empfaenger) {
        rechte.pruefenLesen(RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
        rechte.pruefen("export.standort", RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
        return MispelNachweis.empfaenger(empfaenger);
    }

    private static YearMonth monat(String monat) {
        try {
            return YearMonth.parse(monat);
        } catch (DateTimeParseException e) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "„" + monat + "“ ist kein Monat (JJJJ-MM).");
        }
    }

    private static int jahr(String jahr) {
        if (!jahr.matches("\\d{4}")) {
            throw new MispelNachweisAbgelehnt("zeitraum_ungueltig", 400, "„" + jahr + "“ ist kein Jahr (JJJJ).");
        }
        return Integer.parseInt(jahr);
    }

    private static String name(String zeitraum, MispelNachweis.Empfaenger e, boolean endgueltig, String endung) {
        return "mispel-abgrenzung-" + zeitraum + "-" + e.schluessel() + (endgueltig ? "" : "-vorlaeufig") + "."
                + endung;
    }

    private static ResponseEntity<byte[]> datei(byte[] inhalt, MediaType typ, String name) {
        return ResponseEntity.ok().contentType(typ)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + name + "\"").body(inhalt);
    }

    /** {@code {code, message}}. */
    @ExceptionHandler(MispelNachweisAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MispelNachweisAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        return ResponseEntity.status(e.status()).contentType(MediaType.APPLICATION_JSON).body(body);
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).contentType(MediaType.APPLICATION_JSON).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
