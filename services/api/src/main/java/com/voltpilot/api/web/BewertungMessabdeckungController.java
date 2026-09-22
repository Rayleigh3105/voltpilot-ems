package com.voltpilot.api.web;

import com.voltpilot.api.uems.BewertungMessabdeckungService;
import com.voltpilot.api.web.dto.BewertungMessabdeckungDto.Messabdeckung;
import java.time.LocalDate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/unternehmen/bewertung/messabdeckung")
public class BewertungMessabdeckungController {
    private final BewertungMessabdeckungService dienst;

    public BewertungMessabdeckungController(BewertungMessabdeckungService dienst) {
        this.dienst = dienst;
    }

    /** Recht: {@code energieeinsatz.ansehen}; derselbe Standort-Zaun und Teilumfang wie die Rangliste. */
    @GetMapping
    public Messabdeckung lesen(@RequestParam LocalDate von, @RequestParam LocalDate bis) {
        return dienst.lesen(von, bis);
    }
}
