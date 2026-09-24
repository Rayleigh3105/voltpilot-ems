package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.EnergiemanagementPersonenService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.EnergiemanagementPersonenDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
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
 * UEMS AP-19 IP-6: Personen im Energiemanagement und Aufgaben (PA1–PA3, PA5, §5.6). Die Arbeit macht
 * {@link EnergiemanagementPersonenService}.
 *
 * <p><b>Rechte:</b> Schreibrouten {@code energiemanagement.verwalten} am Unternehmen (403 {@code recht_fehlt});
 * Lesen {@code energiemanagement.ansehen} als Kennung im Kommentar — Personen tragen nur den Mandanten-Zaun (ein
 * Standort-Leser braucht den Namen hinter „entschieden von“), Aufgaben sieht nur, wer unternehmensweit liest. Eine
 * Person wird nie gelöscht: es gibt keine Löschroute, „bis“ beendet sie (PA5).
 */
@RestController
@RequestMapping("/api/v1/energiemanagement")
public class EnergiemanagementPersonenController {

    private final EnergiemanagementPersonenService dienst;
    private final ObjectMapper streng;

    public EnergiemanagementPersonenController(EnergiemanagementPersonenService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }

    /** Recht: {@code energiemanagement.ansehen}. Alle Personen des Kundenbereichs, aktive zuerst, auch beendete. */
    @GetMapping("/personen")
    public EnergiemanagementPersonenDto.Personen personen() {
        return dienst.personen();
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Erfasst eine Person — Name und Funktion, wahlfrei
     * Kürzel, Organisation, Konto (422 {@code konto_unbekannt}, 409 {@code konto_vergeben}) und seit; ohne Konto ist
     * sie trotzdem eine Person (PA1).
     */
    @PostMapping("/personen")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<EnergiemanagementPersonenDto.PersonMitVerlauf> personAnlegen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UUID id = dienst.anlegen(lies(body, EnergiemanagementPersonenDto.PersonAnlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/energiemanagement/personen/" + id)).body(dienst.person(id));
    }

    /** Recht: {@code energiemanagement.ansehen}. Die Person mit ihrem Verlauf; unbekannt 404. */
    @GetMapping("/personen/{id}")
    public EnergiemanagementPersonenDto.PersonMitVerlauf person(@PathVariable UUID id) {
        return dienst.person(id);
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Der ganze änderbare Stand; ein anderes Konto
     * (verknüpfen, wechseln, lösen) braucht eine Begründung und steht im Verlauf; {@code bis} beendet die Person
     * endgültig (Begründung Pflicht, 409 {@code aufgaben_laufen}, solange sie danach noch Aufgaben trägt); eine
     * beendete Person 409 {@code person_beendet}.
     */
    @PutMapping("/personen/{id}")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public EnergiemanagementPersonenDto.PersonMitVerlauf personAendern(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.aendern(id, lies(body, EnergiemanagementPersonenDto.PersonAendern.class), akteur(auth));
        return dienst.person(id);
    }

    /**
     * Recht: {@code energiemanagement.ansehen}, nur unternehmensweit. Die Aufgaben am {@code tag} (Vorgabe heute):
     * je Wort die laufenden Zuordnungen, ohne Person der Satz „… — keine Person festgelegt.“, die Leitung (PA3) und
     * alle Zuordnungen.
     */
    @GetMapping("/aufgaben")
    public EnergiemanagementPersonenDto.Aufgaben aufgaben(@RequestParam(required = false) String tag) {
        return dienst.aufgaben(tag(tag));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Ordnet eine Aufgabe zu — Aufgabe, Person, gilt ab,
     * Begründung, „entschieden von“ (Pflicht außer bei der Leitung des Unternehmens, sonst 422
     * {@code entschieden_von_fehlt}); wahlfrei Vertretung, Beleg als Verweis, Beschluss.
     */
    @PostMapping("/aufgaben")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<EnergiemanagementPersonenDto.Zuordnung> zuordnen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UUID id = dienst.zuordnen(lies(body, EnergiemanagementPersonenDto.AufgabeZuordnen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/energiemanagement/aufgaben/" + id))
                .body(dienst.zuordnung(id));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Beendet eine Zuordnung einmal — letzter Tag und
     * Begründung; eine Übergabe ist danach eine neue Zuordnung ab dem Folgetag.
     */
    @PostMapping("/aufgaben/{id}/beenden")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public EnergiemanagementPersonenDto.Zuordnung beenden(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.beenden(id, lies(body, EnergiemanagementPersonenDto.AufgabeBeenden.class), akteur(auth));
        return dienst.zuordnung(id);
    }

    private static LocalDate tag(String tag) {
        if (tag == null || tag.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(tag);
        } catch (DateTimeParseException e) {
            throw EnergiemanagementAbgelehnt.anfrage("tag");
        }
    }

    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw EnergiemanagementAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw EnergiemanagementAbgelehnt.anfrage(e.getPropertyName());
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw EnergiemanagementAbgelehnt.anfrage("");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(EnergiemanagementAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(EnergiemanagementAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(e.getName().equals("id") && e.getParameter().getMethod() != null
                && e.getParameter().getMethod().getName().startsWith("person")
                ? EnergiemanagementAbgelehnt.personFehlt() : EnergiemanagementAbgelehnt.zuordnungFehlt());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(EnergiemanagementAbgelehnt.anfrage(""));
    }
}
