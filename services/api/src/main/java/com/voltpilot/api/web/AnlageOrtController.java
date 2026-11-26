package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.AnlageOrtService;
import com.voltpilot.api.web.dto.AnlageOrtDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * „Ort berichtigen" (vp-standort-konzept §6.1, B1/B3/B6): EIN Schreibweg für Adresse und
 * Kartenpunkt einer Anlage statt drei getrennter — {@link AnlageOrtService}. Nie ein Datum
 * (eine Korrektur, kein Umzug); die Zuordnung „Gehört zu" bleibt {@code AnlageStandortController}.
 *
 * <p>Rechte: {@code anlage.ort_berichtigen} (E2 = A, vp-standort-konzept §7) - Kundenadministrator
 * und Energiemanager unternehmensweit, Unterstützer ab Umfang „Einrichten" (befristet, Banner und
 * Protokoll wie jede Unterstützung), VoltPilot-Betrieb. Bearbeiter bekommt das Recht nicht (wie
 * {@code standort.verwalten}); „Gehört zu" ändern bleibt separat {@code anlage.zuordnen}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/ort")
public class AnlageOrtController {

    private final AnlageOrtService ort;
    private final OrtAnfrage anfrage;

    public AnlageOrtController(AnlageOrtService ort, OrtAnfrage anfrage) {
        this.ort = ort;
        this.anfrage = anfrage;
    }

    @PutMapping
    @Recht(value = "anlage.ort_berichtigen", ziel = RechtZiel.ANLAGE)
    public AnlageOrtDto.Ergebnis berichtigen(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        AnlageOrtDto.Anfrage a = anfrage.lies(body, AnlageOrtDto.Anfrage.class, false);
        return ort.berichtigen(siteId, a, OrtAnfrage.akteur(auth));
    }
}
