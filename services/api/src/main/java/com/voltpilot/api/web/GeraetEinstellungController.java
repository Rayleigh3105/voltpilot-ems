package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.EinstellungAbgelehnt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.QuelleEinstellungService;
import com.voltpilot.api.web.dto.EinstellungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
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
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Einstellungs-Fassungen je Quelle (UEMS AP-04 IP-11) — Wandlerverhältnis, Skalierung,
 * Vorzeichen … am Gerät (einem Einbau), an einer Komponente, die es speist, oder an einem Kanal,
 * zeitgültig und mit Protokoll. Die Arbeit macht {@link QuelleEinstellungService}, jede Regel
 * {@code QuelleEinstellungRegeln}.
 *
 * <p><b>Nichts Gespeichertes ändert sich:</b> eine Fassung wirkt nur ab „gültig ab", die Route
 * ändert weder die Verbindung der Komponente noch die Konfiguration der Box noch einen Messwert — eine
 * angewendete Fassung bleibt „Zustellung ausstehend", bis AP-06 zustellt.
 *
 * <p><b>Rechte:</b> es gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS — ein fremdes Gerät ist 404, nie 403. Jede Route nennt im Kommentar ihre Kennung
 * aus {@code docs/contracts/v2/rechte-matrix.json}; seit AP-03 IP-6 setzt {@code @Recht} sie vor dem Handler
 * durch (403 {@code recht_fehlt}, ein Gerät außerhalb des Geltungsbereichs wie ein unbekanntes 404). Die Anfrage
 * wird streng gelesen: ein Feld, das
 * es an der Route nicht gibt, ist 400.
 */
@RestController
public class GeraetEinstellungController {

    private final QuelleEinstellungService einstellungen;
    private final ObjectMapper streng;

    public GeraetEinstellungController(QuelleEinstellungService einstellungen, ObjectMapper json) {
        this.einstellungen = einstellungen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code messwerte.ansehen} — die Einstellungen gehören zur Sicht auf das Gerät; ein
     * Stichtag in der Vergangenheit („Stand am") zusätzlich {@code aenderungsprotokoll.lesen}.
     */
    @GetMapping("/api/v1/geraete/{id}/einstellungen")
    public EinstellungDto.Einstellungen lesen(@PathVariable UUID id,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
            OffsetDateTime stichtag) {
        return einstellungen.einstellungen(id, stichtag == null ? null : stichtag.toInstant());
    }

    /**
     * Recht: {@code messstelle.quelle} („Führende Quelle binden · Zählerwechsel ·
     * Wandlerfaktoren"); mit „gültig ab" vor jetzt zusätzlich {@code aenderung.rueckwirkend}.
     * Antwort 201: die neue Fassung, die beendete, die Folgen-Sätze und die Messstellen des
     * Protokolls.
     */
    @PostMapping("/api/v1/geraete/{id}/einstellungen")
    @Recht(value = "messstelle.quelle", ziel = RechtZiel.GERAET)
    @ResponseStatus(HttpStatus.CREATED)
    public EinstellungDto.Eingetragen eintragen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return einstellungen.eintragen(id, lies(body), akteur(auth));
    }

    // ---------------------------------------------------------------- Gerüst

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    private EinstellungDto.Neu lies(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw EinstellungAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, EinstellungDto.Neu.class);
        } catch (UnrecognizedPropertyException e) {
            String feld = pfad(e);
            throw EinstellungAbgelehnt.anfrage(feld, "„" + feld + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = pfad(e);
            throw EinstellungAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw EinstellungAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    private static String pfad(JsonMappingException e) {
        StringBuilder s = new StringBuilder();
        for (JsonMappingException.Reference r : e.getPath()) {
            if (r.getFieldName() != null) {
                s.append(s.isEmpty() ? "" : ".").append(r.getFieldName());
            } else if (r.getIndex() >= 0) {
                s.append('[').append(r.getIndex()).append(']');
            }
        }
        return s.toString();
    }

    /** {@code {code, message, …Fakten}} — Code und Status wie der Vertrag (bzw. die Schnittstelle) sie nennt. */
    @ExceptionHandler(EinstellungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(EinstellungAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /**
     * {@code ?stichtag=} kein Zeitpunkt (bzw. eine Kennung, die keine ist): dieselbe Form wie jede
     * andere Ablehnung der Anfrage.
     */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keinZeitpunkt(MethodArgumentTypeMismatchException e) {
        return abgelehnt(EinstellungAbgelehnt.anfrage(e.getName(), OffsetDateTime.class.equals(e.getRequiredType())
                ? "„" + e.getName() + "“ ist ein Zeitpunkt (ISO 8601 mit Versatz, etwa 2027-01-15T09:00:00+01:00)."
                : "„" + e.getName() + "“ hat nicht die erwartete Form."));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(EinstellungAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    /** 401/404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
