package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.mispel.LadepunktAbgelehnt;
import com.voltpilot.api.mispel.LadepunktRegeln;
import com.voltpilot.api.mispel.LadepunktService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.LadepunktBidirektionalDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der bidirektionale Ladepunkt nach der MiSpeL-Festlegung (MP-31, Vertrag
 * {@code docs/contracts/v2/mispel-ladepunkt-bidirektional.md}): Fähigkeit V2H/V2G als Fassungen ab einem Tag, der
 * Zähler Z2 am Ladepunkt mit Eichstatus (gelesen aus den Zählerrollen, MP-6), die Einordnung nach Anlage 1 und das
 * Fahrzeugfenster. Die Arbeit macht {@link LadepunktService}.
 *
 * <p><b>Rechte:</b> lesen über den Leseweg der Anlage (außerhalb des Zugriffs 404); die Fähigkeit ist Einrichtung
 * ({@code geraet.einrichten}), das Fahrzeugfenster Betrieb ({@code ladepunkt.betrieb}). Die Anfrage wird streng
 * gelesen: ein unbekanntes Feld ist 400 {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/ladepunkte")
public class SiteLadepunktBidirektionalController {

    private final LadepunktService ladepunkte;
    private final RechtPruefung rechte;
    private final ObjectMapper streng;

    public SiteLadepunktBidirektionalController(LadepunktService ladepunkte, RechtPruefung rechte, ObjectMapper json) {
        this.ladepunkte = ladepunkte;
        this.rechte = rechte;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);
    }

    /** Die Anfrage an das Fahrzeugfenster; {@code anwesenheit} fehlend = keine Fenster. */
    public record FahrzeugfensterAnfrage(BigDecimal mindestSocPct, BigDecimal kapazitaetKwh,
            List<FensterAnfrage> anwesenheit) {}

    public record FensterAnfrage(Integer wochentag, LocalTime ankunft, LocalTime abfahrt, BigDecimal abfahrtSocPct) {}

    /**
     * Recht: {@code messwerte.ansehen} (Leseweg der Anlage). Alle Ladepunkte der Anlage am Tag {@code am} (fehlend =
     * heute) mit Fähigkeit, Einordnung, Z2, Befunden und Fahrzeugfenster.
     */
    @GetMapping
    public LadepunktBidirektionalDto.Liste liste(@PathVariable UUID siteId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate am) {
        imZugriff(siteId);
        LocalDate tag = am != null ? am : ladepunkte.heute();
        return LadepunktBidirektionalDto.liste(siteId, tag, ladepunkte.anlage(siteId, tag));
    }

    /** Recht: {@code messwerte.ansehen} (Leseweg der Anlage). Ein Ladepunkt am Tag {@code am} mit allen Fassungen. */
    @GetMapping("/{komponenteId}")
    public LadepunktBidirektionalDto.Ansicht ansehen(@PathVariable UUID siteId, @PathVariable UUID komponenteId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate am) {
        imZugriff(siteId);
        return LadepunktBidirektionalDto.aus(ladepunkte.ansicht(siteId, komponenteId, am));
    }

    /**
     * Recht: {@code geraet.einrichten}. Eine neue Fassung der Fähigkeit ab {@code gueltig_ab}; Antwort: die Ansicht
     * an dem Tag.
     */
    @PutMapping("/{komponenteId}/faehigkeit")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public LadepunktBidirektionalDto.Ansicht faehigkeit(@PathVariable UUID siteId, @PathVariable UUID komponenteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        imZugriff(siteId);
        LadepunktService.Aendern a = lies(body, LadepunktService.Aendern.class);
        ladepunkte.faehigkeitSetzen(siteId, komponenteId, a, wer(auth));
        return LadepunktBidirektionalDto.aus(ladepunkte.ansicht(siteId, komponenteId, a.gueltigAb()));
    }

    /** Recht: {@code ladepunkt.betrieb}. Ersetzt das Fahrzeugfenster ganz; Antwort: die Ansicht heute. */
    @PutMapping("/{komponenteId}/fahrzeugfenster")
    @Recht(value = "ladepunkt.betrieb", ziel = RechtZiel.ANLAGE)
    public LadepunktBidirektionalDto.Ansicht fahrzeugfenster(@PathVariable UUID siteId, @PathVariable UUID komponenteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        imZugriff(siteId);
        FahrzeugfensterAnfrage a = lies(body, FahrzeugfensterAnfrage.class);
        List<LadepunktRegeln.Fenster> fenster = a.anwesenheit() == null ? List.of() : a.anwesenheit().stream()
                .map(w -> w == null ? null : new LadepunktRegeln.Fenster(w.wochentag() == null ? 0 : w.wochentag(),
                        w.ankunft(), w.abfahrt(), w.abfahrtSocPct()))
                .toList();
        ladepunkte.fahrzeugfensterSetzen(siteId, komponenteId,
                new LadepunktRegeln.Fahrzeugfenster(a.mindestSocPct(), a.kapazitaetKwh(), fenster), wer(auth));
        return LadepunktBidirektionalDto.aus(ladepunkte.ansicht(siteId, komponenteId, null));
    }

    private void imZugriff(UUID siteId) {
        rechte.pruefenLesen(RechtZiel.ANLAGE, siteId,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
    }

    private static String wer(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an.")).name();
    }

    private <T> T lies(JsonNode body, Class<T> typ) {
        if (body == null || !body.isObject()) {
            throw LadepunktAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, typ);
        } catch (UnrecognizedPropertyException e) {
            throw LadepunktAbgelehnt.anfrage(e.getPropertyName(), "„" + e.getPropertyName() + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName();
            throw LadepunktAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw LadepunktAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code {code, message, …Fakten}}. */
    @ExceptionHandler(LadepunktAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(LadepunktAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keinTag(MethodArgumentTypeMismatchException e) {
        return abgelehnt(LadepunktAbgelehnt.anfrage(e.getName(), "„" + e.getName() + "“ hat nicht die erwartete Form."));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(LadepunktAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
