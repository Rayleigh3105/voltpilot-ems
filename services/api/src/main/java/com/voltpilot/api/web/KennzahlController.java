package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.KennzahlAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.KennzahlService;
import com.voltpilot.api.uems.KennzahlVorschauService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.KennzahlDto;
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
import org.springframework.web.bind.annotation.DeleteMapping;
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
 * Die Kennzahlen des Kundenbereichs (UEMS AP-11 IP-5, Vertrag {@code docs/contracts/v2/kennzahl.md}): anlegen mit
 * Fassung 1, lesen, Stammdaten ändern, archivieren, löschen, die Berechnung ab einem Tag als Fassung n + 1, die
 * Fassung an einem Stichtag — und die Vorschau, die nichts schreibt. Die Arbeit macht {@link KennzahlService} bzw.
 * {@link KennzahlVorschauService}, die Regeln {@code KennzahlRegeln}.
 *
 * <p><b>Rechte:</b> das Definieren setzt {@code KennzahlRechte} über die Rechte-Ableitung durch — die Kennung folgt
 * aus dem Geltungsbereich (G1), 403 {@code recht_fehlt} mit {@code rolle_noetig} im eigenen Geltungsbereich, 404 für
 * einen fremden Standort (fremd ist nicht da). Das Ansehen trägt {@code messwerte.ansehen} als Kennung; die
 * Sichtbarkeit R-A1 ∧ R-A6 je Person setzt AP-03 IP-11 durch. Jede Route nennt ihre Kennung im Kommentar
 * ({@code RechteKennungenDerRoutenTest}).
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein Feld, das es an der Route nicht gibt (auch camelCase), ein Feld
 * falschen Typs und eine ID, die keine ist, sind 400 {@code anfrage_ungueltig} mit {@code feld} — nie still
 * verworfen. Jede Ablehnung spricht Code, Status und Satz aus dem geschlossenen Satz {@link Ablehnung}.
 */
@RestController
@RequestMapping("/api/v1/kennzahlen")
public class KennzahlController {

    private enum Art { TEXT, JA_NEIN, EINGAENGE }

    private static final Map<String, Art> ANLEGEN = felder("kennzeichen", Art.TEXT, "name", Art.TEXT, "rechenform",
            Art.TEXT, "geltung_art", Art.TEXT, "geltung_id", Art.TEXT, "verantwortlich_name", Art.TEXT, "zweck", Art.TEXT,
            "periode_art", Art.TEXT, "komplement", Art.JA_NEIN, "eingaenge", Art.EINGAENGE);
    private static final Map<String, Art> STAMMDATEN = felder("kennzeichen", Art.TEXT, "name", Art.TEXT,
            "verantwortlich_name", Art.TEXT, "zweck", Art.TEXT);
    private static final Map<String, Art> FASSUNG = felder("gueltig_ab", Art.TEXT, "begruendung", Art.TEXT,
            "periode_art", Art.TEXT, "komplement", Art.JA_NEIN, "eingaenge", Art.EINGAENGE);
    private static final java.util.Set<String> EINGANG = java.util.Set.of("rolle", "art", "kennzeichen");

    private final KennzahlService kennzahlen;
    private final KennzahlVorschauService vorschau;
    private final ObjectMapper streng;

