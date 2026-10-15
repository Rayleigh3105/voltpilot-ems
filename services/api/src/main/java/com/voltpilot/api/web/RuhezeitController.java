package com.voltpilot.api.web;

import com.voltpilot.api.ruhezeit.RuhezeitRepository;
import com.voltpilot.api.ruhezeit.RuhezeitService;
import com.voltpilot.api.zugriff.RechtPruefung;
import java.time.Instant;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * "Ruhezeit" in der Einstellungsfläche "So erreichen wir Sie" (Alerting Scheibe 3, Konzept §6.4,
 * §6.8 Entwurf 4): wiederkehrend je Person, Vorgabe "werktags 22 bis 7 Uhr, am Wochenende ganz",
 * Schalter "Dringendes trotzdem melden" (Entscheid 8A, Vorgabe AN). Jede Person verwaltet NUR ihre
 * eigene Ruhezeit - kein Recht über die Matrix nötig, wie {@link ZustellwegController}.
 */
@RestController
@RequestMapping("/api/v1/ruhezeit")
public class RuhezeitController {

    public record Zustand(String regeln, String zeitzone, boolean dringendDurch) {
        static Zustand aus(RuhezeitRepository.RuhezeitPerson p) {
            return new Zustand(p.regeln().toString(), p.zeitzone(), p.dringendDurch());
        }

        static Zustand vorgabe() {
            return new Zustand(RuhezeitService.VORGABE_REGELN_JSON, "Europe/Berlin", true);
        }
    }

    public record Anfrage(String regeln, String zeitzone, boolean dringendDurch) {}

    public record ProbeAntwort(Instant aktivBis) {}

    private final RuhezeitService ruhezeit;

    public RuhezeitController(RuhezeitService ruhezeit) {
        this.ruhezeit = ruhezeit;
    }

    @GetMapping
    public Zustand eigene() {
        String sub = eigenerSub();
        return ruhezeit.eigene(sub).map(Zustand::aus).orElseGet(Zustand::vorgabe);
    }

    @PutMapping
    public ResponseEntity<Void> setzen(@RequestBody Anfrage anfrage) {
        ruhezeit.setzen(eigenerSub(), anfrage.regeln(), anfrage.zeitzone(), anfrage.dringendDurch());
        return ResponseEntity.noContent().build();
    }

    /** Live-Vorschau im Blatt: "Ruhezeit ist jetzt aktiv bis …" - ohne zu speichern. */
    @PostMapping("/probe")
    public ProbeAntwort probe(@RequestBody Anfrage anfrage) {
        return new ProbeAntwort(ruhezeit.probeAktivBis(anfrage.regeln(), anfrage.zeitzone(), Instant.now())
                .orElse(null));
    }

    private static String eigenerSub() {
        return RechtPruefung.aufrufer().map(b -> b.kennung())
                .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.FORBIDDEN));
    }
}
