package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.AnlageUmzugService;
import com.voltpilot.api.uems.OrtAbgelehnt;
import com.voltpilot.api.web.dto.AnlageUmzugDto;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Eine Anlage einem Standort zuordnen oder umziehen (UEMS AP-02 IP-11, Mockup T6, A11): die
 * Folgen-Vorschau und der Eintrag mit „gültig ab" ({@link AnlageUmzugService}). Beide antworten
 * mit derselben Form; eine Ablehnung ist {@code {code, message, feld}} ({@link OrtAbgelehntHandler})
 * mit dem Satz des Ortsbaum-Vertrags. Die Zuordnung ändert keinen Regelkreis: Box, Topics,
 * Freigaben, Betriebsmodell, Ladepark-Rahmen und Fahrpläne bleiben, und es wird nichts gesendet.
 *
 * <p>Mandantengebunden wie {@code /api/v1/sites/**}: {@code authenticated()} plus RLS — eine fremde
 * Anlage ist 404, ein fremder Standort im Rumpf 400 wie jede unbekannte ID der Ortsstruktur.
 * Keine eigene Rechte-Annotation; jede Route nennt ihre Kennung im Kommentar (AP-03).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/standort")
public class AnlageStandortController {

    private final AnlageUmzugService umzug;
    private final OrtAnfrage anfrage;

    public AnlageStandortController(AnlageUmzugService umzug, OrtAnfrage anfrage) {
        this.umzug = umzug;
        this.anfrage = anfrage;
    }

    // Rechte: `anlage.zuordnen` — die Vorschau gehört zum Dialog „Standort ändern" (T6).
    @GetMapping("/vorschau")
    public AnlageUmzugDto.Umzug vorschau(@PathVariable UUID siteId,
            @RequestParam(required = false) String standortId,
            @RequestParam(required = false) String gueltigAb) {
        return umzug.vorschau(siteId, uuid(standortId), tag(gueltigAb));
    }

    // Rechte: `anlage.zuordnen`; mit „gültig ab" vor heute zusätzlich `aenderung.rueckwirkend`.
    @PutMapping
    public AnlageUmzugDto.Umzug umziehen(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        AnlageUmzugDto.Anfrage a = anfrage.lies(body, AnlageUmzugDto.Anfrage.class, false);
        return umzug.umziehen(siteId, a, OrtAnfrage.akteur(auth));
    }

    private static UUID uuid(String roh) {
        if (roh == null || roh.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(roh);
        } catch (IllegalArgumentException e) {
            throw OrtAbgelehnt.anfrage("standortId", "„standortId“ hat nicht die erwartete Form.");
        }
    }

    private static LocalDate tag(String roh) {
        if (roh == null || roh.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(roh);
        } catch (DateTimeParseException e) {
            throw OrtAbgelehnt.anfrage("gueltigAb", "„gueltigAb“ hat nicht die erwartete Form.");
        }
    }
}
