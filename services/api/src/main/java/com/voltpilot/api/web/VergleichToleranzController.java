package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.MessmittelAbgelehnt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.VergleichToleranzService;
import com.voltpilot.api.web.dto.VergleichToleranzDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS AP-16 IP-17 (G5, E10 = A): Monatsvergleich führend ↔ Vergleich je Vergleichsquelle und die Toleranz als
 * Fassung. Gelesen am Messstellen-Weg — der Befund gehört an die Messstelle, und ihr Standort-Zaun gilt (AP-04).
 */
@RestController
public class VergleichToleranzController {
    private final VergleichToleranzService vergleich;
    private final ObjectMapper streng;

    public VergleichToleranzController(VergleichToleranzService vergleich, ObjectMapper json) {
        this.vergleich = vergleich;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code messwerte.ansehen} — je Vergleichsquelle die Monate {@code von}–{@code bis} (JJJJ-MM; ohne
     * Angabe der letzte volle Monat) mit beiden Mengen, Abweichung und Toleranz-Fassung; außerhalb des Zugriffs 404.
     * Ein Befund {@code abweichung_vergleichsquelle} nennt nie eine Ursache und ändert keinen Wert.
     */
    @GetMapping("/api/v1/messstellen/{kennzeichen}/vergleich")
    public VergleichToleranzDto.Vergleich lesen(@PathVariable String kennzeichen,
            @RequestParam(required = false) String von, @RequestParam(required = false) String bis) {
        return vergleich.lesen(kennzeichen, von, bis);
    }

    /**
     * Recht: {@code messmittel.angaben} (AP-16 §5.4, R9) — Standort-Zaun über die Messstelle. Eine neue
     * Toleranz-Fassung n + 1 mit Begründung, gültig ab dem laufenden Monat, nie rückwirkend: 201. Dieselbe Toleranz
     * wie die wirksame schreibt nichts: 200 mit der wirksamen Fassung.
     */
    @PostMapping("/api/v1/messstellen/{id}/quellen/{quelleId}/toleranz")
    @Recht(value = "messmittel.angaben", ziel = RechtZiel.MESSSTELLE)
    public ResponseEntity<VergleichToleranzDto.Toleranz> eintragen(@PathVariable UUID id,
            @PathVariable UUID quelleId, @RequestBody(required = false) JsonNode body, Authentication auth) {
        VergleichToleranzService.Ergebnis e = vergleich.eintragen(id, quelleId, lies(body), akteur(auth));
        return ResponseEntity.status(e.geschrieben() ? HttpStatus.CREATED : HttpStatus.OK).body(e.toleranz());
    }

    private VergleichToleranzDto.Eintrag lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw MessmittelAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, VergleichToleranzDto.Eintrag.class);
        } catch (JsonProcessingException | IllegalArgumentException e) {
            throw MessmittelAbgelehnt.anfrage("", "Bitte prüfen Sie die Angaben Ihrer Anfrage.");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }
}
