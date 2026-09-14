package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.KorrekturFreigabeAbgelehnt;
import com.voltpilot.api.uems.KorrekturFreigabeAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.KorrekturFreigabeService;
import com.voltpilot.api.uems.KorrekturFreigabeService.Entscheidung;
import com.voltpilot.api.uems.KorrekturFreigabeService.VierAugen;
import com.voltpilot.api.uems.MessreiheFassungen.Fassung;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.KorrekturFreigabeDto;
import java.time.ZoneOffset;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;
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
import org.springframework.web.bind.annotation.RestController;

/**
 * Vier Augen bei Korrekturen (UEMS AP-08 IP-15, Entscheid E8 = A): die Einstellung je Unternehmen und die
 * Entscheidung über eine Korrektur. Die Arbeit macht {@link KorrekturFreigabeService}.
 *
 * <p><b>Rechte — hier DURCHGESETZT</b> (die erste UEMS-Stelle, die es tut; die anderen Routen nennen ihre
 * Kennung nur): jede Route nennt im Kommentar ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json},
 * und der Dienst prüft sie über {@code KorrekturRechte} → {@code RechteAbleitung}. Fremd ist 404
 * {@code nicht_gefunden}, nie 403; ein 403 gilt nur im eigenen Kundenbereich ({@code recht_fehlt} mit
 * {@code rolle_noetig}, oder {@code zweite_person_noetig}).
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein JSON-Objekt, nur das eine bekannte Feld, Text bzw. bei
 * {@code vieraugen} ein Wahrheitswert — sonst 400 {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1")
public class KorrekturFreigabeController {

    /** K-… eine Korrektur einer Reihe (AP-08), BK-… die Berichtigung eines Bezugsgrößen-Werts (AP-09 IP-7). */
    private static final Pattern KENNUNG = Pattern.compile("^(K|BK)-[0-9]{4}-[0-9]{4,}$");

    private final KorrekturFreigabeService dienst;
    private final ObjectMapper streng;

    public KorrekturFreigabeController(KorrekturFreigabeService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Recht: lesend — keine eigene Kennung (wie das Unternehmen-Lesemodell); das Portal sperrt damit den Knopf. */
    @GetMapping("/unternehmen/vieraugen")
    public KorrekturFreigabeDto.VierAugen vierAugen() {
        return form(dienst.einstellung());
    }

    /** Recht: {@code vieraugen.einstellen} (AP-08 §4.8, E8) — nur der Kundenadministrator. */
    @PutMapping("/unternehmen/vieraugen")
    public KorrekturFreigabeDto.VierAugen vierAugenEinstellen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        KorrekturFreigabeDto.VierAugenSetzen b = lies(body, KorrekturFreigabeDto.VierAugenSetzen.class, true);
        return form(dienst.einstellen(b.vieraugen(), wer));
    }

    /** Recht: {@code korrektur.freigeben} (AP-08 §4.8, E8) — bei Vier-Augen an nie der Ersteller. */
    @PostMapping("/korrekturen/{kennung}/freigeben")
    public KorrekturFreigabeDto.Entscheidung freigeben(@PathVariable String kennung,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        KorrekturFreigabeDto.Freigeben b = lies(body, KorrekturFreigabeDto.Freigeben.class, false);
        return form(dienst.freigeben(k, b.begruendung(), wer));
    }

    /** Recht: {@code korrektur.zuruecknehmen} (AP-08 §5) — der Bearbeiter nur die eigene und nur bei aus. */
    @PostMapping("/korrekturen/{kennung}/zuruecknehmen")
    public KorrekturFreigabeDto.Entscheidung zuruecknehmen(@PathVariable String kennung,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        KorrekturFreigabeDto.Zuruecknehmen b = lies(body, KorrekturFreigabeDto.Zuruecknehmen.class, false);
        return form(dienst.zuruecknehmen(k, b.grund(), wer));
    }

    // ------------------------------------------------------------------ Formen

    private static KorrekturFreigabeDto.VierAugen form(VierAugen v) {
        return new KorrekturFreigabeDto.VierAugen(v.an(), v.vorgabe());
    }

    private static KorrekturFreigabeDto.Entscheidung form(Entscheidung e) {
        Fassung f = e.fassung();
        return new KorrekturFreigabeDto.Entscheidung(e.korrektur().kennung(), f.status(), f.fassung(),
                urheber(e.korrektur().ersteller()), urheber(f.akteur()), f.am().atOffset(ZoneOffset.UTC), f.grund(),
                e.vierAugen(), e.vonErsteller());
    }

    private static KorrekturFreigabeDto.Urheber urheber(ProtokollAkteur a) {
        return new KorrekturFreigabeDto.Urheber(a.name(), a.rolle(), a.art());
    }

    /** Eine Kennung, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    private static String kennung(String text) {
        if (text == null || !KENNUNG.matcher(text).matches()) {
            throw KorrekturFreigabeAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        return text;
    }

    /** Der strenge Mapper: ein JSON-Objekt, nur bekannte Felder, Text oder {@code null} — bzw. ein Wahrheitswert. */
    private <T> T lies(JsonNode body, Class<T> form, boolean wahrheitswert) {
        if (body == null || !body.isObject()) {
            throw KorrekturFreigabeAbgelehnt.anfrage("");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = body.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            JsonNode wert = f.getValue();
            boolean passt = wert.isNull() || (wahrheitswert ? wert.isBoolean() : wert.isTextual());
            if (!passt) {
                throw KorrekturFreigabeAbgelehnt.anfrage(f.getKey());
            }
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw KorrekturFreigabeAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw KorrekturFreigabeAbgelehnt.anfrage(e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName());
        } catch (JsonProcessingException e) {
            throw KorrekturFreigabeAbgelehnt.anfrage("");
        }
    }

    /** {@code {code, message, …Fakten}} — Code, Status und Satz aus dem geschlossenen Satz. */
    @ExceptionHandler(KorrekturFreigabeAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(KorrekturFreigabeAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(KorrekturFreigabeAbgelehnt.anfrage(""));
    }
}
