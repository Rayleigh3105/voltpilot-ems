package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.steuerlogik.SteuerlogikBausteine;
import com.voltpilot.api.steuerlogik.SteuerlogikService;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Steuerlogik Stufe 5, Bausteine (Bericht 6.7, 7, 9, E4 = A): unter „Neue Regel“ einen Satz wählen, seine Lücken mit
 * Geräten und Werten der Anlage füllen, „So verhält sie sich“ lesen und eine gewöhnliche Logik speichern; eine Logik
 * als Baustein speichern - der Fachbetrieb für seine Kunden, VoltPilot für alle.
 *
 * <p>Rechte: lesen wie die Steuerung der Anlage; alles andere an der Anlage ist {@code logik.bearbeiten}
 * (Kundenadministrator, Unterstützer mit „Einrichten und Bedienen“, Plattform). Eine Sammlung hat dazu nur ein Konto,
 * das eine hat (Bericht 8.8: „Partner-Konto“, „Plattform“): ein Partner-Konto für seine Kunden, die Plattform für alle.
 * Ein Kundenkonto setzt Bausteine ein, speichert aber keine (E4 = A) - keine eigene Zeile der Rechte-Matrix, denn
 * es ist eine Frage der Kontoart, nicht der Rolle im Kundenbereich.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/steuerlogik/bausteine")
public class SiteSteuerlogikBausteineController {

    private final SteuerlogikBausteine bausteine;
    private final Geltungsbereich geltungsbereich;
    private final RechtPruefung recht;

    public SiteSteuerlogikBausteineController(SteuerlogikBausteine bausteine, Geltungsbereich geltungsbereich,
            RechtPruefung recht) {
        this.bausteine = bausteine;
        this.geltungsbereich = geltungsbereich;
        this.recht = recht;
    }

    /** Die Liste mit den Rechten dieses Aufrufers. */
    public record Liste(boolean darfEinsetzen, boolean darfSpeichern, List<ObjectNode> bausteine) {}

    /** Was das Portal zum Speichern eines Bausteins schickt: welche Fassung, Name, Satz, Beschreibung. */
    public record AlsBaustein(UUID logikId, Integer fassung, String name, String satz, String beschreibung) {}

    /**
     * Recht: lesend wie die Steuerung der Anlage - die Bausteine mit Satz und Lücken für diese Anlage, {@code passt}
     * sagt, ob jedes Gerät und jeder Fühler ein Gegenüber hat.
     */
    @GetMapping
    public Liste liste(@PathVariable UUID siteId, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        boolean einsetzen = recht.erlaubt(SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, RechtZiel.ANLAGE,
                siteId);
        boolean speichern = einsetzen && akteur(auth).wer().konto() != RechteAbleitung.Konto.BENUTZER;
        return new Liste(einsetzen, speichern, bausteine.liste(siteId, akteur(auth).wer()));
    }

