package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.SteuerlogikRepository;
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
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Steuerlogik Stufe 2, zweiter Teil: VoltPilot gibt eine Logik als Datei ab, sie läuft auf der Box mit, ohne zu
 * schalten, und die Plattform sieht den Vergleich "würde schalten" gegen "ist geschaltet". NUR die Plattform-Rolle -
 * eine Oberfläche für Kunden und Fachbetrieb kommt in den Stufen 3 bis 5. Wie die anderen Plattform-Blätter über den
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
                            lies(f.berichtJson()), f.angelegtAm(), f.angelegtVon(), f.stillgelegtAm()))
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
            logiken.add(new SteuerlogikDto.Logik(e.getKey(), e.getValue().get(0).name(), fassungen, quittung,
                    laeufe));
        }
        return new SteuerlogikDto.Blatt(b.box(), b.boxKann(), logiken);
    }

    /**
     * Recht: {@code plattform.betrieb} — eine neue Logik als Text annehmen (Fassung 1): der Logik-Dienst liest und
     * prüft sie, sie geht im Satz auf {@code v2/flows} an die führende Box und läuft dort mit.
     */
    @PostMapping
    public ResponseEntity<SteuerlogikDto.Angenommen> neu(@PathVariable UUID siteId,
            @RequestBody SteuerlogikDto.Text body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED).body(angenommen(
                dienst.annehmen(siteId, null, body == null ? null : body.text(), akteur(auth))));
    }

    /** Recht: {@code plattform.betrieb} — eine neue Fassung einer Logik; sie löst die mitlaufende ab. */
    @PostMapping("/{logikId}/fassungen")
    public ResponseEntity<SteuerlogikDto.Angenommen> fassung(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestBody SteuerlogikDto.Text body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED).body(angenommen(
                dienst.annehmen(siteId, logikId, body == null ? null : body.text(), akteur(auth))));
    }

    /** Recht: {@code plattform.betrieb} — die mitlaufende Fassung stilllegen; die Box hört sofort auf. */
    @PostMapping("/{logikId}/stilllegen")
    public Map<String, Object> stilllegen(@PathVariable UUID siteId, @PathVariable UUID logikId) {
        return Map.of("stillgelegt", dienst.stilllegen(siteId, logikId));
    }

    /**
     * Recht: {@code plattform.betrieb} — lesend: das Vergleichsprotokoll eines Tages der Anlage (Europe/Berlin), ohne
     * {@code tag} der heutige.
     */
    @GetMapping("/{logikId}/wechsel")
    public SteuerlogikDto.Protokoll wechsel(@PathVariable UUID siteId, @PathVariable UUID logikId,
            @RequestParam(required = false) String tag) {
        LocalDate t;
        try {
            t = tag == null ? LocalDate.now(SteuerlogikService.ZONE) : LocalDate.parse(tag);
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "tag ist kein Datum (JJJJ-MM-TT).");
        }
        List<SteuerlogikDto.Wechsel> zeilen = dienst.wechsel(siteId, logikId, t).stream()
                .map(w -> new SteuerlogikDto.Wechsel(w.deviceId(), w.fassung(), w.laufSeit(), w.nr(), w.t(),
                        w.geraet(), w.was(), lies(w.neuJson()), lies(w.andereJson()), w.lage()))
                .toList();
        return new SteuerlogikDto.Protokoll(logikId, t.toString(), zeilen);
    }

    private static SteuerlogikDto.Angenommen angenommen(SteuerlogikService.Angenommen a) {
        return new SteuerlogikDto.Angenommen(a.logikId(), a.fassung(), a.name(), a.contentHash(), a.bericht(),
                a.box(), a.veroeffentlicht());
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
        HttpStatus status = switch (e.grund()) {
            case "anlage_unbekannt", "logik_unbekannt" -> HttpStatus.NOT_FOUND;
            case "text_fehlt", "text_zu_gross" -> HttpStatus.BAD_REQUEST;
            case "keine_box", "box_ohne_mitlauf" -> HttpStatus.CONFLICT;
            case "logik_unlesbar", "pruefung_sperrt" -> HttpStatus.UNPROCESSABLE_ENTITY;
            default -> HttpStatus.SERVICE_UNAVAILABLE;
        };
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("grund", e.grund());
        body.put("message", e.getMessage());
        if (e.bericht() != null) body.put("bericht", e.bericht());
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
