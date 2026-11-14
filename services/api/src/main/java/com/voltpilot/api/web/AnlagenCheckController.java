package com.voltpilot.api.web;

import com.voltpilot.api.anlagencheck.AnlagenCheckDto;
import com.voltpilot.api.anlagencheck.AnlagenCheckService;
import com.voltpilot.api.anlagencheck.SpeicherBilanzDto;
import com.voltpilot.api.history.HistoryRange;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Anlagen-Check des Privatkunden (Bedienkonzept vp-privatkunde-bedienkonzept §9.2 A2/A5): die Kachel „Solaranlage",
 * die Karte „Erzeugung nach Einheiten" und die Speicher-Bilanz der Geräteseite.
 *
 * <p>Mandantenbezogen wie jede {@code /sites/**}-Lese-Route: kein {@code @PreAuthorize}, RLS plus
 * {@code geltungsbereich.requireSite} im Service - eine fremde Anlage ist 404, nie 403. Nur lesend.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class AnlagenCheckController {

    private final AnlagenCheckService service;

    public AnlagenCheckController(AnlagenCheckService service) {
        this.service = service;
    }

    /**
     * @param z optional der Zeitraum der Karte ({@code tag|woche|monat|jahr}, wie {@code /history}); ohne nur die
     *     Kachel
     * @param at ein Tag im Zeitraum (Vorgabe heute)
     */
    @GetMapping("/anlagen-check")
    public AnlagenCheckDto anlagenCheck(@PathVariable UUID siteId,
            @RequestParam(required = false) String z,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate at) {
        HistoryRange range = null;
        if (z != null && !z.isBlank()) {
            range = zeitraum(z);
            if (range == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "z muss tag, woche, monat oder jahr sein");
            }
        }
        return service.anlagenCheck(siteId, range, at);
    }

    @GetMapping("/speicher-bilanz")
    public SpeicherBilanzDto speicherBilanz(@PathVariable UUID siteId) {
        return service.speicherBilanz(siteId);
    }

    /** Die Wörter des Portals ({@code z=} der Verlauf-Adresse) und die englischen von {@code /history}. */
    static HistoryRange zeitraum(String z) {
        return switch (z.trim().toLowerCase(java.util.Locale.ROOT)) {
            case "tag", "day" -> HistoryRange.DAY;
            case "woche", "week" -> HistoryRange.WEEK;
            case "monat", "month" -> HistoryRange.MONTH;
            case "jahr", "year" -> HistoryRange.YEAR;
            default -> null;
        };
    }
}
