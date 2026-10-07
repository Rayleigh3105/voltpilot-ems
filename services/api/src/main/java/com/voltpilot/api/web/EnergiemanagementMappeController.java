package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.EnergiemanagementMappeService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.EnergiemanagementMappeDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Konzept Nachweisen n1, Runde 2, Entscheid 7: „Unterlagen zusammenstellen“ - die Mappe für eine Prüfung von außen.
 * Die Arbeit macht {@link EnergiemanagementMappeService}.
 *
 * <p><b>Rechte:</b> Anlegen {@code energiemanagement.verwalten} am Unternehmen (403 {@code recht_fehlt}, auch
 * „Einsicht“); Lesen und Abrufen {@code energiemanagement.ansehen} als Kennung im Kommentar, nur unternehmensweit
 * sichtbar (Zaun {@code site_scope}) - „Einsicht“ liest und ruft ab. Eine Mappe wird nie geändert und nie gelöscht;
 * ihre Dateien sind 30 Tage abrufbar (danach 410 {@code mappe_abgelaufen}), jeder Abruf protokolliert.
 */
@RestController
@RequestMapping("/api/v1/energiemanagement")
public class EnergiemanagementMappeController {

    private final EnergiemanagementMappeService dienst;
    private final ObjectMapper streng;

    public EnergiemanagementMappeController(EnergiemanagementMappeService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }

    /** Recht: {@code energiemanagement.ansehen}, nur unternehmensweit. Alle Mappen, die jüngste zuerst. */
    @GetMapping("/mappen")
    public EnergiemanagementMappeDto.Mappen mappen() {
        return dienst.mappen();
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Unternehmen. Stellt eine Mappe zusammen: Anlass, ab welchem Tag
     * (ohne: alles), die Gruppen des Verzeichnisses und die Teile, die offen sind.
     */
    @PostMapping("/mappen")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<EnergiemanagementMappeDto.Mappe> anlegen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        EnergiemanagementMappeDto.Anlegen a = lies(body);
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.erstellen(
                new EnergiemanagementMappeService.Anfrage(a.anlass(), a.von(), a.gruppen(), a.offen()), akteur(auth)));
    }

    /** Recht: {@code energiemanagement.ansehen}, nur unternehmensweit. */
    @GetMapping("/mappen/{id}")
    public EnergiemanagementMappeDto.Mappe mappe(@PathVariable UUID id) {
        return dienst.mappe(id);
    }

    /** Recht: {@code energiemanagement.ansehen}, nur unternehmensweit. Das PDF; jeder Abruf protokolliert. */
    @GetMapping("/mappen/{id}/pdf")
    public ResponseEntity<byte[]> pdf(@PathVariable UUID id, Authentication auth) {
        return datei(dienst.datei(id, "pdf", akteur(auth)));
    }

    /** Recht: {@code energiemanagement.ansehen}, nur unternehmensweit. Die Verzeichnis-CSV; jeder Abruf protokolliert. */
    @GetMapping("/mappen/{id}/csv")
    public ResponseEntity<byte[]> csv(@PathVariable UUID id, Authentication auth) {
        return datei(dienst.datei(id, "csv", akteur(auth)));
    }

    private static ResponseEntity<byte[]> datei(EnergiemanagementMappeService.Datei d) {
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(d.typ())).cacheControl(CacheControl.noStore())
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + d.name())
                .body(d.inhalt());
    }

    private EnergiemanagementMappeDto.Anlegen lies(JsonNode body) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw EnergiemanagementAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, EnergiemanagementMappeDto.Anlegen.class);
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

    /** {@code {code, message, …Fakten}} wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(EnergiemanagementAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(EnergiemanagementAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine Mappe, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diese Mappe gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(EnergiemanagementAbgelehnt.anfrage(""));
    }
}
