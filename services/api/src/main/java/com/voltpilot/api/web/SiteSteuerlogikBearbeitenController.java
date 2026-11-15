package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.steuerlogik.SteuerlogikDienst;
import com.voltpilot.api.steuerlogik.SteuerlogikService;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.web.dto.SteuerlogikDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import com.voltpilot.api.zugriff.ZugriffContext;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Steuerlogik Stufe 4 für den Kunden (Bericht Abschnitte 6, 12.3, 13, 17.7): eine Logik im Portal schreiben - im
 * Aufbau über Formulare oder im Text -, prüfen, als Fassung speichern, mitlaufen lassen, Fassungen vergleichen und
 * zurücknehmen, das Protokoll lesen. Aufbau und Text sind Ansichten desselben Textes; die Sprache liest nur der
 * Logik-Dienst, mit denselben Regeln wie die Box.
 *
 * <p>Rechte (E3 = B, Lesart 17.8): {@code logik.bearbeiten} - Kundenadministrator, Unterstützer mit „Einrichten und
 * Bedienen“, Plattform - schreibt Aufbau und Text, auch Bereiche und {@code editable_by}. Bedienberechtigte sehen die
 * Logik und fragen eine Änderung an ({@code betriebsweise.aendern}). Scharf schalten bleibt in dieser Stufe Sache der
 * Plattform ({@link AdminSteuerlogikController}); für den Kunden heißt eine neue Fassung „zur Freigabe vorlegen“.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/steuerlogik")
public class SiteSteuerlogikBearbeitenController {

    static final String RECHT_BEARBEITEN = "logik.bearbeiten";
    /** Die Plattform-Rolle: sie nimmt auch auf eine Fassung zurück, die noch nie scharf war. */
    static final String PLATTFORM = "ROLE_platform-admin";
    /** Ohne Angabe reicht das Protokoll so weit zurück wie das Vergleichsprotokoll (90 Tage). */
    static final int PROTOKOLL_TAGE = 90;

    private final SteuerlogikService dienst;
    private final Geltungsbereich geltungsbereich;
    private final RechtPruefung recht;
    private final ObjectMapper json;

    public SiteSteuerlogikBearbeitenController(SteuerlogikService dienst, Geltungsbereich geltungsbereich,
            RechtPruefung recht, ObjectMapper json) {
        this.dienst = dienst;
        this.geltungsbereich = geltungsbereich;
        this.recht = recht;
        this.json = json;
    }

    // --- Lesen ---------------------------------------------------------------------------------------------------

    /** Recht: lesend wie die Steuerung der Anlage - die Logiken der Anlage im Überblick, mit dem Recht des Aufrufers. */
    @GetMapping("/logiken")
    public SteuerlogikDto.Logiken logiken(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        List<SteuerlogikDto.LogikKopf> out = new ArrayList<>();
        for (SteuerlogikService.Kopf k : dienst.koepfe(siteId)) {
            JsonNode r = k.lauf() == null ? null : lies(k.lauf().rueckmeldungJson());
            out.add(new SteuerlogikDto.LogikKopf(k.logikId(), k.name(), k.neueste().fassung(),
                    k.aktiv() == null ? null : k.aktiv().fassung(),
                    k.aktiv() == null ? k.neueste().zustand() : k.aktiv().zustand(),
                    k.vorgelegt() == null ? null : k.vorgelegt().fassung(), k.offeneAnfragen(),
                    k.lauf() == null ? null : k.lauf().gemeldetAm(), r == null ? null : feld(r, "lage")));
        }
        return new SteuerlogikDto.Logiken(darfBearbeiten(siteId), darfAnfragen(siteId), out);
    }

    /**
     * Recht: lesend wie die Steuerung der Anlage - was eine Logik an der Anlage lesen und schalten kann (die Auswahl
     * im Aufbau), aus dem Registry-Inhalt mit den Regeln der Box.
     */
    @GetMapping("/quellen")
    public JsonNode quellen(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        return dienst.quellen(siteId);
    }

