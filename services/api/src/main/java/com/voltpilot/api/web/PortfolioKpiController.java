package com.voltpilot.api.web;

import com.voltpilot.api.uems.PortfolioKpiService;
import com.voltpilot.api.web.dto.PortfolioKpiDto;
import java.time.Instant;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Portfolio-Kennzahlen des UEMS-Übersichts-Kachelrasters (Konzept
 * {@code vp-portfolio-konzept2-p2} §4.2): eine authentifizierte Leseroute, der
 * Mandant und die sichtbaren Anlagen kommen aus RLS/Zugriffs-Zaun (wie
 * {@code /overview}), nie aus dem Request. Die Aggregation macht
 * {@link PortfolioKpiService}; dieser Controller reicht nur die echte Uhr durch
 * (die Mengen laufen auf der echten Zeit, nicht auf einer Bühne).
 */
@RestController
@RequestMapping("/api/v1/portfolio/kpis")
public class PortfolioKpiController {

    private final PortfolioKpiService service;

    public PortfolioKpiController(PortfolioKpiService service) {
        this.service = service;
    }

    // Rechte: lesendes Aggregat, keine eigene Kennung (wie GET /overview, AP-03 §4.5 R-A2).
    // authenticated() plus Mandanten-/Standort-RLS: nur die sichtbaren Anlagen, nie aus dem Request.
    @GetMapping
    public PortfolioKpiDto kpis() {
        return service.kpis(Instant.now());
    }
}
