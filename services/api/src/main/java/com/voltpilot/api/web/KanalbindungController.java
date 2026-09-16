package com.voltpilot.api.web;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.voltpilot.api.uems.*;
import com.voltpilot.api.zugriff.*;
import java.time.Instant;
import java.util.*;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/bezugsgroessen/{id}/kanalbindung")
public class KanalbindungController {
    private final KanalbindungService service;
    public KanalbindungController(KanalbindungService service) { this.service=service; }
    public record Anfrage(@JsonProperty("entity_id") UUID entityId, String kanal, String zustand, Instant von) {}
    public record Ende(Instant bis) {}

    /** Recht: {@code bezugsgroesse.verwalten}. */
    @PostMapping
    @Recht(value="bezugsgroesse.verwalten",ziel=RechtZiel.BEZUGSGROESSE)
    public ResponseEntity<KanalbindungService.Bindung> binden(@PathVariable UUID id,@RequestBody Anfrage a,Authentication auth) {
        return ResponseEntity.status(201).body(service.binden(id,a.entityId(),a.kanal(),a.zustand(),a.von(),ProtokollAkteur.aus(auth).orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.UNAUTHORIZED,"Anmeldung fehlt."))));
    }
    /** Recht: {@code bezugsgroesse.verwalten}. */
    @PostMapping("/{bindung}/beenden")
    @Recht(value="bezugsgroesse.verwalten",ziel=RechtZiel.BEZUGSGROESSE)
    public KanalbindungService.Bindung beenden(@PathVariable UUID id,@PathVariable UUID bindung,@RequestBody Ende a,Authentication auth) {
        return service.beenden(id,bindung,a.bis(),ProtokollAkteur.aus(auth).orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.UNAUTHORIZED,"Anmeldung fehlt.")));
    }
    /** Recht: {@code messwerte.ansehen}. */
    @GetMapping
    @Recht(value="messwerte.ansehen",ziel=RechtZiel.BEZUGSGROESSE)
    public List<KanalbindungService.Bindung> liste(@PathVariable UUID id) { return service.liste(id); }
}