    /**
     * Recht: {@code logik.bearbeiten} - einen Baustein für diese Anlage füllen, ohne zu speichern: Lücken mit Vorschlag,
     * die Logik als Text, ihre Prüfung und „So verhält sie sich“ (die Proben nach der Uhrzeit).
     */
    @PostMapping("/{bausteinId}/vorschau")
    @Recht(value = SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public JsonNode vorschau(@PathVariable UUID siteId, @PathVariable String bausteinId,
            @RequestBody(required = false) JsonNode body) {
        geltungsbereich.requireSite(siteId);
        return bausteine.vorschau(siteId, bausteinId, body == null ? null : body.get("fuellung"));
    }

    /**
     * Recht: {@code logik.bearbeiten} - einen Baustein einsetzen: aus der Füllung entsteht eine gewöhnliche Logik,
     * gespeichert als Fassung 1 (sie läuft noch nicht; mitlaufen und vorlegen wie jede Logik).
     */
    @PostMapping("/{bausteinId}/logik")
    @Recht(value = SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public ResponseEntity<Map<String, Object>> einsetzen(@PathVariable UUID siteId, @PathVariable String bausteinId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        Akteur a = akteur(auth);
        SteuerlogikService.Gespeichert g = bausteine.einsetzen(siteId, bausteinId,
                body == null ? null : body.get("fuellung"), a.name(), a.wer().rolle());
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("logikId", g.logikId(), "fassung", g.fassung(),
                "name", g.name(), "contentHash", g.contentHash(), "bericht", g.bericht()));
    }

    /**
     * Recht: {@code logik.bearbeiten} und ein Konto mit Sammlung - eine Fassung einer Logik dieser Anlage als Baustein
     * speichern: ein Partner-Konto für seine Kunden, die Plattform für alle; Geräte und Fühler werden Lücken.
     */
    @PostMapping
    @Recht(value = SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public ResponseEntity<SteuerlogikBausteine.Neu> speichere(@PathVariable UUID siteId,
            @RequestBody AlsBaustein body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        if (body == null || body.logikId() == null || body.fassung() == null) {
            throw new ResponseStatusExceptionMitGrund("logik_unbekannt", "Welche Fassung welcher Logik?");
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(bausteine.speichere(siteId, body.logikId(),
                body.fassung(), body.name(), body.satz(), body.beschreibung(), akteur(auth).wer()));
    }

    /**
     * Recht: {@code logik.bearbeiten} - einen eigenen Baustein entfernen (ein Partner-Konto seinen, die Plattform einen
     * von VoltPilot).
     */
    @DeleteMapping("/{bausteinId}")
    @Recht(value = SiteSteuerlogikBearbeitenController.RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public Map<String, Object> entferne(@PathVariable UUID siteId, @PathVariable String bausteinId,
            Authentication auth) {
        geltungsbereich.requireSite(siteId);
        bausteine.entferne(siteId, bausteinId, akteur(auth).wer());
        return Map.of("entfernt", true);
    }

    // --- Hilfen --------------------------------------------------------------------------------------------------

    private record Akteur(SteuerlogikBausteine.Akteur wer, String name) {}

    private static Akteur akteur(Authentication auth) {
        RechteAbleitung.Konto konto = auth == null ? null : ZugriffKontextLader.konto(auth);
        // Ohne Kontoart (ein Kundenkonto aus der Zeit vor AP-03) gilt das Konto als Kundenkonto.
        if (konto == null) konto = RechteAbleitung.Konto.BENUTZER;
        if (SiteSteuerlogikBearbeitenController.plattform()) konto = RechteAbleitung.Konto.PLATTFORM;
        String rolle = ZugriffContext.handelndeRolle().map(RechteAbleitung.Rolle::code)
                .orElse(SteuerlogikService.ROLLE_PLATTFORM);
        String name = auth == null ? null : auth.getName();
        return new Akteur(new SteuerlogikBausteine.Akteur(konto, name, rolle), name);
    }

    /** Ein Halt ohne Dienst: dieselbe Form wie die übrigen Antworten der Steuerlogik. */
    static final class ResponseStatusExceptionMitGrund extends RuntimeException {
        final String grund;

        ResponseStatusExceptionMitGrund(String grund, String message) {
            super(message);
            this.grund = grund;
        }
    }

    @ExceptionHandler(ResponseStatusExceptionMitGrund.class)
    public ResponseEntity<Map<String, Object>> ohneAngabe(ResponseStatusExceptionMitGrund e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("grund", e.grund, "message", e.getMessage()));
    }

    @ExceptionHandler(SteuerlogikService.Abgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(SteuerlogikService.Abgelehnt e) {
        return AdminSteuerlogikController.antwort(e);
    }

    /** Kein lesbares JSON. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> anfrage(HttpMessageNotReadableException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(Map.of("grund", "anfrage", "message", "Die Anfrage ist nicht lesbar."));
    }
}
