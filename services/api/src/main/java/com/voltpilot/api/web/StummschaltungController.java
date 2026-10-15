package com.voltpilot.api.web;

import com.voltpilot.api.ruhezeit.RuhezeitRepository;
import com.voltpilot.api.ruhezeit.StummschaltungService;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Stummschalten (Alerting Scheibe 3, Konzept §6.4): eine Regel, eine Anlage oder ein ganzer
 * Standort, EINMALIG mit Ende-Pflicht. Betrifft ALLE Empfänger der getroffenen Regel(n) - deshalb
 * immer {@code ueberwachung.verwalten} (die Rechte-Matrix nennt das ausdrücklich bei diesem Recht).
 */
@RestController
@RequestMapping("/api/v1/stummschaltungen")
public class StummschaltungController {

    public record Dto(String id, String auswahl, Instant von, Instant bis, String grund, String vonWem) {
        static Dto aus(RuhezeitRepository.StummZeile z) {
            return new Dto(z.id().toString(), z.auswahl().toString(), z.von(), z.bis(), z.grund(), z.vonWem());
        }
    }

    public record Anfrage(String art, String id, Instant bis, String grund) {}

    private final StummschaltungService dienst;

    public StummschaltungController(StummschaltungService dienst) {
        this.dienst = dienst;
    }

    @PostMapping
    @Recht(value = "ueberwachung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<Dto> anlegen(@RequestBody Anfrage anfrage) {
        var aufrufer = RechtPruefung.aufrufer()
                .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.FORBIDDEN));
        UUID zielId = alsUuid(anfrage.id());
        Instant jetzt = Instant.now();
        UUID id = dienst.anlegen(anfrage.art(), zielId, anfrage.bis(), anfrage.grund(), aufrufer, jetzt);
        String vonWem = aufrufer.name() != null ? aufrufer.name() : aufrufer.kennung();
        Dto dto = new Dto(id.toString(), "{\"" + anfrage.art() + "\":\"" + anfrage.id() + "\"}", jetzt,
                anfrage.bis(), anfrage.grund(), vonWem);
        return ResponseEntity.status(org.springframework.http.HttpStatus.CREATED).body(dto);
    }

    @GetMapping
    public List<Dto> aktive() {
        return dienst.aktive(Instant.now()).stream().map(Dto::aus).toList();
    }

    private static UUID alsUuid(String text) {
        try {
            return UUID.fromString(text);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "ungültige Kennung");
        }
    }
}