    /** Recht: lesend wie die Steuerung der Anlage - eine Logik mit Fassungen, Anfragen, Werten und Lauf. */
    @GetMapping("/{logikId}")
    public SteuerlogikDto.LogikAnsicht logik(@PathVariable UUID siteId, @PathVariable UUID logikId) {
        geltungsbereich.requireSite(siteId);
        SteuerlogikService.Logik l = dienst.logik(siteId, logikId);
        SteuerlogikService.BoxStand box = dienst.boxStand(siteId);
        List<SteuerlogikDto.FassungKopf> fassungen = l.fassungen().stream().map(this::kopf).toList();
        SteuerlogikRepository.Fassung aktiv = l.fassungen().stream().filter(SteuerlogikRepository.Fassung::aktiv)
                .findFirst().orElse(null);
        String name = (aktiv != null ? aktiv : l.fassungen().get(0)).name();
        List<SteuerlogikDto.Anfrage> anfragen = l.anfragen().stream()
                .map(a -> new SteuerlogikDto.Anfrage(a.id(), a.kennung(), a.text(), a.am(), a.vonName(), a.rolle(),
                        a.erledigtAm(), a.erledigtName()))
                .toList();
        SteuerlogikRepository.Lauf lauf = l.lauf();
        return new SteuerlogikDto.LogikAnsicht(logikId, name, darfBearbeiten(siteId), darfAnfragen(siteId),
                plattform(), box.mitlauf(), box.scharf(), fassungen, anfragen,
                new SteuerlogikDto.Einstellung(l.einstellung().stand(), lies(l.einstellung().werteJson())),
                lauf == null ? null : new SteuerlogikDto.Lauf(lauf.deviceId(), lauf.fassung(), lauf.contentHash(),
                        lauf.zustand(), lauf.seit(), lies(lauf.rueckmeldungJson()), lauf.gemeldetAm()),
                darfBausteinSpeichern(siteId));
    }

    /** Stufe 5: als Baustein speichern - das Recht und ein Konto mit Sammlung (Partner oder Plattform, E4 = A). */
    private boolean darfBausteinSpeichern(UUID siteId) {
        if (!darfBearbeiten(siteId)) return false;
        if (plattform()) return true;
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && ZugriffKontextLader.konto(a) == RechteAbleitung.Konto.PARTNER;
    }

    /** Recht: lesend wie die Steuerung der Anlage - der Text einer Fassung, wie er gespeichert wurde. */
    @GetMapping("/{logikId}/fassungen/{fassung}")
    public SteuerlogikDto.FassungText text(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @PathVariable int fassung) {
        geltungsbereich.requireSite(siteId);
        SteuerlogikService.Text t = dienst.text(siteId, logikId, fassung);
        return new SteuerlogikDto.FassungText(logikId, fassung, t.fassung().zustand(), t.text(),
                lies(t.fassung().berichtJson()));
    }

    /**
     * Recht: lesend wie die Steuerung der Anlage - das Protokoll einer Logik über einen Zeitraum der Anlage (Tage,
     * letzter eingeschlossen; ohne Angabe die letzten 90 Tage): wer hat wann was gestellt, gespeichert, geschaltet.
     */
    @GetMapping("/{logikId}/protokoll")
    public SteuerlogikDto.Zeitraum protokoll(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestParam(required = false) String von, @RequestParam(required = false) String bis) {
        geltungsbereich.requireSite(siteId);
        LocalDate b = bis == null ? LocalDate.now(SteuerlogikService.ZONE) : tag(bis);
        LocalDate v = von == null ? b.minusDays(PROTOKOLL_TAGE - 1) : tag(von);
        List<SteuerlogikDto.Schritt> schritte = dienst.protokoll(siteId, logikId, v, b).stream()
                .map(s -> new SteuerlogikDto.Schritt(s.fassung(), s.was(), s.am(), s.vonName(), s.rolle(),
                        lies(s.datenJson())))
                .toList();
        return new SteuerlogikDto.Zeitraum(logikId, v.toString(), b.toString(), schritte);
    }

    // --- Schreiben -----------------------------------------------------------------------------------------------

