package com.voltpilot.api.web;

import com.voltpilot.api.uems.BoxTauschService;
import com.voltpilot.api.uems.BoxTauschZustellung;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/v1/devices")
public class BoxTauschController {
    private final BoxTauschService tausch;
    private final BoxTauschZustellung zustellung;
    public BoxTauschController(BoxTauschService tausch,BoxTauschZustellung zustellung) {
        this.tausch=tausch; this.zustellung=zustellung;
    }

    public record Antwort(BoxTauschService.Ergebnis tausch, boolean zugestellt) {}

    /** Recht: datenquelle.zustaendigkeit; beide Boxen prüft zusätzlich der Dienst. */
    @PostMapping("/{newId}/succeed/{oldId}")
    @Recht(value="datenquelle.zustaendigkeit",ziel=RechtZiel.DEVICE,variable="newId")
    public ResponseEntity<Antwort> succeed(@PathVariable UUID newId,@PathVariable UUID oldId,Authentication auth) {
        ProtokollAkteur actor=ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Bitte melden Sie sich an."));
        var result=tausch.tauschen(newId,oldId,actor);
        // Die Transaktion ist committed. Kein Broker-/PKI-Aufruf während des Datenumbaus.
        boolean delivered=zustellung.zustellen(oldId);
        return ResponseEntity.status(delivered ? HttpStatus.OK : HttpStatus.ACCEPTED)
                .body(new Antwort(result,delivered));
    }
    @org.springframework.web.bind.annotation.ExceptionHandler(com.voltpilot.api.uems.BoxKonflikt.class)
    public ResponseEntity<java.util.Map<String, String>> boxKonflikt(com.voltpilot.api.uems.BoxKonflikt e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

}
