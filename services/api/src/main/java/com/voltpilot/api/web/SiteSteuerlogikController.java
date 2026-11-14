package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.steuerlogik.SteuerlogikService;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.web.dto.SteuerlogikDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import com.voltpilot.api.zugriff.ZugriffContext;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * Die Steuerlogik für den Kunden (Stufe 3, Bericht Abschnitte 6.5 und 7): die Karte jeder scharfen Logik mit Lage,
 * Störung und Schalter, das Blatt "Warum?" mit den Bedingungen, Werten und dem Verlauf der Schaltungen, und das
 * Stellen eines Werts. Wer welchen Wert stellt, folgt {@code editable_by} und den Rollen des Portals: einen Zielwert
 * (°C) und einen Wert {@code customer} jeder, der die Betriebsweise ändern darf (E2 = B); die übrigen der
 * Kundenadministrator, der Unterstützer und die Plattform (E3 = B). Scharf schalten, zurücknehmen und stilllegen
 * bleiben in dieser Stufe Sache der Plattform ({@link AdminSteuerlogikController}).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/steuerlogik")
public class SiteSteuerlogikController {

    /** Die Rollen, die auch die Werte des Fachbetriebs stellen (E3 = B: der Kundenadministrator darf alles). */
    static final Set<RechteAbleitung.Rolle> FACHBETRIEB_WERTE = Set.of(RechteAbleitung.Rolle.KUNDENADMINISTRATOR,
            RechteAbleitung.Rolle.UNTERSTUETZER, RechteAbleitung.Rolle.VOLTPILOT_BETRIEB);
    static final String RECHT = "betriebsweise.aendern";

    private final SteuerlogikService dienst;
    private final Geltungsbereich geltungsbereich;
    private final RechtPruefung recht;
    private final ObjectMapper json;

    public SiteSteuerlogikController(SteuerlogikService dienst, Geltungsbereich geltungsbereich,
            RechtPruefung recht, ObjectMapper json) {
        this.dienst = dienst;
        this.geltungsbereich = geltungsbereich;
        this.recht = recht;
        this.json = json;
    }

    /** Recht: lesend wie die Steuerung der Anlage - die scharfen Logiken als Karten, mit dem Recht des Aufrufers. */
    @GetMapping
    public SteuerlogikDto.Karten karten(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        boolean darf = recht.erlaubt(RECHT, RechtZiel.ANLAGE, siteId);
        boolean fachbetrieb = darf && fachbetriebWerte();
        List<SteuerlogikDto.Karte> out = new ArrayList<>();
        for (SteuerlogikService.Karte k : dienst.karten(siteId)) {
            out.add(karte(k, darf, fachbetrieb));
        }
        return new SteuerlogikDto.Karten(out);
    }

    /**
     * Recht: lesend wie die Steuerung der Anlage - der Verlauf eines Tages der Anlage: die Schaltungen (was die
     * Logik wollte und was das Gerät tat) und wer welchen Wert gestellt hat.
     */
    @GetMapping("/{logikId}/verlauf")
    public SteuerlogikDto.Verlauf verlauf(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestParam(required = false) String tag) {
        geltungsbereich.requireSite(siteId);
        LocalDate t = AdminSteuerlogikController.tag(tag);
        List<SteuerlogikDto.Wechsel> wechsel = dienst.wechsel(siteId, logikId, t).stream()
                .map(w -> new SteuerlogikDto.Wechsel(w.deviceId(), w.fassung(), w.laufSeit(), w.nr(), w.t(),
                        w.geraet(), w.was(), lies(w.neuJson()), lies(w.andereJson()), w.lage()))
                .toList();
        List<SteuerlogikDto.Schritt> schritte = dienst.schritte(siteId, logikId, t).stream()
                .map(s -> new SteuerlogikDto.Schritt(s.fassung(), s.was(), s.am(), s.vonName(), s.rolle(),
                        lies(s.datenJson())))
                .toList();
        return new SteuerlogikDto.Verlauf(logikId, t.toString(), wechsel, schritte);
    }

    /**
     * Recht: {@code betriebsweise.aendern} - einen Wert stellen, in seinem Bereich; die Logik läuft weiter und behält
     * ihren Zustand. Werte des Fachbetriebs nur für Kundenadministrator, Unterstützer und Plattform.
     */
    @PutMapping("/{logikId}/stellwerte/{kennung}")
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    public SteuerlogikDto.Gestellt stelle(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @PathVariable String kennung, @RequestBody SteuerlogikDto.Wert body, @AuthenticationPrincipal Jwt jwt) {
        geltungsbereich.requireSite(siteId);
        String rolle = ZugriffContext.handelndeRolle().map(RechteAbleitung.Rolle::code)
                .orElse(SteuerlogikService.ROLLE_PLATTFORM);
        SteuerlogikService.Gestellt g = dienst.stelleWert(siteId, logikId, kennung,
                body == null ? null : body.wert(), fachbetriebWerte(), jwt == null ? null : jwt.getSubject(), rolle);
        return new SteuerlogikDto.Gestellt(g.logikId(), g.kennung(), g.wert(), g.stand(), g.veroeffentlicht());
    }

