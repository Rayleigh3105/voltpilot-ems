package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.AblesungAbgelehnt;
import com.voltpilot.api.uems.AblesungRepository;
import com.voltpilot.api.uems.AblesungService;
import com.voltpilot.api.uems.MessstelleRepository;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** UEMS AP-09 IP-8: Ablesungen erfassen, berichtigen und mit Herkunft lesen. */
@RestController
@RequestMapping("/api/v1/messstellen/{kennzeichen}/ablesungen")
public class AblesungController {
    private final AblesungService service;
    private final MessstelleRepository messstellen;
    private final RechtPruefung rechte;
    public AblesungController(AblesungService service, MessstelleRepository messstellen, RechtPruefung rechte) {
        this.service=service; this.messstellen=messstellen; this.rechte=rechte;
    }

    /** Recht: {@code messwerte.ansehen}. Die Fassungen samt ihrer Herkunft, auch nach Rohwert-Aufbewahrung. */
    @GetMapping
    public List<AblesungRepository.Wert> lesen(@PathVariable String kennzeichen) {
        recht(kennzeichen,"messwerte.ansehen"); return service.lesen(kennzeichen);
    }

    /** Recht: {@code ablesung.erfassen}. Ziel wird vor dem Lesen des Körpers aus dem Kennzeichen aufgelöst. */
    @PostMapping
    public AblesungService.Antwort eingeben(@PathVariable String kennzeichen,
            @RequestBody(required=false) JsonNode body, Authentication auth) {
        recht(kennzeichen,"ablesung.erfassen");
        pruefen(body,Set.of("zeitpunkt","stand","zuordnung_monat"));
        return service.eingeben(kennzeichen,text(body,"zeitpunkt"),text(body,"stand"),text(body,"zuordnung_monat"),
                body.has("zuordnung_monat"),null,false,akteur(auth));
    }

    /** Recht: {@code ablesung.erfassen}. Fassung n + 1; Freigabe über die bestehende Korrekturroute. */
    @PostMapping("/{zeitpunkt}/berichtigung")
    public AblesungService.Antwort berichtigen(@PathVariable String kennzeichen,@PathVariable String zeitpunkt,
            @RequestBody(required=false) JsonNode body, Authentication auth) {
        recht(kennzeichen,"ablesung.erfassen");
        pruefen(body,Set.of("stand","zuordnung_monat","begruendung"));
        return service.eingeben(kennzeichen,zeitpunkt,text(body,"stand"),text(body,"zuordnung_monat"),
                body.has("zuordnung_monat"),text(body,"begruendung"),true,akteur(auth));
    }
    private void recht(String kz,String aktion) {
        var m=messstellen.findeNachKennzeichen(kz).orElseThrow(()->new AblesungAbgelehnt(AblesungAbgelehnt.Grund.NICHT_GEFUNDEN));
        rechte.pruefen(aktion,RechtZiel.MESSSTELLE,m.id(),()->new AblesungAbgelehnt(AblesungAbgelehnt.Grund.NICHT_GEFUNDEN));
    }
    private static void pruefen(JsonNode n,Set<String> erlaubt) {
        if (n==null || !n.isObject()) throw new AblesungAbgelehnt(AblesungAbgelehnt.Grund.ANFRAGE_UNGUELTIG);
        n.fields().forEachRemaining(e->{
            if (!erlaubt.contains(e.getKey()) || (!e.getValue().isNull() && !e.getValue().isTextual()))
                throw new AblesungAbgelehnt(AblesungAbgelehnt.Grund.ANFRAGE_UNGUELTIG,Map.of("feld",e.getKey()));
        });
    }
    private static String text(JsonNode n,String k) { return n.hasNonNull(k)?n.get(k).asText():null; }
    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(()->new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.UNAUTHORIZED,"Anmeldung erforderlich."));
    }
    @ExceptionHandler(AblesungAbgelehnt.class)
    public ResponseEntity<Map<String,Object>> abgelehnt(AblesungAbgelehnt e) {
        Map<String,Object> b=new LinkedHashMap<>(e.fakten);
        b.put("code",e.grund.name().toLowerCase(Locale.ROOT)); b.put("message",e.getMessage());
        return ResponseEntity.status(e.grund.status).body(b);
    }
}
