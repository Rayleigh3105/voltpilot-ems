package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.GemeinsameSteuerungAbgelehnt;
import com.voltpilot.api.uems.GemeinsameSteuerungService;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * Die Handgriffe des Betreibers an der Gemeinsamen Steuerung (UEMS AP-15 IP-5, Konzept §4.9 I4/I5, §5.3, §5.7, Kasten
 * W9): scharfschalten, fortsetzen (auch nach einem Anhalten des Betreibers), ein Mitglied bestätigen und (IP-13) den
 * Vorschlag zum Senken des Vorbehalts freigeben. NUR die Plattform-Rolle — ein Kundenkonto, auch der
 * Kundenadministrator, bekommt auf {@code /api/v1/admin/**} 403 (SecurityConfig + {@code @PreAuthorize}); eine
 * Kundenroute wäre für die Plattform am Umschalter ohnehin offen, deshalb liegen die Schritte nur hier.
 *
 * <p>Wie {@link AdminChargingFrameController} über den {@code X-Tenant-Id}-Umschalter auf dem RLS-Pfad — KEIN
 * BYPASSRLS, eine fremde Anlage ist 404. Der Mandant kommt aus dem Umschalter, die Anlage aus dem Pfad; ein Körper ist
 * nicht vorgesehen (mit Feldern 400).
 */
@RestController
@RequestMapping("/api/v1/admin/sites/{siteId}/gemeinsame-steuerung")
@PreAuthorize("hasRole('platform-admin')")
public class AdminGemeinsameSteuerungController {

    private final GemeinsameSteuerungService dienst;

    public AdminGemeinsameSteuerungController(GemeinsameSteuerungService dienst) {
        this.dienst = dienst;
    }

    /**
     * Recht: {@code plattform.betrieb} — scharfschalten (S3): alle Bedingungen aus I1, abgelehnt mit dem ersten Wort
     * des Ablehnungs-Vokabulars (409, {@code fehlt} nennt alle); zulässig: neue Epoche, Mitglieder bestätigt.
     */
    @PostMapping("/scharfschalten")
    public GemeinsameSteuerungDto.Zustand scharfschalten(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        GemeinsameSteuerungController.leer(body);
        return dienst.scharfschalten(siteId, GemeinsameSteuerungController.akteur(auth));
    }

    /**
     * Recht: {@code plattform.betrieb} — fortsetzen nach dem Anhalten, auch nach einem Anhalten des Betreibers
     * (W9/I5): dieselbe Prüfung aller Bedingungen aus I1, dieselbe Epoche.
     */
    @PostMapping("/fortsetzen")
    public GemeinsameSteuerungDto.Zustand fortsetzen(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        GemeinsameSteuerungController.leer(body);
        return dienst.fortsetzen(siteId, GemeinsameSteuerungController.akteur(auth));
    }

    /** Recht: {@code plattform.betrieb} — ein Mitglied nach dem Box-Tausch bestätigen (R17). */
    @PostMapping("/mitglieder/{boxId}/bestaetigen")
    public GemeinsameSteuerungDto.Zustand bestaetigen(@PathVariable UUID siteId, @PathVariable UUID boxId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        GemeinsameSteuerungController.leer(body);
        return dienst.bestaetigen(siteId, boxId, GemeinsameSteuerungController.akteur(auth));
    }

    /**
     * Recht: {@code plattform.betrieb} — den offenen Vorschlag zum SENKEN des Vorbehalts freigeben (IP-13, B4/G5):
     * erst dann sinkt der Vorbehalt, danach der Zweischritt; 409 {@code kein_vorschlag} ohne offenen Vorschlag. Erhöhen
     * braucht keine Freigabe (der tägliche Lauf); eine Kundenroute zum Senken gibt es nicht.
     */
    @PostMapping("/vorbehalt/freigeben")
    public GemeinsameSteuerungDto.Zustand vorbehaltFreigeben(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        GemeinsameSteuerungController.leer(body);
        return dienst.vorbehaltFreigeben(siteId, GemeinsameSteuerungController.akteur(auth));
    }

    /** {@code {code, message[, fehlt]}}. */
    @ExceptionHandler(GemeinsameSteuerungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(GemeinsameSteuerungAbgelehnt e) {
        return ResponseEntity.status(e.status()).body(e.body());
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(GemeinsameSteuerungAbgelehnt.nichtGefunden());
    }

    /** Kein lesbares JSON. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(GemeinsameSteuerungAbgelehnt.anfrage("Die Anfrage ist nicht lesbar."));
    }
}
