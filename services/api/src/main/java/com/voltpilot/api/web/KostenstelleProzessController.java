package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.KostenstelleProzessAbgelehnt;
import com.voltpilot.api.uems.KostenstelleProzessAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.KostenstelleProzessRepository.Art;
import com.voltpilot.api.uems.KostenstelleProzessService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.KostenstelleProzessDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Iterator;
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
 * Kostenstellen, Prozesse und die Prozesse einer Messstelle (UEMS AP-10 IP-7, Konzept §4.2, §5.7):
 * anlegen, lesen, umbenennen, beenden — nie löschen (es gibt keine DELETE-Route; ein Ende, das eine
 * Zuordnung abschneiden würde, ist 409 {@code zuordnung_besteht} mit der Liste). Die Arbeit macht
 * {@link KostenstelleProzessService}, die Grenzen hält die Datenbank ({@code V20260913160000}).
 *
 * <p><b>Rechte:</b> es gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS — ein fremdes Objekt ist 404 {@code nicht_gefunden}, nie 403. Jede Route nennt im
 * Kommentar ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json} (AP-10 §4.10, E15;
 * {@code RechteKennungenDerRoutenTest} hält sie an die Matrix); seit AP-03 IP-6 setzt {@code @Recht} sie vor dem
 * Handler durch
 * (403 {@code recht_fehlt}, außerhalb des Geltungsbereichs 404).
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein unbekanntes Feld (auch camelCase), ein Feld, das kein
 * Text ist (bei {@code prozesse}: keine Liste von Texten), ein Tag oder eine ID in falscher Form sind
 * 400 {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1")
public class KostenstelleProzessController {

    private final KostenstelleProzessService dienst;
    private final RechtPruefung rechte;
    private final ObjectMapper streng;

    public KostenstelleProzessController(KostenstelleProzessService dienst, RechtPruefung rechte, ObjectMapper json) {
        this.dienst = dienst;
        this.rechte = rechte;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    // ------------------------------------------------------------------ Kostenstellen

    /** Recht: heute lesend — keine eigene Kennung (wie das Unternehmen). Ohne Stichtag alle, beendete eingeschlossen. */
    @GetMapping("/unternehmen/kostenstellen")
    public KostenstelleProzessDto.Kostenstellen kostenstellen(@RequestParam(required = false) String stichtag) {
        return dienst.kostenstellen(tag("stichtag", stichtag));
    }

    /** Recht: {@code kostenstelle.verwalten} (AP-10 §4.10, E15). */
    @PostMapping("/unternehmen/kostenstellen")
    @Recht(value = "kostenstelle.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<KostenstelleProzessDto.Kostenstelle> kostenstelleAnlegen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UUID id = dienst.anlegen(Art.KOSTENSTELLE, lies(body, KostenstelleProzessDto.Anlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/unternehmen/kostenstellen/" + id)).body(dienst.kostenstelle(id));
    }

    /** Recht: heute lesend — keine eigene Kennung. */
    @GetMapping("/unternehmen/kostenstellen/{id}")
    public KostenstelleProzessDto.Kostenstelle kostenstelle(@PathVariable UUID id) {
        return dienst.kostenstelle(id);
    }

    /** Recht: {@code kostenstelle.verwalten}. Nur der Name. */
    @PutMapping("/unternehmen/kostenstellen/{id}")
    @Recht(value = "kostenstelle.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public KostenstelleProzessDto.Kostenstelle kostenstelleUmbenennen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body) {
        dienst.umbenennen(Art.KOSTENSTELLE, id, lies(body, KostenstelleProzessDto.Umbenennen.class));
        return dienst.kostenstelle(id);
    }

    /** Recht: {@code kostenstelle.verwalten}. Beenden statt löschen. */
    @PutMapping("/unternehmen/kostenstellen/{id}/beenden")
    @Recht(value = "kostenstelle.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public KostenstelleProzessDto.Kostenstelle kostenstelleBeenden(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body) {
        dienst.beenden(Art.KOSTENSTELLE, id, lies(body, KostenstelleProzessDto.Beenden.class));
        return dienst.kostenstelle(id);
    }

    // ----------------------------------------------------------------------- Prozesse

    /** Recht: heute lesend — keine eigene Kennung. */
    @GetMapping("/unternehmen/prozesse")
    public KostenstelleProzessDto.Prozesse prozesse(@RequestParam(required = false) String stichtag) {
        return dienst.prozesse(tag("stichtag", stichtag));
    }

    /** Recht: {@code prozess.verwalten} (AP-10 §4.10, E15). */
    @PostMapping("/unternehmen/prozesse")
    @Recht(value = "prozess.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<KostenstelleProzessDto.Prozess> prozessAnlegen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UUID id = dienst.anlegen(Art.PROZESS, lies(body, KostenstelleProzessDto.Anlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/unternehmen/prozesse/" + id)).body(dienst.prozess(id));
    }

    /** Recht: heute lesend — keine eigene Kennung. */
    @GetMapping("/unternehmen/prozesse/{id}")
    public KostenstelleProzessDto.Prozess prozess(@PathVariable UUID id) {
        return dienst.prozess(id);
    }

    /** Recht: {@code prozess.verwalten}. Nur der Name. */
    @PutMapping("/unternehmen/prozesse/{id}")
    @Recht(value = "prozess.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public KostenstelleProzessDto.Prozess prozessUmbenennen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body) {
        dienst.umbenennen(Art.PROZESS, id, lies(body, KostenstelleProzessDto.Umbenennen.class));
        return dienst.prozess(id);
    }

    /** Recht: {@code prozess.verwalten}. Beenden statt löschen. */
    @PutMapping("/unternehmen/prozesse/{id}/beenden")
    @Recht(value = "prozess.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public KostenstelleProzessDto.Prozess prozessBeenden(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body) {
        dienst.beenden(Art.PROZESS, id, lies(body, KostenstelleProzessDto.Beenden.class));
        return dienst.prozess(id);
    }

    // ------------------------------------------------------------ Prozesse einer Messstelle

    /** Recht: {@code messstelle.ansehen}. Mit {@code am} nur die an dem Tag geltenden Intervalle. */
    @GetMapping("/messstellen/{id}/prozesse")
    public KostenstelleProzessDto.MessstelleProzesse prozesseDerMessstelle(@PathVariable UUID id,
            @RequestParam(required = false) String am) {
        LocalDate tag = tag("am", am);
        // Außerhalb des Zugriffs (AP-03 R-A1): Status und Körper einer Messstelle, die es nicht gibt.
        rechte.pruefenLesen(RechtZiel.MESSSTELLE, id,
                () -> KostenstelleProzessAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        return dienst.prozesseDerMessstelle(id, tag);
    }

    /**
     * Recht: {@code messstelle.bearbeiten} („Ort, Prozess, Kostenstelle zuordnen“); mit „gültig ab“ vor
     * heute zusätzlich {@code aenderung.rueckwirkend}. Ab dem Tag gehört die Messstelle zu GENAU diesen Prozessen.
     */
    @PutMapping("/messstellen/{id}/prozesse")
    @Recht(value = "messstelle.bearbeiten", ziel = RechtZiel.MESSSTELLE)
    public KostenstelleProzessDto.MessstelleProzesse prozesseSetzen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return dienst.prozesseSetzen(id, lies(body, KostenstelleProzessDto.ProzesseSetzen.class), akteur(auth));
    }

    // ----------------------------------------------------------------------------- Gerüst

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    private static LocalDate tag(String feld, String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw KostenstelleProzessAbgelehnt.anfrage(feld);
        }
    }

    /** Der strenge Mapper: ein JSON-Objekt, nur bekannte Felder, jedes Text oder {@code null} — {@code prozesse} eine Liste von Texten. */
    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || !body.isObject()) {
            throw KostenstelleProzessAbgelehnt.anfrage("");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = body.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            JsonNode wert = f.getValue();
            boolean liste = f.getKey().equals("prozesse") && wert.isArray();
            if (liste) {
                wert.forEach(e -> {
                    if (!e.isTextual()) {
                        throw KostenstelleProzessAbgelehnt.anfrage("prozesse");
                    }
                });
            } else if (!wert.isTextual() && !wert.isNull()) {
                throw KostenstelleProzessAbgelehnt.anfrage(f.getKey());
            }
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw KostenstelleProzessAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw KostenstelleProzessAbgelehnt.anfrage(e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName());
        } catch (JsonProcessingException e) {
            throw KostenstelleProzessAbgelehnt.anfrage("");
        }
    }

    /** {@code {code, message, …Fakten}} — Code, Status und Satz aus dem geschlossenen Satz. */
    @ExceptionHandler(KostenstelleProzessAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(KostenstelleProzessAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(KostenstelleProzessAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(KostenstelleProzessAbgelehnt.anfrage(""));
    }
}
