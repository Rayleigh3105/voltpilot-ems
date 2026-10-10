package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.MessmittelAbgelehnt;
import com.voltpilot.api.uems.MessmittelService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.MessmittelDto.Angaben;
import com.voltpilot.api.web.dto.MessmittelDto.Eintrag;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** UEMS AP-16 IP-15/IP-16 (G1–G4): Einbau-Angaben und getrennte Herstellerangaben. */
@RestController
public class MessmittelController {
    private final MessmittelService messmittel;
    private final ObjectMapper streng;

    public MessmittelController(MessmittelService messmittel, ObjectMapper json) {
        this.messmittel = messmittel;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code messwerte.ansehen} — die Angaben gehören zur Sicht auf das Gerät; ohne Angabe
     * {@code nicht_erhoben}, nie ein Vorgabewert.
     */
    @GetMapping("/api/v1/geraete/{id}/messmittel")
    public Angaben lesen(@PathVariable UUID id) {
        return messmittel.lesen(id);
    }

    /**
     * Recht: {@code messmittel.angaben} — Standort-Zaun über den Einbauort (die Anlage des Geräts); ein
     * Beleg ohne gültige SHA-256 ist 422, jede Änderung steht als {@code messmittel_angabe} im Protokoll.
     */
    @PutMapping("/api/v1/geraete/{id}/messmittel")
    @Recht(value = "messmittel.angaben", ziel = RechtZiel.GERAET)
    public Angaben eintragen(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return messmittel.eintragen(id, lies(body), akteur(auth));
    }

    private Eintrag lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw MessmittelAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, Eintrag.class);
        } catch (JsonProcessingException | IllegalArgumentException e) {
            throw MessmittelAbgelehnt.anfrage("", "Bitte prüfen Sie die Angaben Ihrer Anfrage.");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }
}
