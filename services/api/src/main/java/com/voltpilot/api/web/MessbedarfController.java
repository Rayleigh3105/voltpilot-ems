package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.EnergieeinsatzAbgelehnt;
import com.voltpilot.api.uems.MessbedarfService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.MessbedarfDto.*;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

/** AP-16 IP-19: Messplanung am Energieeinsatz, ohne Portalfläche. */
@RestController
@RequestMapping("/api/v1/unternehmen/energieeinsaetze/{id}/messbedarf")
public class MessbedarfController {
    private final MessbedarfService dienst;
    private final ObjectMapper json;
    public MessbedarfController(MessbedarfService dienst,ObjectMapper json) {
        this.dienst=dienst; this.json=json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }
    /** Recht: {@code energieeinsatz.ansehen}; verworfene Bedarfe bleiben lesbar. */
    @GetMapping public Liste liste(@PathVariable("id") UUID einsatzId) { return dienst.liste(einsatzId); }
    /** Recht: {@code energieeinsatz.verwalten}. */
    @PostMapping @Recht(value="energieeinsatz.verwalten",ziel=RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Bedarf> anlegen(@PathVariable("id") UUID einsatzId,@RequestBody JsonNode body,Authentication auth) {
        Bedarf b=dienst.anlegen(einsatzId,lies(body,Anlegen.class),wer(auth));
        return ResponseEntity.created(URI.create("/api/v1/unternehmen/energieeinsaetze/"+einsatzId+"/messbedarf/"+b.id())).body(b);
    }
    /** Recht: {@code energieeinsatz.verwalten}; nur solange offen. */
    @PutMapping("/{messbedarfId}") @Recht(value="energieeinsatz.verwalten",ziel=RechtZiel.UNTERNEHMEN)
    public Bedarf bearbeiten(@PathVariable("id") UUID einsatzId,@PathVariable UUID messbedarfId,@RequestBody JsonNode body,Authentication auth) {
        return dienst.bearbeiten(einsatzId,messbedarfId,lies(body,Bearbeiten.class),wer(auth));
    }
    /** Recht: {@code energieeinsatz.verwalten}; nur mit eingerichteter Messstelle im Zaun. */
    @PostMapping("/{messbedarfId}/einloesen") @Recht(value="energieeinsatz.verwalten",ziel=RechtZiel.UNTERNEHMEN)
    public Bedarf einloesen(@PathVariable("id") UUID einsatzId,@PathVariable UUID messbedarfId,@RequestBody JsonNode body,Authentication auth) {
        return dienst.einloesen(einsatzId,messbedarfId,lies(body,Einloesen.class),wer(auth));
    }
    /** Recht: {@code energieeinsatz.verwalten}; Begründung ist Pflicht. */
    @PostMapping("/{messbedarfId}/verwerfen") @Recht(value="energieeinsatz.verwalten",ziel=RechtZiel.UNTERNEHMEN)
    public Bedarf verwerfen(@PathVariable("id") UUID einsatzId,@PathVariable UUID messbedarfId,@RequestBody JsonNode body,Authentication auth) {
        return dienst.verwerfen(einsatzId,messbedarfId,lies(body,Verwerfen.class),wer(auth));
    }
    /** Recht: {@code energieeinsatz.ansehen}; unveränderliches Messbedarf-Protokoll. */
    @GetMapping("/{messbedarfId}/protokoll") public Protokoll protokoll(@PathVariable("id") UUID einsatzId,@PathVariable UUID messbedarfId) {
        return dienst.protokoll(einsatzId,messbedarfId);
    }
    private <T>T lies(JsonNode body,Class<T> typ) {
        if(body==null||!body.isObject()) throw EnergieeinsatzController.anfrage();
        try{return json.treeToValue(body,typ);}catch(Exception e){throw EnergieeinsatzController.anfrage();}
    }
    private static ProtokollAkteur wer(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.UNAUTHORIZED,"Bitte melden Sie sich an."));
    }
}
