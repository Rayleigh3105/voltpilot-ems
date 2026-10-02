package com.voltpilot.api.web;

import com.voltpilot.api.mispel.MsbAbgleichAbgelehnt;
import com.voltpilot.api.mispel.MsbAbgleichService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.ZaehlerrolleAbgelehnt;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

/**
 * Werte des Messstellenbetreibers an einer Messstelle einlesen und je Monat abgleichen (MiSpeL MP-15, Bedienkonzept
 * BK-15 Variante A, Vertrag {@code mispel-abgrenzung.md} „Werte des Messstellenbetreibers“). Die Arbeit macht
 * {@link MsbAbgleichService}.
 *
 * <p><b>Rechte</b> wie die Zählerrolle ({@link MessstelleZaehlerrolleController}): lesen über den Leseweg der
 * Messstelle (außerhalb des Zugriffs 404), einlesen mit {@code messstelle.bearbeiten}.
 */
@RestController
@RequestMapping("/api/v1/messstellen/{id}")
public class MessstelleMsbAbgleichController {

    private final MsbAbgleichService abgleich;
    private final RechtPruefung rechte;

    public MessstelleMsbAbgleichController(MsbAbgleichService abgleich, RechtPruefung rechte) {
        this.abgleich = abgleich;
        this.rechte = rechte;
    }

    /**
     * Recht: {@code messstelle.ansehen}. Je Monat Gerät, Messstellenbetreiber, Unterschied, Ampel und Wirkung, dazu
     * die Importe und die Schwellen.
     */
    @GetMapping("/msb-abgleich")
    public MsbAbgleichService.Messstelle ansehen(@PathVariable UUID id) {
        imZugriff(id);
        return abgleich.messstelle(id);
    }

    /** Recht: {@code messstelle.bearbeiten}. Eine CSV mit Viertelstundenwerten des Messstellenbetreibers. */
    @PostMapping(value = "/msb-werte", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @Recht(value = "messstelle.bearbeiten", ziel = RechtZiel.MESSSTELLE)
    public MsbAbgleichService.Eingelesen einlesen(@PathVariable UUID id, @RequestPart("datei") MultipartFile datei,
            Authentication auth) throws IOException {
        ProtokollAkteur wer = ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
        return abgleich.einlesen(id, datei.getOriginalFilename(), datei.getBytes(), wer);
    }

    private void imZugriff(UUID id) {
        rechte.pruefenLesen(RechtZiel.MESSSTELLE, id,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
    }

    /** {@code {code, message, …Fakten}}. */
    @ExceptionHandler(MsbAbgleichAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MsbAbgleichAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).contentType(MediaType.APPLICATION_JSON).body(body);
    }

    /** Eine unbekannte Messstelle aus der Zählerrolle: {@code {code, message}}. */
    @ExceptionHandler(ZaehlerrolleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> rolle(ZaehlerrolleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).contentType(MediaType.APPLICATION_JSON).body(body);
    }
}
