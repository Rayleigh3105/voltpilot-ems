package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.EnergiemanagementDokumentService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
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
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS AP-19 IP-7: Dokumente im Energiemanagement — anlegen, Fassung entwerfen, beantragen, freigeben, ablehnen,
 * „geprüft, bleibt“, bekannt machen, aufheben; Überprüfung beim Abruf und der Vergleich Anwendungsbereich ⟷
 * Betrachtungsumfang (DK1–DK8, W5). Die Arbeit macht {@link EnergiemanagementDokumentService}.
 *
 * <p><b>Rechte:</b> Schreibrouten {@code energiemanagement.verwalten} bzw. {@code energiemanagement.freigeben} am
 * Standort des Bezugs oder am Unternehmen ({@link RechtZiel#DIENST}: der Interceptor prüft vor, der Dienst genau; 403
 * {@code recht_fehlt}). Lesen {@code energiemanagement.ansehen} als Kennung im Kommentar — der Zaun folgt dem Standort
 * des Bezugs, ein Dokument am Unternehmen sieht nur, wer unternehmensweit liest; außerhalb 404. Gelöscht wird nie: es
 * gibt keine Löschroute, „aufheben“ lässt das Dokument lesbar (DK8).
 */
@RestController
@RequestMapping("/api/v1/energiemanagement/dokumente")
public class EnergiemanagementDokumentController {

    private final EnergiemanagementDokumentService dienst;
    private final ObjectMapper streng;

    public EnergiemanagementDokumentController(EnergiemanagementDokumentService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }

    /** Recht: {@code energiemanagement.ansehen}. Die Dokumente im Zaun, nach Kennzeichen, je mit Überprüfung. */
    @GetMapping
    public EnergiemanagementDokumentDto.Dokumente dokumente() {
        return dienst.dokumente();
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Standort des Bezugs bzw. am Unternehmen. Legt ein Dokument im
     * Entwurf an — Art, Titel, Bezug; wahlfrei Überprüfung in Monaten und das Original als Verweis (DK1).
     */
    @PostMapping
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<EnergiemanagementDokumentDto.Dokument> anlegen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UUID id = dienst.anlegen(lies(body, EnergiemanagementDokumentDto.DokumentAnlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/energiemanagement/dokumente/" + id))
                .body(dienst.dokument(id));
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Das Dokument mit Fassungen (die früheren freigegebenen „abgeloest“),
     * Einträgen, Verlauf, der Überprüfung beim Abruf und den Kundensätzen; außerhalb des Zauns 404.
     */
    @GetMapping("/{id}")
    public EnergiemanagementDokumentDto.Dokument dokument(@PathVariable UUID id) {
        return dienst.dokument(id);
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Nur am Anwendungsbereich: seine gültige Fassung neben dem laufenden
     * Betrachtungsumfang der energetischen Bewertung, Unterschiede in einem Satz ohne Urteil (DK7, W5).
     */
    @GetMapping("/{id}/vergleich")
    public EnergiemanagementDokumentDto.Vergleich vergleich(@PathVariable UUID id) {
        return dienst.vergleich(id);
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Standort des Bezugs bzw. am Unternehmen. Entwirft Fassung n —
     * Wortlaut oder Verweis, beim Anwendungsbereich Standorte und Träger; ein offener Entwurf wird überschrieben (200),
     * sonst entsteht eine neue Fassung (201).
     */
    @PostMapping("/{id}/fassungen")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<EnergiemanagementDokumentDto.Dokument> entwerfen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        var e = dienst.entwerfen(id, lies(body, EnergiemanagementDokumentDto.FassungEntwerfen.class), akteur(auth));
        var dokument = dienst.dokument(id);
        return e.neu() ? ResponseEntity.created(URI.create("/api/v1/energiemanagement/dokumente/" + id
                + "/fassungen/" + e.nr())).body(dokument) : ResponseEntity.ok(dokument);
    }

    /** Recht: {@code energiemanagement.freigeben}. Vier-Augen: die erste Person beantragt mit „entschieden von“. */
    @PostMapping("/{id}/fassungen/{nr}/beantragen")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.DIENST)
    public EnergiemanagementDokumentDto.Dokument beantragen(@PathVariable UUID id, @PathVariable int nr,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.beantragen(id, nr, lies(body, EnergiemanagementDokumentDto.Entscheid.class), akteur(auth));
        return dienst.dokument(id);
    }

    /**
     * Recht: {@code energiemanagement.freigeben}. Gibt frei — ohne Vier-Augen den Entwurf mit „entschieden von“, mit
     * Vier-Augen den Antrag durch eine zweite Person; Leitungs-Pflicht 422 {@code leitung_fehlt}.
     */
    @PostMapping("/{id}/fassungen/{nr}/freigeben")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.DIENST)
    public EnergiemanagementDokumentDto.Dokument freigeben(@PathVariable UUID id, @PathVariable int nr,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.freigeben(id, nr, lies(body, EnergiemanagementDokumentDto.Entscheid.class), akteur(auth));
        return dienst.dokument(id);
    }

    /** Recht: {@code energiemanagement.freigeben}. Vier-Augen: die zweite Person lehnt den Antrag mit Begründung ab. */
    @PostMapping("/{id}/fassungen/{nr}/ablehnen")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.DIENST)
    public EnergiemanagementDokumentDto.Dokument ablehnen(@PathVariable UUID id, @PathVariable int nr,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.ablehnen(id, nr, lies(body, EnergiemanagementDokumentDto.Ablehnen.class), akteur(auth));
        return dienst.dokument(id);
    }

    /** Recht: {@code energiemanagement.freigeben}. „Geprüft, bleibt“ an der gültigen Fassung einer Vorgabe (DK5). */
    @PostMapping("/{id}/geprueft")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.DIENST)
    public EnergiemanagementDokumentDto.Dokument geprueft(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.geprueft(id, lies(body, EnergiemanagementDokumentDto.Geprueft.class), akteur(auth));
        return dienst.dokument(id);
    }

    /** Recht: {@code energiemanagement.verwalten}. Bekannt gemacht an einem Kreis über einen Weg (DK6). */
    @PostMapping("/{id}/bekanntmachungen")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<EnergiemanagementDokumentDto.Dokument> bekanntmachen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.bekanntmachen(id, lies(body, EnergiemanagementDokumentDto.Bekanntmachen.class), akteur(auth));
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.dokument(id));
    }

    /** Recht: {@code energiemanagement.freigeben}. Hebt das Dokument auf — Tag und Begründung; es bleibt lesbar (DK8). */
    @PostMapping("/{id}/aufheben")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.DIENST)
    public EnergiemanagementDokumentDto.Dokument aufheben(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.aufheben(id, lies(body, EnergiemanagementDokumentDto.Aufheben.class), akteur(auth));
        return dienst.dokument(id);
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

    /** Eine ID oder Nr. im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt("nr".equals(e.getName()) ? EnergiemanagementAbgelehnt.fassungFehlt()
                : EnergiemanagementAbgelehnt.dokumentFehlt());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(EnergiemanagementAbgelehnt.anfrage(""));
    }
}