    /**
     * Recht: {@code logik.bearbeiten} - einen Text prüfen, mit denselben Regeln wie Dienst und Box, ohne etwas zu
     * speichern; die Meldungen tragen ihre Zeile im Text.
     */
    @PostMapping("/pruefe")
    @Recht(value = RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public SteuerlogikDto.Geprueft pruefe(@PathVariable UUID siteId, @RequestBody SteuerlogikDto.Pruefen body) {
        geltungsbereich.requireSite(siteId);
        SteuerlogikDienst.Geprueft g = dienst.pruefe(siteId, body == null ? null : body.text());
        boolean sperrt = !g.lesbar() || g.bericht().path("sperrt").asBoolean();
        return new SteuerlogikDto.Geprueft(g.lesbar(), sperrt, g.message(), g.bericht(), g.meldungen());
    }

    /** Recht: {@code logik.bearbeiten} - eine neue Logik als Fassung 1 speichern (sie läuft noch nicht). */
    @PostMapping
    @Recht(value = RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public ResponseEntity<SteuerlogikDto.Gespeichert> neu(@PathVariable UUID siteId,
            @RequestBody SteuerlogikDto.Speichern body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return ResponseEntity.status(HttpStatus.CREATED).body(speichere(siteId, null, body, auth));
    }

    /**
     * Recht: {@code logik.bearbeiten} - eine neue Fassung speichern; {@code basis} ist die Fassung, von der die
     * Änderung ausging (gibt es eine neuere, 409 {@code fassung_veraltet}). Die laufende Fassung bleibt, bis die neue
     * mitläuft oder scharf geschaltet wird.
     */
    @PostMapping("/{logikId}/fassungen")
    @Recht(value = RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public ResponseEntity<SteuerlogikDto.Gespeichert> fassung(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestBody SteuerlogikDto.Speichern body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return ResponseEntity.status(HttpStatus.CREATED).body(speichere(siteId, logikId, body, auth));
    }

    /**
     * Recht: {@code logik.bearbeiten} - eine gespeicherte Fassung mitlaufen lassen: sie löst die aktive ab und rechnet
     * auf der Box mit den echten Werten, ohne zu schalten. Eine scharfe Logik löst sie nicht ab (409).
     */
    @PostMapping("/{logikId}/fassungen/{fassung}/mitlaufen")
    @Recht(value = RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public SteuerlogikDto.Angenommen mitlaufen(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @PathVariable int fassung, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return angenommen(dienst.mitlaufen(siteId, logikId, fassung, akteur(auth), rolle()));
    }

    /** Recht: {@code logik.bearbeiten} - eine Fassung zur Freigabe vorlegen; scharf schaltet die Plattform. */
    @PostMapping("/{logikId}/fassungen/{fassung}/vorlegen")
    @Recht(value = RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public Map<String, Object> vorlegen(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @PathVariable int fassung, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        dienst.vorlegen(siteId, logikId, fassung, akteur(auth), rolle());
        return Map.of("vorgelegt", true, "fassung", fassung);
    }

    /**
     * Recht: {@code logik.bearbeiten} - zurück auf eine Fassung: sie löst die aktive ab, im selben Zustand, und wirkt
     * sofort. Ist die Logik scharf, nur auf eine Fassung, die schon einmal scharf war (409 {@code nicht_freigegeben}).
     */
    @PostMapping("/{logikId}/fassungen/{fassung}/zurueck")
    @Recht(value = RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public SteuerlogikDto.Angenommen zurueck(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @PathVariable int fassung, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return angenommen(dienst.zurueckAuf(siteId, logikId, fassung, plattform(), akteur(auth), rolle()));
    }

    /** Recht: {@code logik.bearbeiten} - die aktive Fassung stilllegen; die Box hört sofort auf, die Geräte sind frei. */
    @PostMapping("/{logikId}/stilllegen")
    @Recht(value = RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public Map<String, Object> stilllegen(@PathVariable UUID siteId, @PathVariable UUID logikId,
            Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return Map.of("stillgelegt", dienst.stilllegen(siteId, logikId, akteur(auth), rolle()));
    }

    /**
     * Recht: {@code betriebsweise.aendern} - eine Änderung anfragen, zu einem Wert oder zur ganzen Logik; wer die Logik
     * bearbeitet, sieht sie an der Logik.
     */
    @PostMapping("/{logikId}/anfragen")
    @Recht(value = SiteSteuerlogikController.RECHT, ziel = RechtZiel.ANLAGE)
    public ResponseEntity<Map<String, Object>> frageAn(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestBody SteuerlogikDto.AnfrageNeu body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        SteuerlogikService.Angefragt a = dienst.frageAn(siteId, logikId, body == null ? null : body.kennung(),
                body == null ? null : body.text(), akteur(auth), rolle());
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("id", a.id(), "logikId", a.logikId()));
    }

    /** Recht: {@code logik.bearbeiten} - eine Anfrage abhaken. */
    @PostMapping("/{logikId}/anfragen/{anfrageId}/erledigt")
    @Recht(value = RECHT_BEARBEITEN, ziel = RechtZiel.ANLAGE)
    public Map<String, Object> erledigt(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @PathVariable UUID anfrageId, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        dienst.erledige(siteId, logikId, anfrageId, akteur(auth), rolle());
        return Map.of("erledigt", true);
    }

    // --- Hilfen --------------------------------------------------------------------------------------------------

    private SteuerlogikDto.Gespeichert speichere(UUID siteId, UUID logikId, SteuerlogikDto.Speichern body,
            Authentication auth) {
        SteuerlogikService.Gespeichert g = dienst.speichere(siteId, logikId, body == null ? null : body.text(),
                body == null ? null : body.notiz(), body == null ? null : body.basis(), akteur(auth), rolle());
        return new SteuerlogikDto.Gespeichert(g.logikId(), g.fassung(), g.name(), g.contentHash(), g.bericht());
    }

    private SteuerlogikDto.FassungKopf kopf(SteuerlogikRepository.Fassung f) {
        return new SteuerlogikDto.FassungKopf(f.fassung(), f.zustand(), f.contentHash(), f.angelegtAm(),
                f.angelegtName(), f.angelegtRolle(), f.notiz(), f.scharfAm(), f.vorgelegtAm(), f.vorgelegtName(),
                lies(f.berichtJson()));
    }

    private boolean darfBearbeiten(UUID siteId) {
        return recht.erlaubt(RECHT_BEARBEITEN, RechtZiel.ANLAGE, siteId);
    }

    private boolean darfAnfragen(UUID siteId) {
        return recht.erlaubt(SiteSteuerlogikController.RECHT, RechtZiel.ANLAGE, siteId);
    }

    /** Ob der Aufrufer die Plattform ist (auch im Mandantensprung). */
    static boolean plattform() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && a.getAuthorities().stream().anyMatch(g -> PLATTFORM.equals(g.getAuthority()));
    }

    /** Die Rolle im Protokoll: die geprüfte Rolle des Aufrufers, ohne geprüfte Rolle die Plattform. */
    private static String rolle() {
        return ZugriffContext.handelndeRolle().map(RechteAbleitung.Rolle::code)
                .orElse(SteuerlogikService.ROLLE_PLATTFORM);
    }

    private static String akteur(Authentication auth) {
        return auth == null ? null : auth.getName();
    }

    private static LocalDate tag(String tag) {
        try {
            return LocalDate.parse(tag);
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Ein Tag ist kein Datum (JJJJ-MM-TT).");
        }
    }

    private static SteuerlogikDto.Angenommen angenommen(SteuerlogikService.Angenommen a) {
        return new SteuerlogikDto.Angenommen(a.logikId(), a.fassung(), a.name(), a.contentHash(), a.bericht(),
                a.box(), a.veroeffentlicht(), a.zustand(), a.verworfen().stream()
                        .map(v -> new SteuerlogikDto.Verworfen(v.kennung(), v.grund())).toList());
    }

    private static JsonNode feld(JsonNode n, String name) {
        JsonNode v = n.get(name);
        return v == null || v.isNull() ? null : v;
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
