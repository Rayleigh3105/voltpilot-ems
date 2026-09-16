package com.voltpilot.api.web;

import com.voltpilot.api.benutzer.BenutzerService;
import com.voltpilot.api.benutzer.BenutzerService.Anlage;
import com.voltpilot.api.benutzer.BenutzerService.Angelegt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

/** IP-14: die Anlage und Neuvergabe. Liste und übrige Verwaltung folgen mit IP-13. */
@RestController
@RequestMapping("/api/v1/benutzer")
public class BenutzerController {
    private final BenutzerService benutzer;
    public BenutzerController(BenutzerService benutzer) { this.benutzer = benutzer; }

    /** Recht benutzer.verwalten — nur der eigene Kundenadministrator. */
    @PostMapping
    @Recht(value = "benutzer.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Angelegt> anlegen(@RequestBody Anlage body, Authentication auth) {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore())
                .body(benutzer.anlegen(body, ProtokollAkteur.aus(auth).orElseThrow()));
    }

    /** Recht benutzer.verwalten — Mandantenprüfung vor jedem Keycloak-Schreibzugriff. */
    @PostMapping("/{sub}/startpasswort")
    @Recht(value = "benutzer.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Angelegt> neu(@PathVariable String sub, Authentication auth) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(benutzer.neuVergeben(sub, ProtokollAkteur.aus(auth).orElseThrow()));
    }
}
