package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.GemeinsameSteuerungAbgelehnt;
import com.voltpilot.api.uems.GemeinsameSteuerungBoxStand;
import com.voltpilot.api.uems.GemeinsameSteuerungService;
import com.voltpilot.api.uems.SprungprobeDienst;
import com.voltpilot.api.uems.SprungprobeRegel;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * Die Handgriffe des Betreibers an der Gemeinsamen Steuerung (UEMS AP-15 IP-5, Konzept §4.9 I4/I5, §5.3, §5.7, Kasten
 * W9): scharfschalten, fortsetzen (auch nach einem Anhalten des Betreibers), ein Mitglied bestätigen, (IP-13) den
 * Vorschlag zum Senken des Vorbehalts freigeben und (IP-21) die Sprungprobe je Box auslösen; (IP-24) das Betreiber-Blatt lesen. NUR die Plattform-Rolle — ein Kundenkonto, auch der
 * Kundenadministrator, bekommt auf {@code /api/v1/admin/**} 403 (SecurityConfig + {@code @PreAuthorize}); eine
 * Kundenroute wäre für die Plattform am Umschalter ohnehin offen, deshalb liegen die Schritte nur hier.
 *
 * <p>Wie {@link AdminChargingFrameController} über den {@code X-Tenant-Id}-Umschalter auf dem RLS-Pfad — KEIN
 * BYPASSRLS, eine fremde Anlage ist 404. Der Mandant kommt aus dem Umschalter, die Anlage aus dem Pfad; ein Körper ist
 * nicht vorgesehen (mit Feldern 400) — außer beim Auslösen der Sprungprobe.
 */
@RestController
@RequestMapping("/api/v1/admin/sites/{siteId}/gemeinsame-steuerung")
@PreAuthorize("hasRole('platform-admin')")
public class AdminGemeinsameSteuerungController {

    private final GemeinsameSteuerungService dienst;
    private final SprungprobeDienst sprungproben;
    private final GemeinsameSteuerungBoxStand boxStand;

    public AdminGemeinsameSteuerungController(GemeinsameSteuerungService dienst, SprungprobeDienst sprungproben,
            GemeinsameSteuerungBoxStand boxStand) {
        this.dienst = dienst;
        this.sprungproben = sprungproben;
        this.boxStand = boxStand;
    }

    /**
     * Recht: {@code plattform.betrieb} — lesend: das Betreiber-Blatt (IP-24, §5.3/§5.4) je Box — Fähigkeit, Messpunkt
     * und sein Alter, Wächter-Stufe, {@code plan_id} veröffentlicht/angenommen, Anteils-Revision gesendet/quittiert,
     * wirksame Anteile —, der Zweischritt und alle Sprungprobe-Protokolle. Ohne Gemeinsame Steuerung leer.
     */
    @GetMapping
    public GemeinsameSteuerungDto.Betreiberblatt blatt(@PathVariable UUID siteId) {
        return boxStand.blatt(siteId);
    }

    /**
     * Recht: {@code plattform.betrieb} — lesend: der Pilot-Bericht des Anteils-Verlusts (Folgepaket zu IP-22, E1) je
     * Box und in Summe über {@code von}…{@code bis} (Tage der Anlage, beide zählen mit, höchstens 366): Untergrenze der
     * Box und Schätzung der Cloud getrennt. Nur für die Plattform — der Captain entscheidet damit über S4.
     */
    @GetMapping("/anteil-verlust")
    public GemeinsameSteuerungDto.PilotBericht anteilVerlust(@PathVariable UUID siteId,
            @RequestParam(required = false) String von, @RequestParam(required = false) String bis) {
        LocalDate v;
        LocalDate b;
        try {
            v = LocalDate.parse(von == null ? "" : von);
            b = LocalDate.parse(bis == null ? "" : bis);
        } catch (DateTimeParseException e) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("von und bis sind Tage (JJJJ-MM-TT).");
        }
        return boxStand.pilotBericht(siteId, v, b);
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

    /**
     * Recht: {@code plattform.betrieb} — die Sprungprobe an einer Box auslösen (IP-21, E3 = A, I4): Körper {@code
     * {box_id, art, sprung_kw}}, {@code art} ist {@code erzeugung_senken} oder {@code verbrauch_senken} (immer die
     * sichere Richtung), {@code sprung_kw} höchstens 50; Dauer 60 s, zweimal. Nur in S1, nur an einer Box, die
     * {@code sprungprobe} meldet, nur mit frischem Netzzähler der führenden Box, eine Probe zur Zeit je Anlage.
     */
    @PostMapping("/sprungprobe")
    public GemeinsameSteuerungDto.Sprungprobe sprungprobe(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        if (body == null || !body.isObject()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Welche Box, welche Art, wie viele kW?");
        }
        for (var it = body.fieldNames(); it.hasNext();) {
            String feld = it.next();
            if (!Set.of("box_id", "art", "sprung_kw").contains(feld)) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Unbekanntes Feld „" + feld + "“.");
            }
        }
        UUID box;
        try {
            box = UUID.fromString(body.path("box_id").asText());
        } catch (IllegalArgumentException e) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("box_id ist die Kennung einer Box.");
        }
        SprungprobeRegel.Art art = SprungprobeRegel.Art.aus(body.path("art").asText());
        if (art == null) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("art ist „erzeugung_senken“ oder „verbrauch_senken“.");
        }
        JsonNode kw = body.path("sprung_kw");
        if (!kw.isNumber() || kw.decimalValue().signum() <= 0
                || kw.decimalValue().compareTo(SprungprobeRegel.MAX_SPRUNG_KW) > 0) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("sprung_kw liegt über 0 und höchstens bei "
                    + SprungprobeRegel.MAX_SPRUNG_KW + " kW.");
        }
        return sprungproben.ausloesen(siteId, box, art, kw.decimalValue(), GemeinsameSteuerungController.akteur(auth));
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
