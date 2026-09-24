package com.voltpilot.api.web;

import com.voltpilot.api.uems.VerbesserungUebersicht;
import com.voltpilot.api.web.dto.VerbesserungUebersichtDto;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Übersicht „Ziele und Maßnahmen“ (UEMS AP-18 IP-19, F1–F3, W7): Zähler je Art und je fälligem Vorgang eine Zeile,
 * beim Abruf abgeleitet — kein Läufer, kein Ereignis, keine Nachricht. Die Arbeit macht {@link VerbesserungUebersicht}.
 */
@RestController
@RequestMapping("/api/v1/verbesserung/uebersicht")
public class VerbesserungUebersichtController {

    private final VerbesserungUebersicht uebersicht;

    public VerbesserungUebersichtController(VerbesserungUebersicht uebersicht) {
        this.uebersicht = uebersicht;
    }

    /**
     * Recht: {@code verbesserung.ansehen} (Zaun über Standort und Kennzahl — was außerhalb liegt, zählt nicht). Stichtag
     * ist die Uhr der Kennzahlen, dieselbe wie in den Registern der Maßnahmen und Energieziele.
     */
    @GetMapping
    public VerbesserungUebersichtDto.Uebersicht lesen() {
        return uebersicht.lesen();
    }
}
