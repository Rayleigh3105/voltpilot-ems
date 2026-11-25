package com.voltpilot.api.web;

import com.voltpilot.api.direktvermarktung.PartnerKatalog;
import com.voltpilot.api.web.dto.DirektvermarktungDto.PartnerDto;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der Partnerkatalog der Direktvermarktung (E6 = A "Partnerkatalog als Daten", Konzept
 * vp-direktvermarktung-konzept d2 §5.3/§5.8): die Partner, zwischen denen ein Kunde auf Bildschirm 4
 * "Direktvermarkter wählen" wählt. Mandantenlos - der Katalog ist dieselbe Liste für jede Anlage.
 */
@RestController
@RequestMapping("/api/v1/direktvermarkter")
public class DirektvermarkterKatalogController {

    private final PartnerKatalog katalog;

    public DirektvermarkterKatalogController(PartnerKatalog katalog) {
        this.katalog = katalog;
    }

    @GetMapping
    public List<PartnerDto> katalog() {
        return katalog.alle().stream().map(PartnerDto::von).toList();
    }
}
