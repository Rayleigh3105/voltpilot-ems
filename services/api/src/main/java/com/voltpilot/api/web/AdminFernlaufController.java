package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.werkstatt.FernlaufRegel;
import com.voltpilot.api.werkstatt.FernlaufRepository.Fernlauf;
import com.voltpilot.api.werkstatt.FernlaufService;
import com.voltpilot.api.werkstatt.Nachtlauf;
import com.voltpilot.api.werkstatt.NachtlaufService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Neue Software durch den Wartungstunnel für eine Box ohne Kundenkonto (Konzept vp-update-vor-zuordnung, S1):
 * {@code /api/v1/admin/geraete/{ref}/fernlauf}, nur für Plattform-Admins - wie das Öffnen eines Fensters, das schon
 * heute root auf der Box gibt. Der Knopf gibt keine neue Macht: Er öffnet ein Fenster für den Zugang des
 * Werkstatt-Dienstes, der nur einen festen Ablauf fährt ({@link FernlaufService}).
 */
@RestController
@RequestMapping("/api/v1/admin/geraete/{ref}/fernlauf")
@PreAuthorize("hasRole('platform-admin')")
public class AdminFernlaufController {

    /** Ein Schritt aus der Meldung des Dienstes. */
    public record SchrittDto(String schritt, String zustand, Instant zeit, String zeile) {
    }

    /** Das Ergebnis eines Auftrags. */
    public record ErgebnisDto(String ergebnis, String grund, String schritt, String fassungNachher,
            Map<String, String> belege, String quelle, Instant erfasstAm) {
    }

    /**
     * Ein Auftrag, wie die Akte ihn zeigt; {@code zustand} aus {@link FernlaufRegel#ZUSTAENDE}; {@code nachts}:
     * angelegt von der Automatik „nachts von selbst" ({@link Nachtlauf#URHEBER}).
     */
    public record FernlaufDto(UUID id, String art, String zustand, String fassungVorher, String fassungZiel,
            String akteurName, boolean nachts, Instant erteiltAm, Instant begonnenAm, String schritt, Instant schrittSeit,
            List<SchrittDto> schritte, Instant fensterEnde, ErgebnisDto ergebnis) {
    }

    public record GrundDto(String code, String text) {
    }

    public record HakenDto(boolean tunnelVerbunden, boolean fragtNachSchluesseln, boolean keinKundenkonto) {
    }

    /** Ob die Box in der nächsten (oder laufenden) Nacht von selbst dran ist, sonst warum nicht (S4). */
    public record NachtlaufDto(boolean dran, String grund) {
    }

    /**
     * Was die Akte zeigt: die laufende Fassung aus der letzten Zertifikatsanfrage (N2) mit der Zeit des Starts,
     * die letzte Zertifikats-Abfrage (N5), die neueste Fassung, der Werkstatt-Stand, das Urteil der Vorprüfung
     * die letzten Aufträge (neueste zuerst) und ob sie nachts von selbst dran ist.
     */
    public record StandDto(String edgeRef, String laeuft, Instant laeuftGemeldetAm, Instant fragtZuletztAm,
            String neueste, String werkstattFassung, Instant werkstattAm, boolean moeglich, List<GrundDto> gruende,
            HakenDto haken, List<FernlaufDto> verlauf, NachtlaufDto nachtlauf, Instant stand) {
    }

    /** Die Fassung, die der Admin im Dialog bestätigt hat. */
    public record AufspielenRequest(String fassung) {
    }

    private final FernlaufService fernlauf;
    private final NachtlaufService nachtlauf;
    private final ObjectMapper json;

    public AdminFernlaufController(FernlaufService fernlauf, NachtlaufService nachtlauf, ObjectMapper json) {
        this.fernlauf = fernlauf;
        this.nachtlauf = nachtlauf;
        this.json = json;
    }

    @GetMapping
    public ResponseEntity<StandDto> stand(@PathVariable String ref) {
        FernlaufService.Stand s = fernlauf.stand(ref);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(standDto(s, nachtlauf.dran(s), json));
    }

    /**
     * Derselbe Stand, wie ihn eine Box in ihrer Akte zeigt - auch für die Karte „Ohne Kundenkonto" (S2, einmal je
     * Box, {@link AdminFernlaufUebersichtController}): keine zweite Vorprüfung, nur dieselbe Abbildung.
     */
    static StandDto standDto(FernlaufService.Stand s, Nachtlauf.Dran dran, ObjectMapper json) {
        FernlaufRegel.Urteil u = s.urteil();
        return new StandDto(s.edgeRef(), s.laeuft(), s.laeuftGemeldetAm(), s.fragtZuletztAm(), s.neueste(),
                s.werkstattFassung(), s.werkstattAm(), u.moeglich(),
                u.gruende().stream().map(g -> new GrundDto(g.code(), g.text())).toList(),
                new HakenDto(u.haken().tunnelVerbunden(), u.haken().fragtNachSchluesseln(),
                        u.haken().keinKundenkonto()),
                s.verlauf().stream().map(f -> dto(f, s.jetzt(), json)).toList(),
                dran == null ? null : new NachtlaufDto(dran.dran(), dran.grund()), s.jetzt());
    }

    /** „Auf … bringen“: 201 mit dem Auftrag; 409 mit Grund; 422 Kennung. */
    @PostMapping
    public ResponseEntity<FernlaufDto> aufspielen(@PathVariable String ref,
            @RequestBody(required = false) AufspielenRequest req, @AuthenticationPrincipal Jwt caller) {
        Fernlauf f = fernlauf.aufspielen(ref, req == null ? null : req.fassung(), Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(dto(f, Instant.now()));
    }

    FernlaufDto dto(Fernlauf f, Instant jetzt) {
        return dto(f, jetzt, json);
    }

    static FernlaufDto dto(Fernlauf f, Instant jetzt, ObjectMapper json) {
        List<SchrittDto> schritte = new java.util.ArrayList<>();
        for (JsonNode n : lies(json, f.schritteJson())) {
            schritte.add(new SchrittDto(n.path("schritt").asText(null), n.path("zustand").asText(null),
                    n.hasNonNull("zeit") ? Instant.parse(n.path("zeit").asText()) : null,
                    n.path("zeile").asText(null)));
        }
        ErgebnisDto e = null;
        if (f.ergebnis() != null) {
            Map<String, String> belege = new java.util.LinkedHashMap<>();
            lies(json, f.ergebnis().belegeJson()).fields()
                    .forEachRemaining(x -> belege.put(x.getKey(), x.getValue().asText()));
            e = new ErgebnisDto(f.ergebnis().ergebnis(), f.ergebnis().grund(), f.ergebnis().schritt(),
                    f.ergebnis().fassungNachher(), belege, f.ergebnis().quelle(), f.ergebnis().erfasstAm());
        }
        return new FernlaufDto(f.id(), f.art(), f.zustand(jetzt), f.fassungVorher(), f.fassungZiel(), f.akteurName(),
                Nachtlauf.URHEBER.equals(f.akteurSub()), f.erteiltAm(), f.begonnenAm(), f.schritt(), f.schrittSeit(), schritte, f.fensterEnde(), e);
    }

    private static JsonNode lies(ObjectMapper json, String text) {
        try {
            return text == null ? json.createObjectNode() : json.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            return json.createObjectNode();
        }
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
