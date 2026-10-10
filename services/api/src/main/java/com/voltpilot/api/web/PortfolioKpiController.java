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
 * (die Mengen laufen auf der echten Zeit, nicht auf einer Bühne). Die
 * Leitkennzahl hängt nicht an ihr: sie urteilt auf der Uhr der Kennzahlen wie
 * ihre Karte (Konzept Auswerten a1 §10.8).
 */
@RestController
@RequestMapping("/api/v1/portfolio/kpis")
public class PortfolioKpiController {

    private final PortfolioKpiService service;

    public PortfolioKpiController(PortfolioKpiService service) {
        this.service = service;
    }

    /**
     * Recht: keine eigene Kennung - lesend für jede angemeldete Person; Mandant und sichtbare Anlagen begrenzen RLS und
     * Zugriffs-Zaun wie bei {@code /overview}.
     */
    @GetMapping
    public PortfolioKpiDto kpis() {
        return service.kpis(Instant.now());
    }
}
