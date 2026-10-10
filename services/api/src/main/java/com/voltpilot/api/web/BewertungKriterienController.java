package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BewertungKriterienAbgelehnt;
import com.voltpilot.api.uems.BewertungKriterienService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.BewertungKriterienDto.*;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

/** UEMS AP-16 IP-8: Kriterien-Fassungen und Vier-Augen-Entscheidung. */
@RestController
@RequestMapping("/api/v1/unternehmen/bewertung/kriterien")
public class BewertungKriterienController {
    private final BewertungKriterienService dienst;
    private final ObjectMapper json;
    public BewertungKriterienController(BewertungKriterienService dienst, ObjectMapper json) {
        this.dienst=dienst;
        this.json=json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }
    /** Recht: {@code energieeinsatz.ansehen}; Vorgabe ohne Schreibwirkung, Standort-Zaun im Dienst. */
    @GetMapping
    public Fassung lesen() { return dienst.lesen(); }

    /** Recht: {@code energieeinsatz.ansehen}; jede Fassung einschließlich offener Anträge bleibt lesbar. */
    @GetMapping("/fassungen")
    public Historie historie() { return dienst.historie(); }

    /** Recht: {@code bewertung.kriterien}; Kundenadministrator oder Energiemanager. */
    @PutMapping
    @Recht(value="bewertung.kriterien",ziel=RechtZiel.UNTERNEHMEN)
    public Fassung speichern(@RequestBody JsonNode body, Authentication auth) {
        return dienst.speichern(lesen(body,Speichern.class),akteur(auth));
    }
    /** Recht: {@code bewertung.kriterien}; nur eine zweite Person bestätigt. */
    @PostMapping("/{nummer}/freigeben")
    @Recht(value="bewertung.kriterien",ziel=RechtZiel.UNTERNEHMEN)
    public Fassung freigeben(@PathVariable int nummer, @RequestBody(required=false) JsonNode body, Authentication auth) {
        return dienst.entscheiden(nummer,true,body == null ? null : lesen(body,Entscheidung.class).begruendung(),akteur(auth));
    }
    /** Recht: {@code bewertung.kriterien}; Ablehnung mit Begründung durch eine zweite Person. */
    @PostMapping("/{nummer}/ablehnen")
    @Recht(value="bewertung.kriterien",ziel=RechtZiel.UNTERNEHMEN)
    public Fassung ablehnen(@PathVariable int nummer, @RequestBody JsonNode body, Authentication auth) {
        return dienst.entscheiden(nummer,false,lesen(body,Entscheidung.class).begruendung(),akteur(auth));
    }
    private <T> T lesen(JsonNode body, Class<T> typ) {
        if (body == null || !body.isObject()) throw BewertungKriterienAbgelehnt.anfrage();
        try { return json.treeToValue(body,typ); }
        catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw BewertungKriterienAbgelehnt.anfrage();
        }
    }
    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.UNAUTHORIZED,"Bitte melden Sie sich an."));
    }
}