    public KennzahlController(KennzahlService kennzahlen, KennzahlVorschauService vorschau, ObjectMapper json) {
        this.kennzahlen = kennzahlen;
        this.vorschau = vorschau;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Recht: {@code messwerte.ansehen} (AP-11 R2). Archivierte eingeschlossen, nach Kennzeichen. */
    @GetMapping
    public KennzahlDto.Liste alle() {
        return kennzahlen.liste();
    }

    /**
     * Recht: {@code kennzahl.standort_definieren} bzw. {@code kennzahl.unternehmen_definieren} nach dem
     * Geltungsbereich (G1, R1). Legt die Kennzahl mit Fassung 1 „gilt seit Beginn“ an; ohne Kennzeichen vergibt der
     * Server KZ-0001 …
     */
    @PostMapping
    public ResponseEntity<KennzahlDto.Kennzahl> anlegen(@RequestBody(required = false) JsonNode body, Authentication auth) {
        KennzahlDto.Kennzahl neu = kennzahlen.anlegen(lies(body, ANLEGEN, KennzahlDto.Anfrage.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/kennzahlen/" + neu.id())).body(neu);
    }

    /**
     * Recht: {@code kennzahl.standort_definieren} bzw. {@code kennzahl.unternehmen_definieren} nach dem
     * Geltungsbereich — die Vorschau ist Schritt 5 des Anlegens. Nur-Lese-Transaktion: Prüfungen und die letzten drei
     * abgeschlossenen Perioden, nichts wird geschrieben.
     */
    @PostMapping("/vorschau")
    public KennzahlDto.Vorschau vorschau(@RequestBody(required = false) JsonNode body, Authentication auth) {
        return vorschau.vorschau(lies(body, ANLEGEN, KennzahlDto.Anfrage.class), akteur(auth));
    }

    /** Recht: {@code messwerte.ansehen}. */
    @GetMapping("/{id}")
    public KennzahlDto.Kennzahl eine(@PathVariable UUID id) {
        return kennzahlen.eine(id);
    }

    /**
     * Recht: {@code kennzahl.standort_definieren} bzw. {@code kennzahl.unternehmen_definieren} nach dem
     * Geltungsbereich. Die GANZEN Stammdaten ohne Fassung (V4); Geltungsbereich und Rechenform sind fest.
     */
    @PutMapping("/{id}")
    public KennzahlDto.Kennzahl aendern(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return kennzahlen.aendern(id, lies(body, STAMMDATEN, KennzahlDto.StammdatenAnfrage.class), akteur(auth));
    }

    /**
     * Recht: {@code kennzahl.standort_definieren} bzw. {@code kennzahl.unternehmen_definieren} nach dem
     * Geltungsbereich. Nur ohne einen einzigen Wert und ohne lesende Kennzahl (V5); das Kennzeichen bleibt belegt.
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> loeschen(@PathVariable UUID id, Authentication auth) {
        kennzahlen.loeschen(id, akteur(auth));
        return ResponseEntity.noContent().build();
    }

    /**
     * Recht: {@code kennzahl.standort_definieren} bzw. {@code kennzahl.unternehmen_definieren} nach dem
     * Geltungsbereich. Die Werte bleiben lesbar, kein Rechenlauf mehr (V5).
     */
    @PostMapping("/{id}/archivieren")
    public KennzahlDto.Kennzahl archivieren(@PathVariable UUID id, Authentication auth) {
        return kennzahlen.archivieren(id, akteur(auth));
    }

    /** Recht: {@code messwerte.ansehen}. Jede Fassung der Berechnung, nach Nummer. */
    @GetMapping("/{id}/fassungen")
    public KennzahlDto.Fassungen fassungen(@PathVariable UUID id) {
        return kennzahlen.fassungen(id);
    }

    /**
     * Recht: {@code kennzahl.standort_definieren} bzw. {@code kennzahl.unternehmen_definieren} nach dem
     * Geltungsbereich. Fassung n + 1 ab {@code gueltig_ab}, mit Begründung, auch rückwirkend (V1, K17).
     */
    @PostMapping("/{id}/fassungen")
    public KennzahlDto.Fassungen fassungEintragen(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return kennzahlen.fassungEintragen(id, lies(body, FASSUNG, KennzahlDto.FassungAnfrage.class), akteur(auth));
    }

    /** Recht: {@code messwerte.ansehen}. Die Fassung, die am Tag {@code am} (JJJJ-MM-TT, Vorgabe heute) galt. */
    @GetMapping("/{id}/berechnung")
    public KennzahlDto.Berechnung berechnung(@PathVariable UUID id, @RequestParam(required = false) String am) {
        LocalDate tag = null;
        if (am != null && !am.isBlank()) {
            try {
                tag = LocalDate.parse(am.strip());
            } catch (DateTimeParseException e) {
                throw KennzahlAbgelehnt.anfrage("am");
            }
        }
        return kennzahlen.berechnung(id, tag);
    }

    // ----------------------------------------------------------------------------- Gerüst

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** Ein JSON-Objekt mit nur den Feldern der Route, jedes in seiner Art oder {@code null} — sonst 400 mit {@code feld}. */
    private <T> T lies(JsonNode body, Map<String, Art> erlaubt, Class<T> form) {
        if (body == null || !body.isObject()) {
            throw KennzahlAbgelehnt.anfrage("");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = body.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            Art art = erlaubt.get(f.getKey());
            JsonNode w = f.getValue();
            boolean passt = art != null && (w.isNull() || switch (art) {
                case TEXT -> w.isTextual();
                case JA_NEIN -> w.isBoolean();
                case EINGAENGE -> eingaenge(w);
            });
            if (!passt) {
                throw KennzahlAbgelehnt.anfrage(f.getKey());
            }
        }
        try {
            return streng.treeToValue(body, form);
        } catch (JsonProcessingException e) {
            throw KennzahlAbgelehnt.anfrage("");
        }
    }

    private static boolean eingaenge(JsonNode w) {
        if (!w.isArray()) {
            return false;
        }
        for (JsonNode e : w) {
            if (!e.isObject()) {
                return false;
            }
            for (Iterator<Map.Entry<String, JsonNode>> it = e.fields(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> f = it.next();
                if (!EINGANG.contains(f.getKey()) || !(f.getValue().isTextual() || f.getValue().isNull())) {
                    return false;
                }
            }
        }
        return true;
    }

    private static Map<String, Art> felder(Object... paare) {
        Map<String, Art> m = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            m.put((String) paare[i], (Art) paare[i + 1]);
        }
        return Map.copyOf(m);
    }

    /** {@code {code, message, …Fakten}} — Code, Status und Satz aus dem geschlossenen Satz des Vertrags. */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(KennzahlAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(KennzahlAbgelehnt.anfrage(""));
    }
}
