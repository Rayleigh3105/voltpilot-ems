package com.voltpilot.api.web;

import com.voltpilot.api.steuerlogik.SteuerlogikService;
import com.voltpilot.api.steuerlogik.SteuerwegService;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import com.voltpilot.api.zugriff.ZugriffContext;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der Steuerweg einer Anlage (Steuerlogik Stufe 6, Zusammenführen; Vertrag {@code docs/contracts/v2/steuerlogik.md}):
 * ob die Regeln des Regel-Baukastens auf dem alten Weg (Node-RED) laufen, im Kern mitlaufen oder vom Kern geschaltet
 * werden, mit dem Vergleich je Regel. Den Schalter stellt, wer eine Logik bearbeiten darf ({@code logik.bearbeiten}:
 * Kundenadministrator, Unterstützer mit „Einrichten und Bedienen“, Plattform); sehen darf ihn jeder, der die Steuerung
 * der Anlage sieht.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/steuerlogik/steuerweg")
public class SiteSteuerwegController {

    private final SteuerwegService steuerweg;
    private final Geltungsbereich geltungsbereich;
    private final RechtPruefung recht;

    public SiteSteuerwegController(SteuerwegService steuerweg, Geltungsbereich geltungsbereich, RechtPruefung recht) {
        this.steuerweg = steuerweg;
        this.geltungsbereich = geltungsbereich;
        this.recht = recht;
    }

    /** Der Stand mit dem Recht des Aufrufers ({@code darf}: den Schalter stellen). */
    public record Antwort(SteuerwegService.Stand stand, boolean darf) {}

    /** Recht: lesend wie die Steuerung der Anlage - wo die Regeln laufen, mit dem Vergleich der Box. */
    @GetMapping
    public Antwort stand(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        return new Antwort(steuerweg.stand(siteId), darf(siteId));
    }

    /** Recht: {@code logik.bearbeiten} - den neuen Weg einschalten: die Regeln laufen im Kern mit, Node-RED schaltet. */
    @PostMapping("/mitlauf")
    @Recht(value = SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public Antwort mitlauf(@PathVariable UUID siteId, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return new Antwort(steuerweg.mitlaufen(siteId, akteur(auth), rolle()), true);
    }

    /** Recht: {@code logik.bearbeiten} - der ausdrückliche Schritt: der Kern schaltet die Regeln. */
    @PostMapping("/uebernehmen")
    @Recht(value = SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public Antwort uebernehmen(@PathVariable UUID siteId, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return new Antwort(steuerweg.uebernehmen(siteId, akteur(auth), rolle()), true);
    }

    /** Recht: {@code logik.bearbeiten} - zurück auf den alten Weg, sofort. */
    @PostMapping("/zurueck")
    @Recht(value = SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public Antwort zurueck(@PathVariable UUID siteId, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return new Antwort(steuerweg.zurueck(siteId, akteur(auth), rolle()), true);
    }

    private boolean darf(UUID siteId) {
        return recht.erlaubt(SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, RechtZiel.ANLAGE, siteId);
    }

    private static String rolle() {
        return ZugriffContext.handelndeRolle().map(RechteAbleitung.Rolle::code)
                .orElse(SteuerlogikService.ROLLE_PLATTFORM);
    }

    private static String akteur(Authentication auth) {
        return auth == null ? null : auth.getName();
    }

    @ExceptionHandler(SteuerwegService.Abgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(SteuerwegService.Abgelehnt e) {
        HttpStatus status = "anlage_unbekannt".equals(e.grund()) ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("grund", e.grund());
        body.put("message", e.getMessage());
        return ResponseEntity.status(status).body(body);
    }
}
