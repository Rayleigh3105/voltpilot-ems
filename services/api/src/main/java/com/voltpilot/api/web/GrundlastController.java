package com.voltpilot.api.web;

import com.voltpilot.api.grundlast.GrundlastDto;
import com.voltpilot.api.grundlast.GrundlastService;
import com.voltpilot.api.grundlast.GrundlastService.Zeitraum;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.zugriff.Geltungsbereich;
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
 * <b>Grundlast</b> einer Anlage – „Was läuft bei mir immer?“ (Bedienkonzept Privatkunde §5, Paket G1):
 * die typische Nacht (niedrigste Viertelstunde 0–5 Uhr, Median), Wert je Nacht oder Monat, Vorperiode,
 * kWh am Tag, Anteil am Verbrauch und die Aufteilung je Unterzähler. Nur lesend; der Mandant kommt aus
 * dem Token (RLS), eine fremde oder unsichtbare Anlage ist 404. Rechenregel: {@code GrundlastRegel}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/grundlast")
public class GrundlastController {

    private final Geltungsbereich geltungsbereich;
    private final GrundlastService grundlast;

    public GrundlastController(Geltungsbereich geltungsbereich, GrundlastService grundlast) {
        this.geltungsbereich = geltungsbereich;
        this.grundlast = grundlast;
    }

    /**
     * @param z {@code tag | woche | monat | jahr} wie der Verlauf, oder {@code aktuell} (die letzten
     *     14 Nächte, für die Kachel; {@code at} zählt dort nicht)
     * @param at ein Datum im Zeitraum (Vorgabe: heute, Europe/Berlin)
     */
    @GetMapping
    public GrundlastDto get(
            @PathVariable UUID siteId,
            @RequestParam(defaultValue = "woche") String z,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate at) {
        Zeitraum zeitraum = Zeitraum.parse(z);
        if (zeitraum == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "z muss tag, woche, monat, jahr oder aktuell sein");
        }
        geltungsbereich.requireSite(siteId);
        return grundlast.grundlast(siteId, zeitraum, at != null ? at : LocalDate.now(HistoryRange.ZONE));
    }
}
