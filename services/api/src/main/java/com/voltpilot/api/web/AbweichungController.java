package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.AbweichungService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.web.dto.AbweichungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
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
 * Abweichungen (UEMS AP-18 IP-16, A3–A6, U1–U3, RE1–RE3): von Hand eröffnen, lesen, Einträge (Kommentar,
 * Ursache-Aussage), Frist, Verantwortlicher, Abschluss. Aus einer Auffälligkeit eröffnet die Antwort an der Kennzahl
 * ({@link AuffaelligkeitController}); die Arbeit macht {@link AbweichungService}.
 *
 * <p><b>Rechte:</b> Schreibrouten {@code verbesserung.verwalten}, der Abschluss {@code verbesserung.abschliessen} — an
 * der Geltung der Kennzahl (403 {@code recht_fehlt}); Lesen {@code verbesserung.ansehen} als Kennung im Kommentar — die
 * Sichtbarkeit kommt über {@code standort_id} (RLS) und die Kennzahl, außerhalb 404.
 */
@RestController
@RequestMapping("/api/v1/abweichungen")
public class AbweichungController {

    private final AbweichungService abweichungen;
    private final ObjectMapper streng;

    public AbweichungController(AbweichungService abweichungen, ObjectMapper json) {
        this.abweichungen = abweichungen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code verbesserung.ansehen} (Zaun über Standort und Kennzahl). Das Register; {@code zustand}
     * ({@code offen · abgeschlossen}), {@code ueberfaellig} ({@code true · false}, Operation {@code frist} beim Abruf)
     * und {@code kennzahl} (ID) filtern.
     */
    @GetMapping
    public AbweichungDto.Liste liste(@RequestParam(required = false) String zustand,
            @RequestParam(required = false) String ueberfaellig, @RequestParam(required = false) String kennzahl,
            HttpServletRequest anfrage) {
        return abweichungen.liste(anfrage.getParameterMap().keySet(), zustand, ueberfaellig, kennzahl);
    }

    /**
     * Recht: {@code verbesserung.verwalten} an der Geltung der Kennzahl. Eröffnet AW-JJJJ-nnnn von Hand: Anlass-Kopie
     * des Vergleich-Lesers über abgeschlossene Monate einer Fassung, Wortlaut, warum (10–500), Verantwortlicher (aktives
     * Konto), Frist (ohne: Eröffnungstag + 30; nie davor).
     */
    @PostMapping
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<AbweichungDto.Abweichung> anlegen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        AbweichungDto.Abweichung neu = abweichungen.anlegen(lies(body, AbweichungDto.Anlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/abweichungen/" + neu.id())).body(neu);
    }

    /** Recht: {@code verbesserung.ansehen}. Die Abweichung mit Vermerken und Verlauf; außerhalb der Sicht 404. */
    @GetMapping("/{id}")
    public AbweichungDto.Abweichung eine(@PathVariable UUID id) {
        return abweichungen.eine(id);
    }

    /**
     * Recht: {@code verbesserung.verwalten}. Ein Kommentar oder eine Ursache-Aussage (Wortlaut, Person, Tag, wahlfrei
     * Beleg-Kennung) im Verlauf — nur an einer offenen Abweichung (sonst 409 {@code abweichung_abgeschlossen}).
     */
    @PostMapping("/{id}/eintraege")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<AbweichungDto.Abweichung> eintrag(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(abweichungen.eintrag(id, lies(body, AbweichungDto.NeuerEintrag.class), akteur(auth)));
    }

    /** Recht: {@code verbesserung.verwalten}. Setzt die Frist (nie vor dem Eröffnungstag) mit Begründung. */
    @PutMapping("/{id}/frist")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public AbweichungDto.Abweichung frist(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return abweichungen.frist(id, lies(body, AbweichungDto.Frist.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Setzt den Verantwortlichen (aktives Konto) mit Begründung. */
    @PutMapping("/{id}/verantwortlicher")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public AbweichungDto.Abweichung verantwortlicher(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return abweichungen.verantwortlicher(id, lies(body, AbweichungDto.Verantwortlicher.class), akteur(auth));
    }

    /**
     * Recht: {@code verbesserung.abschliessen}. Schließt ab mit Ergebnis ({@code massnahme} mit Verweis auf eine
     * Maßnahme · {@code erklaert} · {@code keine_abweichung} · {@code nicht_bewertbar}) und Begründung — einmalig.
     */
    @PostMapping("/{id}/abschliessen")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public AbweichungDto.Abweichung abschliessen(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return abweichungen.abschliessen(id, lies(body, AbweichungDto.Abschliessen.class), akteur(auth));
    }

    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw VerbesserungAbgelehnt.anfrage(e.getPropertyName());
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(VerbesserungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(VerbesserungAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Die Kennzahl lehnt ab (404 außerhalb der Sicht, 403 ohne Recht an der Geltung). */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> kennzahl(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine Abweichung, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new VerbesserungAbgelehnt(404, "nicht_gefunden", "Diese Abweichung gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(VerbesserungAbgelehnt.anfrage(""));
    }
}
