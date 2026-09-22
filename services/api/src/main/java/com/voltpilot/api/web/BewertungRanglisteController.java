package com.voltpilot.api.web;

import com.voltpilot.api.uems.BewertungRanglisteService;
import com.voltpilot.api.web.dto.BewertungRanglisteDto.Rangliste;
import java.time.LocalDate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/unternehmen/bewertung/rangliste")
public class BewertungRanglisteController {
    private final BewertungRanglisteService dienst;
    public BewertungRanglisteController(BewertungRanglisteService dienst) { this.dienst=dienst; }
    /** Recht: {@code energieeinsatz.ansehen}; Standort-Zaun, Mengen ohne Kriterien oder Einstufung. */
    @GetMapping
    public Rangliste lesen(@RequestParam LocalDate von,@RequestParam LocalDate bis) { return dienst.lesen(von,bis); }
}
