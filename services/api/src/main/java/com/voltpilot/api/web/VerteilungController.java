package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.VerteilungAbgelehnt;
import com.voltpilot.api.uems.VerteilungAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.VerteilungService;
import com.voltpilot.api.web.dto.VerteilungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
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
 * Die Verteilung einer Messstelle auf Kostenstellen (UEMS AP-10 IP-8, Konzept §4.6, E11/E12): ein Satz je Tag,
 * 100 % an jedem Tag mit Zeilen, ohne Zeile „nicht verteilt“. Die Arbeit macht {@link VerteilungService}, jede
 * Regel {@code VerteilungRegeln.satzAbTag}, die Grenzen hält die Datenbank ({@code V20260913230000}).
 *
 * <p><b>Rechte:</b> es gilt {@code authenticated()} (SecurityConfig) plus die Mandanten-RLS —
 * eine fremde Messstelle ist 404 {@code nicht_gefunden}, nie 403. Jede Route nennt im Kommentar ihre Kennung aus
 * {@code docs/contracts/v2/rechte-matrix.json} ({@code RechteKennungenDerRoutenTest} hält sie an die Matrix);
 * seit AP-03 IP-6 setzt {@code @Recht} sie vor dem Handler durch
 * (403 {@code recht_fehlt}, außerhalb des Geltungsbereichs 404).
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein unbekanntes Feld (auch camelCase), ein Tag oder eine ID in
 * falscher Form, ein Anteil, der kein Dezimaltext (oder keine Zahl) ist, sind 400 {@code anfrage_ungueltig} mit
 * {@code feld}.
 */
@RestController
@RequestMapping("/api/v1")
public class VerteilungController {

    private static final Set<String> SATZ_FELDER = Set.of("gueltig_ab", "zeilen", "korrektur", "grund");
    private static final Set<String> ZEILE_FELDER = Set.of("kostenstelle_id", "anteil_prozent");

    private final VerteilungService dienst;
    private final RechtPruefung rechte;
    private final ObjectMapper streng;

    public VerteilungController(VerteilungService dienst, RechtPruefung rechte, ObjectMapper json) {
        this.dienst = dienst;
        this.rechte = rechte;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code messstelle.ansehen}. Ohne {@code am} alle wirksamen Anteile; mit {@code am} die an dem Tag
     * geltenden und der Zustand — {@code verteilt} oder {@code nicht verteilt}.
     */
    @GetMapping("/messstellen/{id}/verteilung")
    public VerteilungDto.Verteilung verteilung(@PathVariable UUID id, @RequestParam(required = false) String am) {
        LocalDate tag = tag("am", am);
        // Außerhalb des Zugriffs (AP-03 R-A1): Status und Körper einer Messstelle, die es nicht gibt.
        rechte.pruefenLesen(RechtZiel.MESSSTELLE, id, () -> VerteilungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        return dienst.verteilung(id, tag);
    }

    /**
     * Recht: {@code messstelle.verteilung}; mit „gültig ab“ vor heute zusätzlich {@code aenderung.rueckwirkend}.
     * Ab dem Tag gilt GENAU dieser Satz — alle Ziele eines Tages in EINER Anfrage.
     */
    @PutMapping("/messstellen/{id}/verteilung")
    @Recht(value = "messstelle.verteilung", ziel = RechtZiel.MESSSTELLE)
    public VerteilungDto.Verteilung setzen(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return dienst.setzen(id, lies(body), akteur(auth));
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
            throw VerteilungAbgelehnt.anfrage(feld);
        }
    }

    /**
     * Der strenge Leser: ein JSON-Objekt mit nur bekannten Feldern; {@code gueltig_ab}/{@code grund} Text,
     * {@code korrektur} Wahrheitswert, {@code zeilen} eine Liste von Objekten mit Text-ID und Anteil als
     * Dezimaltext (eine JSON-Zahl wird als ihr Dezimaltext gelesen, nie über Gleitkomma).
     */
    private VerteilungDto.Setzen lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw VerteilungAbgelehnt.anfrage("");
        }
        ObjectNode kopie = body.deepCopy();
        for (Iterator<Map.Entry<String, JsonNode>> it = body.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            JsonNode wert = f.getValue();
            if (!SATZ_FELDER.contains(f.getKey())) {
                throw VerteilungAbgelehnt.anfrage(f.getKey());
            }
            switch (f.getKey()) {
                case "korrektur" -> {
                    if (!wert.isBoolean() && !wert.isNull()) {
                        throw VerteilungAbgelehnt.anfrage("korrektur");
                    }
                }
                case "zeilen" -> {
                    if (!wert.isArray()) {
                        throw VerteilungAbgelehnt.anfrage("zeilen");
                    }
                    for (int i = 0; i < wert.size(); i++) {
                        kopie.withArray("zeilen").set(i, zeile(wert.get(i)));
                    }
                }
                default -> {
                    if (!wert.isTextual() && !wert.isNull()) {
                        throw VerteilungAbgelehnt.anfrage(f.getKey());
                    }
                }
            }
        }
        try {
            return streng.treeToValue(kopie, VerteilungDto.Setzen.class);
        } catch (UnrecognizedPropertyException e) {
            throw VerteilungAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw VerteilungAbgelehnt.anfrage(e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName());
        } catch (JsonProcessingException e) {
            throw VerteilungAbgelehnt.anfrage("");
        }
    }

    private static ObjectNode zeile(JsonNode z) {
        if (z == null || !z.isObject()) {
            throw VerteilungAbgelehnt.anfrage("zeilen");
        }
        ObjectNode raus = z.deepCopy();
        for (Iterator<Map.Entry<String, JsonNode>> it = z.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            if (!ZEILE_FELDER.contains(f.getKey())) {
                throw VerteilungAbgelehnt.anfrage("zeilen[]." + f.getKey());
            }
            JsonNode wert = f.getValue();
            if ("anteil_prozent".equals(f.getKey()) && wert.isNumber()) {
                raus.put("anteil_prozent", wert.decimalValue().toPlainString());
            } else if (!wert.isTextual()) {
                throw VerteilungAbgelehnt.anfrage("zeilen[]." + f.getKey());
            }
        }
        return raus;
    }

    /** {@code {code, message, …Fakten}} — Code, Status und Satz aus dem geschlossenen Satz. */
    @ExceptionHandler(VerteilungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(VerteilungAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(VerteilungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(VerteilungAbgelehnt.anfrage(""));
    }
}
