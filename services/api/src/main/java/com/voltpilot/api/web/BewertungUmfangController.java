package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BewertungUmfangAbgelehnt;
import com.voltpilot.api.uems.BewertungUmfangService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.BewertungUmfangDto.*;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

/** UEMS AP-16 IP-5: Betrachtungsumfang mit Fassungen und Standort-Zaun. */
@RestController
@RequestMapping("/api/v1/unternehmen/bewertung/umfang")
public class BewertungUmfangController {
    private final BewertungUmfangService dienst;
    private final ObjectMapper json;
    public BewertungUmfangController(BewertungUmfangService dienst,ObjectMapper json) {
        this.dienst=dienst;
        this.json=json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }
    /** Recht: {@code energieeinsatz.ansehen}; nur sichtbare Standorte und Anlagen. */
    @GetMapping
    public Umfang lesen(@RequestParam(required=false) LocalDate am) { return dienst.lesen(am); }

    /** Recht: {@code energieeinsatz.verwalten}; eine Änderung legt eine neue Fassung an. */
    @PutMapping
    @Recht(value="energieeinsatz.verwalten",ziel=RechtZiel.UNTERNEHMEN)
    public Umfang speichern(@RequestBody JsonNode body,Authentication auth) {
        if (body == null || !body.isObject()) throw BewertungUmfangAbgelehnt.anfrage();
        Speichern eingabe;
        try { eingabe=json.treeToValue(body,Speichern.class); }
        catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) { throw BewertungUmfangAbgelehnt.anfrage(); }
        var wer=ProtokollAkteur.aus(auth).orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.UNAUTHORIZED,"Bitte melden Sie sich an."));
        return dienst.speichern(eingabe,wer);
    }
    /** Recht: {@code energieeinsatz.ansehen}; aufgehobene Fassungen bleiben sichtbar. */
    @GetMapping("/fassungen")
    public Historie historie() { return dienst.historie(); }
}
