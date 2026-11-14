package com.voltpilot.api.web;

import com.voltpilot.api.abrechnung.AbrechnungService;
import com.voltpilot.api.abrechnung.AbrechnungService.AbrechnungDto;
import com.voltpilot.api.abrechnung.AbrechnungService.PruefungDto;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.history.Zeitraum;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * „Abrechnung prüfen" (Bedienkonzept vp-privatkunde-bedienkonzept §7, Pakete R2/R3): die gemessenen Mengen am
 * Netzanschluss für einen Zeitraum in ganzen Tagen und die Zahlen, die der Kunde von seiner Rechnung
 * danebenschreibt. Lesen darf jeder, der die Anlage sieht; schreiben, wer eine eigene Auswertung der Anlage
 * anlegen darf ({@code auswertung.anlegen}). Eine fremde Anlage ist 404, nie 403.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/abrechnung")
public class AbrechnungController {

    /** Obergrenze einer Eingabe: zehn Milliarden kWh - darüber ist es ein Tippfehler, keine Rechnung. */
    private static final BigDecimal MAX_KWH = new BigDecimal("10000000000");

    private final AbrechnungService abrechnung;
    private final SiteRepository sites;

    public AbrechnungController(AbrechnungService abrechnung, SiteRepository sites) {
        this.abrechnung = abrechnung;
        this.sites = sites;
    }

    /** Die Zahlen von der Rechnung; {@code null} = nicht eingetragen. */
    public record PruefungRequest(BigDecimal bezugKwh, BigDecimal einspeisungKwh) {
    }

    /**
     * Netzbezug und Einspeisung im Zeitraum: Menge, Zählerstände (wenn ein Zähler am Netzanschluss sie liefert),
     * Herkunft, Lückentage, Messbeginn und die gespeicherte Prüfung.
     */
    @GetMapping
    public AbrechnungDto abrechnung(@PathVariable UUID siteId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate von,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate bis) {
        SiteDto site = site(siteId);
        return abrechnung.abrechnung(siteId, site.biddingZone(), zeitraum(von, bis));
    }

    /** Alle gespeicherten Prüfungen der Anlage („Frühere Prüfungen"), der jüngste Zeitraum zuerst. */
    @GetMapping("/pruefungen")
    public List<PruefungDto> pruefungen(@PathVariable UUID siteId) {
        site(siteId);
        return abrechnung.liste(siteId);
    }

    /** Die Prüfung genau dieses Zeitraums; 204 ohne Eintrag. */
    @GetMapping("/pruefung")
    public ResponseEntity<PruefungDto> pruefung(@PathVariable UUID siteId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate von,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate bis) {
        site(siteId);
        PruefungDto p = abrechnung.lese(siteId, zeitraum(von, bis));
        return p == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(p);
    }

    /**
     * Schreibt die Zahlen von der Rechnung für den Zeitraum. Ein leeres Feld ({@code null}) löscht nur seine
     * Zahl; sind beide leer, verschwindet die Prüfung (204).
     */
    @PutMapping("/pruefung")
    @Recht(value = "auswertung.anlegen", ziel = RechtZiel.ANLAGE)
    public ResponseEntity<PruefungDto> schreibe(@PathVariable UUID siteId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate von,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate bis,
            @RequestBody PruefungRequest body,
            @AuthenticationPrincipal Jwt caller) {
        site(siteId);
        Zeitraum z = zeitraum(von, bis);
        BigDecimal bezug = menge(body == null ? null : body.bezugKwh(), "bezugKwh");
        BigDecimal einspeisung = menge(body == null ? null : body.einspeisungKwh(), "einspeisungKwh");
        PruefungDto p = abrechnung.schreibe(siteId, z, bezug, einspeisung,
                caller == null ? null : caller.getSubject());
        return p == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(p);
    }

    /** Löscht die Prüfung des Zeitraums (204, auch wenn es keine gab). */
    @DeleteMapping("/pruefung")
    @Recht(value = "auswertung.anlegen", ziel = RechtZiel.ANLAGE)
    public ResponseEntity<Void> loesche(@PathVariable UUID siteId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate von,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate bis) {
        site(siteId);
        abrechnung.loesche(siteId, zeitraum(von, bis));
        return ResponseEntity.noContent().build();
    }

    private SiteDto site(UUID siteId) {
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return site;
    }

    private static Zeitraum zeitraum(LocalDate von, LocalDate bis) {
        String fehler = Zeitraum.pruefe(von, bis, LocalDate.now(HistoryRange.ZONE));
        if (fehler != null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, fehler);
        }
        return new Zeitraum(von, bis);
    }

    private static BigDecimal menge(BigDecimal v, String feld) {
        if (v == null) {
            return null;
        }
        if (v.signum() < 0 || v.compareTo(MAX_KWH) >= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, feld + " muss zwischen 0 und 10^10 kWh liegen");
        }
        return v.setScale(3, java.math.RoundingMode.HALF_UP);
    }
}
