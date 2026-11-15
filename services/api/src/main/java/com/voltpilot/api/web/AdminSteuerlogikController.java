package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.steuerlogik.SteuerlogikBesitz;
import com.voltpilot.api.steuerlogik.SteuerlogikService;
import com.voltpilot.api.web.dto.SteuerlogikDto;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Steuerlogik der Plattform: VoltPilot gibt eine Logik als Datei ab, sie läuft auf der Box mit (Stufe 2) und wird in
 * einem eigenen, protokollierten Schritt scharf geschaltet (Stufe 3); "Zurück zur vorigen Fassung" und "Stilllegen"
 * wirken sofort. NUR die Plattform-Rolle - Scharfschalten bleibt in Stufe 3 Sache der Plattform; Kunden sehen ihre
 * Karte und stellen Werte über {@link SiteSteuerlogikController}. Wie die anderen Plattform-Blätter über den
 * {@code X-Tenant-Id}-Umschalter auf dem RLS-Pfad; eine fremde Anlage ist 404.
 */
@RestController
@RequestMapping("/api/v1/admin/sites/{siteId}/steuerlogik")
@PreAuthorize("hasRole('platform-admin')")
public class AdminSteuerlogikController {

    private final SteuerlogikService dienst;
    private final ObjectMapper json;

    public AdminSteuerlogikController(SteuerlogikService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.json = json;
    }

    /** Recht: {@code plattform.betrieb} — lesend: die Logiken der Anlage, je mit Fassungen, Quittung und Mitlauf. */
    @GetMapping
    public SteuerlogikDto.Blatt blatt(@PathVariable UUID siteId) {
        SteuerlogikService.Blatt b = dienst.blatt(siteId);
        Map<UUID, List<SteuerlogikRepository.Fassung>> je = new LinkedHashMap<>();
        for (SteuerlogikRepository.Fassung f : b.fassungen()) {
            je.computeIfAbsent(f.logikId(), k -> new ArrayList<>()).add(f);
        }
        List<SteuerlogikDto.Logik> logiken = new ArrayList<>();
        for (var e : je.entrySet()) {
            List<SteuerlogikDto.Fassung> fassungen = e.getValue().stream()
                    .sorted((x, y) -> Integer.compare(y.fassung(), x.fassung()))
                    .map(f -> new SteuerlogikDto.Fassung(f.fassung(), f.zustand(), f.contentHash(),
                            lies(f.berichtJson()), f.angelegtAm(), f.angelegtName(), f.stillgelegtAm(), f.scharfAm(),
                            f.scharfVon(), lies(f.hinweiseJson()), f.angelegtRolle(), f.notiz(), f.vorgelegtAm(),
                            f.vorgelegtName()))
                    .toList();
            SteuerlogikDto.Quittung quittung = b.quittungen().stream()
                    .filter(a -> a.flowId().equals(e.getKey())).findFirst()
                    .map(a -> new SteuerlogikDto.Quittung(a.flowVersion(), a.contentHash(), a.state(), a.detail(),
                            a.reportedAt()))
                    .orElse(null);
            List<SteuerlogikDto.Lauf> laeufe = b.laeufe().stream().filter(l -> l.logikId().equals(e.getKey()))
                    .map(l -> new SteuerlogikDto.Lauf(l.deviceId(), l.fassung(), l.contentHash(), l.zustand(),
                            l.seit(), lies(l.rueckmeldungJson()), l.gemeldetAm()))
                    .toList();
            SteuerlogikRepository.Einstellung ein = b.einstellungen().get(e.getKey());
            logiken.add(new SteuerlogikDto.Logik(e.getKey(), e.getValue().get(0).name(), fassungen, quittung,
                    laeufe, ein == null ? null : new SteuerlogikDto.Einstellung(ein.stand(), lies(ein.werteJson()))));
        }
        return new SteuerlogikDto.Blatt(b.box(), b.boxKann(), b.boxKannScharf(), logiken);
    }

