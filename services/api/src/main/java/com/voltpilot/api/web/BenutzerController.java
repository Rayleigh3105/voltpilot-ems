package com.voltpilot.api.web;

import com.voltpilot.api.benutzer.BenutzerService;
import com.voltpilot.api.benutzer.BenutzerVerwaltung;
import java.time.Instant;
import java.util.List;
import com.voltpilot.api.benutzer.BenutzerService.Anlage;
import com.voltpilot.api.benutzer.BenutzerService.Angelegt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

/** Kundenverwaltung (AP-03 IP-13/IP-14), hinter Mandanten- und Rechtezaun. */
@RestController
@RequestMapping("/api/v1/benutzer")
public class BenutzerController {
    private final BenutzerService benutzer;
    private final BenutzerVerwaltung verwaltung;
    public BenutzerController(BenutzerService benutzer, BenutzerVerwaltung verwaltung) {
        this.benutzer = benutzer; this.verwaltung = verwaltung;
    }

    /** Recht: keine eigene Kennung — lesend nur Kundenadministrator und Energiemanager, RLS. */
    @GetMapping
    public List<BenutzerVerwaltung.Eintrag> liste() { return verwaltung.liste(); }

    /** Recht zugriffsprotokoll.lesen — Kundenadministrator, Zeitraum halboffen. */
    @GetMapping("/protokoll")
    public List<BenutzerVerwaltung.Protokoll> protokoll(@RequestParam Instant von, @RequestParam Instant bis) {
        return verwaltung.protokoll(von, bis);
    }

    /** Recht benutzer.verwalten — atomarer Wechsel über den bestehenden Zuweisungs-Prüfpunkt. */
    @PutMapping("/{sub}/zugriff")
    @Recht(value = "benutzer.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Void> wechseln(@PathVariable String sub, @RequestBody BenutzerVerwaltung.Wechsel body, Authentication auth) {
        verwaltung.wechseln(sub, body, ProtokollAkteur.aus(auth).orElseThrow());
        return ResponseEntity.noContent().build();
    }

    /** Recht benutzer.verwalten — sofortiger Entzug, A8 schützt die eigene Rolle und den letzten Administrator. */
    @PostMapping("/{sub}/sperren")
    @Recht(value = "benutzer.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Void> sperren(@PathVariable String sub, Authentication auth) {
        verwaltung.beenden(sub, false, ProtokollAkteur.aus(auth).orElseThrow());
        return ResponseEntity.noContent().build();
    }

    /** Recht benutzer.verwalten — Entfernung des Zugangs, Identität und Protokoll bleiben erhalten. */
    @DeleteMapping("/{sub}")
    @Recht(value = "benutzer.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Void> entfernen(@PathVariable String sub, Authentication auth) {
        verwaltung.beenden(sub, true, ProtokollAkteur.aus(auth).orElseThrow());
        return ResponseEntity.noContent().build();
    }

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
