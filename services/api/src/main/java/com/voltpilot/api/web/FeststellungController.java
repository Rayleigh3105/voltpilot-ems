package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.FeststellungService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.FeststellungDto;
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
 * UEMS AP-19 IP-19: Feststellung und Wirksamkeit (FS1–FS7, W15, §5.4, §5.6) — erfassen, Einträge, Frist und
 * Verantwortlich ändern, die Wirksamkeit als Stand mit Kopie und Prüfsumme, abschließen ohne Maßnahme oder
 * zurücknehmen, Vier-Augen beantragen, freigeben, ablehnen. Die Arbeit macht {@link FeststellungService}.
 *
 * <p><b>Rechte:</b> Erfassen, Einträge, Frist und Verantwortlich {@code energiemanagement.verwalten} am Standort des
 * Bezugs (Ziel {@code DIENST}: ohne Standort am Unternehmen, der Dienst prüft genau), jeder Stand
 * {@code energiemanagement.freigeben} am Unternehmen (403 {@code recht_fehlt}; „Einsicht“ schreibt nie). Lesen
 * {@code energiemanagement.ansehen} als Kennung im Kommentar — die Sichtbarkeit kommt aus RLS und dem Standort-Zaun von
 * IP-16 (eine Feststellung ohne Standort sieht nur, wer unternehmensweit liest). Gelöscht wird nie.
 */
@RestController
@RequestMapping("/api/v1/energiemanagement/feststellungen")
public class FeststellungController {

    private final FeststellungService dienst;
    private final ObjectMapper streng;

    public FeststellungController(FeststellungService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Die Feststellungen am {@code tag} (Vorgabe heute): offene zuerst, am
     * längsten überfällig oben, dann abgeschlossene mit Ergebnis; „überfällig seit n Tagen“ beim Abruf (FS1).
     */
    @GetMapping
    public FeststellungDto.Liste liste(@RequestParam(required = false) String tag) {
        return dienst.liste(tag(tag));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Standort des Bezugs, ohne Standort am Unternehmen. Erfasst eine
     * Feststellung (FS1): Quelle, Wortlaut, Vorgabe, Bezug, festgestellt von und am, Verantwortlich, wahlfrei Frist.
     */
    @PostMapping
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<FeststellungDto.FeststellungMitVerlauf> erfassen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        UUID id = dienst.erfassen(lies(body, FeststellungDto.Erfassen.class), wer);
        return ResponseEntity.created(URI.create("/api/v1/energiemanagement/feststellungen/" + id))
                .body(dienst.feststellung(id, wer));
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Die Feststellung mit Einträgen, Maßnahmen, Ständen, Verlauf und dem
     * Antwortfeld {@code vieraugen} („Vier-Augen nicht erfüllbar: …“, FS6); unbekannt 404.
     */
    @GetMapping("/{id}")
    public FeststellungDto.FeststellungMitVerlauf feststellung(@PathVariable UUID id, Authentication auth) {
        return dienst.feststellung(id, ProtokollAkteur.aus(auth).orElse(null));
    }

    /**
     * Recht: {@code energiemanagement.verwalten} am Standort des Bezugs. Hängt einen Eintrag an (FS2) — Kommentar,
     * sofortige Behebung, Ursache (Aussage), ähnliche Fälle — immer mit Person und Tag.
     */
    @PostMapping("/{id}/eintraege")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<FeststellungDto.FeststellungMitVerlauf> eintrag(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        dienst.eintrag(id, lies(body, FeststellungDto.EintragFesthalten.class), wer);
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.feststellung(id, wer));
    }

    /** Recht: {@code energiemanagement.verwalten} am Standort des Bezugs. Die Frist ändern, solange offen, mit Begründung. */
    @PutMapping("/{id}/frist")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.DIENST)
    public FeststellungDto.FeststellungMitVerlauf frist(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        dienst.frist(id, lies(body, FeststellungDto.FristAendern.class), wer);
        return dienst.feststellung(id, wer);
    }

    /** Recht: {@code energiemanagement.verwalten} am Standort des Bezugs. Den Verantwortlichen ändern, mit Begründung. */
    @PutMapping("/{id}/verantwortlicher")
    @Recht(value = "energiemanagement.verwalten", ziel = RechtZiel.DIENST)
    public FeststellungDto.FeststellungMitVerlauf verantwortlicher(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        dienst.verantwortlich(id, lies(body, FeststellungDto.VerantwortlichAendern.class), wer);
        return dienst.feststellung(id, wer);
    }

    /**
     * Recht: {@code energiemanagement.freigeben} am Unternehmen. Hält die Wirksamkeit als Stand Nr. n fest (FS4) —
     * {@code wirksam} schließt ab, {@code nicht_wirksam} hält offen; mit Vier-Augen 409 {@code vieraugen_beantragen}.
     */
    @PostMapping("/{id}/wirksamkeit")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<FeststellungDto.FeststellungMitVerlauf> wirksamkeit(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        dienst.wirksamkeit(id, lies(body, FeststellungDto.StandFesthalten.class), wer);
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.feststellung(id, wer));
    }

    /**
     * Recht: {@code energiemanagement.freigeben} am Unternehmen. Vier-Augen: die Urheberin beantragt einen Stand mit
     * einem der vier Ergebnisse; ist niemand zweite Person, 409 {@code vieraugen_nicht_erfuellbar} mit dem Satz.
     */
    @PostMapping("/{id}/wirksamkeit/beantragen")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<FeststellungDto.FeststellungMitVerlauf> beantragen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        dienst.beantragen(id, lies(body, FeststellungDto.StandFesthalten.class), wer);
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.feststellung(id, wer));
    }

    /**
     * Recht: {@code energiemanagement.freigeben} am Unternehmen. Vier-Augen: die zweite Person bestätigt den offenen
     * Antrag — nie die Urheberin, nie der Verantwortliche der Feststellung (FS6).
     */
    @PostMapping("/{id}/wirksamkeit/freigeben")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.UNTERNEHMEN)
    public FeststellungDto.FeststellungMitVerlauf freigeben(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        lies(body, Leer.class);
        dienst.freigeben(id, wer);
        return dienst.feststellung(id, wer);
    }

    /** Recht: {@code energiemanagement.freigeben} am Unternehmen. Vier-Augen: die zweite Person lehnt mit Begründung ab. */
    @PostMapping("/{id}/wirksamkeit/ablehnen")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.UNTERNEHMEN)
    public FeststellungDto.FeststellungMitVerlauf ablehnen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        dienst.ablehnen(id, lies(body, FeststellungDto.Ablehnen.class), wer);
        return dienst.feststellung(id, wer);
    }

    /**
     * Recht: {@code energiemanagement.freigeben} am Unternehmen. Schließt ohne Maßnahme ab (FS5):
     * {@code ohne_massnahme} (die sofortige Behebung genügt) oder {@code zurueckgenommen} — ein Stand mit Kopie.
     */
    @PostMapping("/{id}/abschliessen")
    @Recht(value = "energiemanagement.freigeben", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<FeststellungDto.FeststellungMitVerlauf> abschliessen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = akteur(auth);
        dienst.abschliessen(id, lies(body, FeststellungDto.StandFesthalten.class), wer);
        return ResponseEntity.status(HttpStatus.CREATED).body(dienst.feststellung(id, wer));
    }

    /** Der Körper des Freigebens: leer — „entschieden von“, Ergebnis und Kopie stehen im Antrag. */
    record Leer() {}

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

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine Feststellung, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Diese Feststellung gibt es nicht.",
                null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(EnergiemanagementAbgelehnt.anfrage(""));
    }
}