    /**
     * Recht: {@code plattform.betrieb} — eine neue Logik als Text annehmen (Fassung 1): der Logik-Dienst liest und
     * prüft sie, sie geht im Satz auf {@code v2/flows} an die führende Box und läuft dort mit.
     */
    @PostMapping
    public ResponseEntity<SteuerlogikDto.Angenommen> neu(@PathVariable UUID siteId,
            @RequestBody SteuerlogikDto.Text body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED).body(annehmen(siteId, null, body, auth));
    }

    /**
     * Recht: {@code plattform.betrieb} - eine neue Fassung einer Logik; sie löst die aktive ab. Ist die aktive scharf,
     * geht die neue nur mit {@code scharf: true} und bestätigten Hinweisen.
     */
    @PostMapping("/{logikId}/fassungen")
    public ResponseEntity<SteuerlogikDto.Angenommen> fassung(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestBody SteuerlogikDto.Text body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED).body(annehmen(siteId, logikId, body, auth));
    }

    private SteuerlogikDto.Angenommen annehmen(UUID siteId, UUID logikId, SteuerlogikDto.Text body,
            Authentication auth) {
        return angenommen(dienst.annehmen(siteId, logikId, body == null ? null : body.text(), akteur(auth),
                SteuerlogikService.ROLLE_PLATTFORM, body != null && Boolean.TRUE.equals(body.scharf()),
                body != null && Boolean.TRUE.equals(body.bestaetigt())));
    }

    /**
     * Recht: {@code plattform.betrieb} - lesend: was der Dialog "Scharf schalten" zeigt (Prüfbericht, gesammelte
     * Hinweise, Konflikte, Geräte, was der Kunde stellt); ohne {@code fassung} für die aktive.
     */
    @GetMapping("/{logikId}/scharf")
    public SteuerlogikDto.Vorschau vorschau(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestParam(required = false) Integer fassung) {
        SteuerlogikService.Vorschau v = dienst.scharfVorschau(siteId, logikId, fassung);
        return new SteuerlogikDto.Vorschau(v.logikId(), v.fassung(), v.name(), v.zustand(), v.boxKann(), v.bericht(),
                v.hinweise(), konflikte(v.konflikte()), v.geraete(), v.kundeStellt(), v.moeglich());
    }

    /**
     * Recht: {@code plattform.betrieb} - eine Fassung scharf schalten, die mitlaufende oder (Stufe 4) eine vorgelegte,
     * die die aktive ablöst: eine Bestätigung für alle Hinweise (E5 = C), kein zweiter Herr; protokolliert mit wer
     * und wann.
     */
    @PostMapping("/{logikId}/scharf")
    public SteuerlogikDto.Angenommen scharf(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestBody SteuerlogikDto.Scharf body, Authentication auth) {
        if (body == null || body.fassung() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Bitte die Fassung nennen.");
        }
        return angenommen(dienst.scharfSchalten(siteId, logikId, body.fassung(),
                Boolean.TRUE.equals(body.bestaetigt()), akteur(auth), SteuerlogikService.ROLLE_PLATTFORM));
    }

    /** Recht: {@code plattform.betrieb} - zurück zur vorigen Fassung, im selben Zustand; wirkt sofort. */
    @PostMapping("/{logikId}/zurueck")
    public SteuerlogikDto.Angenommen zurueck(@PathVariable UUID siteId, @PathVariable UUID logikId,
            Authentication auth) {
        return angenommen(dienst.zurueck(siteId, logikId, akteur(auth), SteuerlogikService.ROLLE_PLATTFORM));
    }

    /** Recht: {@code plattform.betrieb} - die aktive Fassung stilllegen; die Box hört sofort auf, die Geräte sind frei. */
    @PostMapping("/{logikId}/stilllegen")
    public Map<String, Object> stilllegen(@PathVariable UUID siteId, @PathVariable UUID logikId,
            Authentication auth) {
        return Map.of("stillgelegt", dienst.stilllegen(siteId, logikId, akteur(auth),
                SteuerlogikService.ROLLE_PLATTFORM));
    }

    /** Recht: {@code plattform.betrieb} - einen Wert stellen; die Plattform darf jeden Wert, in seinem Bereich. */
    @PutMapping("/{logikId}/stellwerte/{kennung}")
    public SteuerlogikDto.Gestellt stelle(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @PathVariable String kennung, @RequestBody SteuerlogikDto.Wert body, Authentication auth) {
        SteuerlogikService.Gestellt g = dienst.stelleWert(siteId, logikId, kennung, body == null ? null : body.wert(),
                true, akteur(auth), SteuerlogikService.ROLLE_PLATTFORM);
        return new SteuerlogikDto.Gestellt(g.logikId(), g.kennung(), g.wert(), g.stand(), g.veroeffentlicht());
    }

    /** Recht: {@code plattform.betrieb} - lesend: die Schritte an der Logik an einem Tag der Anlage. */
    @GetMapping("/{logikId}/protokoll")
    public SteuerlogikDto.Schritte protokoll(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestParam(required = false) String tag) {
        LocalDate t = tag(tag);
        return new SteuerlogikDto.Schritte(logikId, t.toString(), dienst.schritte(siteId, logikId, t).stream()
                .map(s -> new SteuerlogikDto.Schritt(s.fassung(), s.was(), s.am(), s.vonName(), s.rolle(),
                        lies(s.datenJson())))
                .toList());
    }

    /**
     * Recht: {@code plattform.betrieb} — lesend: das Vergleichsprotokoll eines Tages der Anlage (Europe/Berlin), ohne
     * {@code tag} der heutige.
     */
    @GetMapping("/{logikId}/wechsel")
    public SteuerlogikDto.Protokoll wechsel(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestParam(required = false) String tag) {
        LocalDate t = tag(tag);
        List<SteuerlogikDto.Wechsel> zeilen = dienst.wechsel(siteId, logikId, t).stream()
                .map(w -> new SteuerlogikDto.Wechsel(w.deviceId(), w.fassung(), w.laufSeit(), w.nr(), w.t(),
                        w.geraet(), w.was(), lies(w.neuJson()), lies(w.andereJson()), w.lage()))
                .toList();
        return new SteuerlogikDto.Protokoll(logikId, t.toString(), zeilen);
    }

    static LocalDate tag(String tag) {
        try {
            return tag == null ? LocalDate.now(SteuerlogikService.ZONE) : LocalDate.parse(tag);
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "tag ist kein Datum (JJJJ-MM-TT).");
        }
    }

    private static SteuerlogikDto.Angenommen angenommen(SteuerlogikService.Angenommen a) {
        return new SteuerlogikDto.Angenommen(a.logikId(), a.fassung(), a.name(), a.contentHash(), a.bericht(),
                a.box(), a.veroeffentlicht(), a.zustand(), a.verworfen().stream()
                        .map(v -> new SteuerlogikDto.Verworfen(v.kennung(), v.grund())).toList());
    }

    static List<SteuerlogikDto.Konflikt> konflikte(List<SteuerlogikBesitz.Konflikt> k) {
        return k.stream().map(x -> new SteuerlogikDto.Konflikt(x.entityId(), x.geraet(), x.art(), x.text())).toList();
    }

    private JsonNode lies(String text) {
        if (text == null) return null;
        try {
            return json.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }

    private static String akteur(Authentication auth) {
        return auth == null ? null : auth.getName();
    }

    @ExceptionHandler(SteuerlogikService.Abgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(SteuerlogikService.Abgelehnt e) {
        return antwort(e);
    }

    /** Ein ehrlicher Halt als Antwort: Code, Satz, Prüfbericht und Konflikte; der Status folgt dem Grund. */
    static ResponseEntity<Map<String, Object>> antwort(SteuerlogikService.Abgelehnt e) {
        HttpStatus status = switch (e.grund()) {
            case "anlage_unbekannt", "logik_unbekannt", "stellwert_unbekannt", "fassung_unbekannt",
                    "anfrage_unbekannt", "baustein_unbekannt" -> HttpStatus.NOT_FOUND;
            case "text_fehlt", "text_zu_gross", "wert_fehlt", "notiz_zu_lang", "zeitraum", "name_fehlt", "satz_fehlt",
                    "beschreibung_zu_lang", "dateien_fehlen", "dateien_zu_gross" -> HttpStatus.BAD_REQUEST;
            case "recht_fehlt" -> HttpStatus.FORBIDDEN;
            case "keine_box", "box_ohne_mitlauf", "box_ohne_scharf", "zweiter_herr", "scharf_abloesen",
                    "bestaetigung_fehlt", "fassung_veraltet", "schon_scharf", "nichts_aktiv", "keine_vorige",
                    "gleichzeitig", "laeuft_schon", "nicht_freigegeben", "aus_dem_vertrag" ->
                    HttpStatus.CONFLICT;
            case "logik_unlesbar", "pruefung_sperrt", "stellwerte_passen_nicht", "baustein_unlesbar",
                    "baustein_unvollstaendig", "home_assistant_unlesbar" -> HttpStatus.UNPROCESSABLE_ENTITY;
            default -> HttpStatus.SERVICE_UNAVAILABLE;
        };
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("grund", e.grund());
        body.put("message", e.getMessage());
        if (e.bericht() != null) body.put("bericht", e.bericht());
        if (e.meldungen() != null) body.put("meldungen", e.meldungen());
        else if (e.bericht() != null && e.bericht().has("meldungen")) body.put("meldungen", e.bericht().get("meldungen"));
        if (!e.konflikte().isEmpty()) body.put("konflikte", konflikte(e.konflikte()));
        return ResponseEntity.status(status).body(body);
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
