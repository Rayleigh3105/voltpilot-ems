package com.voltpilot.api.web;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.voltpilot.api.repo.PreisfassungRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;

/**
 * Die Preisfassungen einer Anlage lesen (vp-tarif-ab-tag): ab welchem Tag
 * welcher Tarif, welches Preisblatt und welche angegebene Einspeisevergütung
 * gilt. Geschrieben wird über die bestehenden Wege (Anlage, Preisblatt,
 * Einspeisevergütung) mit ihrem Feld „Ab wann?“; diese Route zeigt nur, was
 * daraus geworden ist. RLS-begrenzt wie jede {@code /api/v1/sites/**}-Lesung:
 * eine fremde Anlage ist 404.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/preisfassungen")
public class SitePreisfassungController {

    /**
     * Eine Fassung, wie das Portal sie zeigt: {@code gueltigAb} {@code null} =
     * von Anfang an; sie gilt bis zum Vortag der nächsten.
     */
    public record FassungDto(
            LocalDate gueltigAb,
            String tarifArt,
            BigDecimal tarifParamCtKwh,
            boolean preisblatt,
            BigDecimal einspeiseverguetungCtKwh) {
    }

    private final PreisfassungRepository preisfassungen;
    private final Geltungsbereich geltungsbereich;

    public SitePreisfassungController(PreisfassungRepository preisfassungen, Geltungsbereich geltungsbereich) {
        this.preisfassungen = preisfassungen;
        this.geltungsbereich = geltungsbereich;
    }

    /** Die wirksamen Fassungen in Tagesfolge; die letzte gilt heute. */
    @GetMapping
    public List<FassungDto> liste(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        return preisfassungen.fassungen(siteId).stream()
                .map(f -> new FassungDto(f.gueltigAb(), f.tarifArt(), f.tarifParamCtKwh(), f.preisblatt(),
                        f.einspeiseverguetungCtKwh()))
                .toList();
    }
}