    /** Ob der geprüfte Aufrufer auch die Werte des Fachbetriebs stellt; ohne geprüfte Rolle die Plattform. */
    private static boolean fachbetriebWerte() {
        return ZugriffContext.handelndeRolle().map(FACHBETRIEB_WERTE::contains).orElse(true);
    }

    private SteuerlogikDto.Karte karte(SteuerlogikService.Karte k, boolean darf, boolean fachbetrieb) {
        SteuerlogikRepository.Fassung f = k.fassung();
        JsonNode r = k.rueckmeldung();
        JsonNode werte = lies(k.einstellung().werteJson());
        Long standBox = r != null && r.path("stellwerte").path("stand").isIntegralNumber()
                ? r.path("stellwerte").path("stand").asLong() : null;
        boolean uebernommen = standBox != null && standBox >= k.einstellung().stand();
        List<SteuerlogikDto.Stellwert> stellwerte = new ArrayList<>();
        for (JsonNode s : k.bericht().path("stellwerte")) {
            String kennung = s.path("kennung").asText();
            JsonNode box = null;
            if (r != null) {
                for (JsonNode w : r.path("stellwerte").path("werte")) {
                    if (w.path("kennung").asText().equals(kennung)) box = w;
                }
            }
            JsonNode wert = werte != null && werte.has(kennung) ? werte.get(kennung) : s.path("vorgabe");
            boolean frei = s.path("zielwert").asBoolean() || "customer".equals(s.path("darf").asText());
            stellwerte.add(new SteuerlogikDto.Stellwert(kennung, s.path("name").asText(), s.path("art").asText(),
                    text(s, "einheit"), zahl(s, "von"), zahl(s, "bis"), zahl(s, "schritt"),
                    s.has("optionen") ? s.get("optionen") : null, s.path("zielwert").asBoolean(),
                    s.path("darf").asText("installer"), wert, box == null ? null : box.get("wert"),
                    box == null ? null : text(box, "text"), box == null ? null : text(box, "hilfe"), frei,
                    darf && SteuerlogikService.darfStellen(s, fachbetrieb), uebernommen));
        }
        List<SteuerlogikDto.Geraet> geraete = new ArrayList<>();
        JsonNode jetzt = r == null ? null : r.path("geraete");
        for (JsonNode g : k.bericht().path("geraete")) {
            String kennung = g.path("kennung").asText();
            JsonNode b = jetzt == null ? null : jetzt.get(kennung);
            geraete.add(new SteuerlogikDto.Geraet(kennung, g.path("entity_id").asText(), g.path("name").asText(kennung),
                    feld(b, "wunsch"), feld(b, "ist"), feld(b, "befehl"), b == null ? null : text(b, "halter"),
                    feld(b, "schutz"), feld(b, "konflikt")));
        }
        return new SteuerlogikDto.Karte(f.logikId(), f.name(), f.fassung(), f.scharfAm(),
                k.lauf() == null ? null : k.lauf().gemeldetAm(), feld(r, "lage"),
                k.stoerungen().stream().map(x -> new SteuerlogikDto.Stoerung(x.code(), x.text())).toList(), geraete,
                stellwerte, k.einstellung().stand(), standBox, feld(r, "warum"), feld(r, "meldungen"));
    }

    private static JsonNode feld(JsonNode n, String name) {
        if (n == null) return null;
        JsonNode v = n.get(name);
        return v == null || v.isNull() ? null : v;
    }

    private static String text(JsonNode n, String name) {
        JsonNode v = n.get(name);
        return v != null && v.isTextual() && !v.asText().isEmpty() ? v.asText() : null;
    }

    private static Double zahl(JsonNode n, String name) {
        JsonNode v = n.get(name);
        return v != null && v.isNumber() ? v.asDouble() : null;
    }

    private JsonNode lies(String text) {
        if (text == null) return null;
        try {
            return json.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }

    @ExceptionHandler(SteuerlogikService.Abgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(SteuerlogikService.Abgelehnt e) {
        return AdminSteuerlogikController.antwort(e);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(Map.of("grund", "logik_unbekannt", "message", "Nicht gefunden."));
    }

    /** Kein lesbares JSON. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> anfrage(HttpMessageNotReadableException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(Map.of("grund", "anfrage", "message", "Die Anfrage ist nicht lesbar."));
    }
}
