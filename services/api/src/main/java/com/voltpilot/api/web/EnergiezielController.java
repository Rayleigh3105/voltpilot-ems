package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.EnergiezielService;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.web.dto.EnergiezielDto;
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
 * Energieziele (UEMS AP-18 IP-6, Z1–Z4; Vertrag verbesserung.md §4): anlegen, lesen, ändern solange offen,
 * Verantwortlicher, beenden und der Ziel-Stand; bewerten mit Vier-Augen (IP-7, Z5). Die Arbeit macht
 * {@link EnergiezielService}.
 *
 * <p><b>Rechte:</b> Schreibrouten {@code verbesserung.verwalten}, die Bewertung {@code verbesserung.abschliessen} — je
 * an der Geltung der Kennzahl (403 {@code recht_fehlt});
 * Lesen {@code verbesserung.ansehen} als Kennung im Kommentar — die Sichtbarkeit kommt über die Kennzahl und
 * {@code standort_id} (RLS), außerhalb 404.
 */
@RestController
@RequestMapping("/api/v1/energieziele")
public class EnergiezielController {

    private final EnergiezielService ziele;
    private final ObjectMapper streng;

    public EnergiezielController(EnergiezielService ziele, ObjectMapper json) {
        this.ziele = ziele;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code verbesserung.ansehen} (Zaun über Kennzahl und Standort). Das Register; {@code kennzahl} (ID) und
     * {@code zustand} ({@code offen · bewertet · beendet}) filtern.
     */
    @GetMapping
    public EnergiezielDto.Liste liste(@RequestParam(required = false) String kennzahl,
            @RequestParam(required = false) String zustand, HttpServletRequest anfrage) {
        return ziele.liste(anfrage.getParameterMap().keySet(), kennzahl, zustand);
    }

    /**
     * Recht: {@code verbesserung.verwalten} an der Geltung der Kennzahl. Legt EZ-JJJJ-nnnn an einer Kennzahl mit
     * freigegebener Bezugsbasis an (sonst 422 {@code kennzahl_ohne_bezugsbasis}); Zielperiode fest, nicht rückwirkend
     * (400 {@code zielperiode_ungueltig}/{@code zielperiode_rueckwirkend}); je Kennzahl und Zielperiode ein laufendes
     * Ziel (409 {@code energieziel_laeuft}).
     */
    @PostMapping
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<EnergiezielDto.Energieziel> anlegen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        EnergiezielDto.Energieziel neu = ziele.anlegen(lies(body, EnergiezielDto.Anlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/energieziele/" + neu.id())).body(neu);
    }

    /** Recht: {@code verbesserung.ansehen}. Das Energieziel mit Verlauf; außerhalb der Sicht 404. */
    @GetMapping("/{id}")
    public EnergiezielDto.Energieziel eines(@PathVariable UUID id) {
        return ziele.eines(id);
    }

    /**
     * Recht: {@code verbesserung.verwalten} an der Geltung der Kennzahl. Wortlaut und Ende der Zielperiode (nur nach
     * hinten), solange offen (sonst 409 {@code energieziel_nicht_offen}), mit Begründung — eine Zeile im Verlauf.
     */
    @PutMapping("/{id}")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public EnergiezielDto.Energieziel aendern(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return ziele.aendern(id, lies(body, EnergiezielDto.Aendern.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten} an der Geltung der Kennzahl. Setzt den Verantwortlichen mit Begründung. */
    @PutMapping("/{id}/verantwortlicher")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public EnergiezielDto.Energieziel verantwortlicher(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ziele.verantwortlicher(id, lies(body, EnergiezielDto.Verantwortlicher.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten} an der Geltung der Kennzahl. Beendet vorzeitig (Tag, Begründung). */
    @PostMapping("/{id}/beenden")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public EnergiezielDto.Energieziel beenden(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return ziele.beenden(id, lies(body, EnergiezielDto.Beenden.class), akteur(auth));
    }

    /**
     * Recht: {@code verbesserung.ansehen}. Der Ziel-Stand (Z3, Z4): je Monat der Zielperiode das Vergleichsergebnis
     * der Bezugsbasis, Σ ÷ Σ über die bewertbaren endgültigen Monate, „x von y“, Ausschlüsse mit Grund, ein Vorschlag
     * nur bei vollständiger Periode.
     */
    @GetMapping("/{id}/stand")
    public EnergiezielDto.Stand stand(@PathVariable UUID id) {
        return ziele.stand(id);
    }

    /**
     * Recht: {@code verbesserung.abschliessen} an der Geltung der Kennzahl. Bewertet das Ziel nach dem Ende der
     * Zielperiode (letzter Monat endgültig, sonst 409 {@code bewertung_nicht_faellig}): Ergebnis
     * {@code erreicht · verfehlt · nicht_bewertbar}, Begründung 10–500 Zeichen; die Bewertung ist eine Kopie des
     * Ziel-Stands mit Prüfsumme (Z5). Mit Vier-Augen 409 {@code vieraugen_beantragen}; ein zweites Mal 409
     * {@code energieziel_nicht_offen}.
     */
    @PostMapping("/{id}/bewerten")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public EnergiezielDto.Energieziel bewerten(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return ziele.bewerten(id, lies(body, EnergiezielDto.Bewerten.class), akteur(auth));
    }

    /**
     * Recht: {@code verbesserung.abschliessen} an der Geltung der Kennzahl. Mit Vier-Augen beantragt die erste Person
     * die Bewertung (Ergebnis, Begründung, Kopie mit Prüfsumme); ohne Vier-Augen 409 {@code vieraugen_aus}.
     */
    @PostMapping("/{id}/bewertung/beantragen")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public EnergiezielDto.Energieziel bewertungBeantragen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ziele.beantragen(id, lies(body, EnergiezielDto.Bewerten.class), akteur(auth));
    }

    /**
     * Recht: {@code verbesserung.abschliessen} an der Geltung der Kennzahl. Die zweite Person (KA/EM) bestätigt den
     * Antrag; wer beantragt hat, 422 {@code vieraugen_urheber}; ohne Antrag 409 {@code bewertung_nicht_beantragt}.
     */
    @PostMapping("/{id}/bewertung/freigeben")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public EnergiezielDto.Energieziel bewertungFreigeben(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ziele.freigeben(id, lies(body, EnergiezielDto.Entscheid.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.abschliessen} an der Geltung der Kennzahl. Die zweite Person lehnt mit Begründung ab. */
    @PostMapping("/{id}/bewertung/ablehnen")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public EnergiezielDto.Energieziel bewertungAblehnen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ziele.ablehnen(id, lies(body, EnergiezielDto.Entscheid.class), akteur(auth));
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

    /** Die Kennzahl selbst lehnt ab (404 außerhalb der Sicht, 403 ohne Recht an ihrer Geltung). */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> kennzahl(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie ein Energieziel, das es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new VerbesserungAbgelehnt(404, "nicht_gefunden", "Dieses Energieziel gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(VerbesserungAbgelehnt.anfrage(""));
    }
}
