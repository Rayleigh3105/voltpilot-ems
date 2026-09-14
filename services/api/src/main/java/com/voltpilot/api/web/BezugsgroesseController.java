package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.BezugsgroesseAbgelehnt;
import com.voltpilot.api.uems.BezugsgroesseRegeln;
import com.voltpilot.api.uems.BezugsgroesseRegeln.Ablehnung;
import com.voltpilot.api.uems.BezugsgroesseService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
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
 * Die Bezugsgrößen des Kundenbereichs (UEMS AP-09 IP-5, Vertrag
 * {@code docs/contracts/v2/bezugsdaten.md} — Block {@code verwalten}): anlegen, lesen, ändern,
 * archivieren, löschen, und die Werte mit ihren Fassungen und der Herkunft je Fassung. Die Arbeit
 * macht {@link BezugsgroesseService}, die Regeln M1–M6 {@link BezugsgroesseRegeln}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS — eine fremde Bezugsgröße ist 404 {@code nicht_gefunden}, nie 403; der
 * Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}. Jede Route nennt im Kommentar
 * ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json} (AP-09 §4.11, W8)
 * ({@code RechteKennungenDerRoutenTest} hält sie an die Matrix); durchgesetzt wird sie hier nicht.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein Feld, das es an der Route nicht gibt (auch
 * camelCase), ein Feld, das kein Text ist, und eine {@code geltung_id}, die keine ID ist, sind 400
 * {@code anfrage_ungueltig} mit {@code feld} — nie still verworfen. Jede Ablehnung spricht Code,
 * Status und Kundensatz aus dem geschlossenen Satz {@link Ablehnung}.
 */
@RestController
@RequestMapping("/api/v1/bezugsgroessen")
public class BezugsgroesseController {

    private final BezugsgroesseService bezugsgroessen;
    private final ObjectMapper streng;

    public BezugsgroesseController(BezugsgroesseService bezugsgroessen, ObjectMapper json) {
        this.bezugsgroessen = bezugsgroessen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /** Recht: {@code messwerte.ansehen} (AP-09 §4.11 „Bezugsgrößen und Werte … ansehen“). Archivierte eingeschlossen. */
    @GetMapping
    public BezugsgroesseDto.Liste alle() {
        return bezugsgroessen.alle();
    }

    /** Recht: {@code messwerte.ansehen}. */
    @GetMapping("/{id}")
    public BezugsgroesseDto.Bezugsgroesse eine(@PathVariable UUID id) {
        return bezugsgroessen.eine(id);
    }

    /**
     * Recht: {@code messwerte.ansehen} („Werte, Herkunft, Fassungen ansehen“). {@code von}/{@code bis}
     * sind Tage (der letzte einschließlich), beide dürfen fehlen; {@code fassungen} ist
     * {@code wirksam} (Vorgabe) oder {@code alle}.
     */
    @GetMapping("/{id}/werte")
    public BezugsgroesseDto.Werte werte(@PathVariable UUID id,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis,
            @RequestParam(required = false) String fassungen) {
        String lesart = fassungen == null || fassungen.isBlank() ? BezugsgroesseRegeln.LESARTEN.get(0) : fassungen.strip();
        if (!BezugsgroesseRegeln.LESARTEN.contains(lesart)) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("feld", "fassungen");
            fakten.put("erlaubt", BezugsgroesseRegeln.LESARTEN);
            throw new BezugsgroesseAbgelehnt(Ablehnung.WORT_UNBEKANNT, fakten);
        }
        return bezugsgroessen.werte(id, tag("von", von), tag("bis", bis), lesart);
    }

    /**
     * Recht: {@code messwerte.ansehen}. Die Intervalle eines Stammdatums (E15, AP-09 IP-6); mit
     * {@code periode_art}, {@code von} und {@code bis} (Tage, der letzte einschließlich) zusätzlich der Wert je
     * Periode am Stichtag = dem letzten Tag der Periode (E17) mit den Übergängen als Kennzeichen (S3).
     */
    @GetMapping("/{id}/stammdatum")
    public BezugsgroesseDto.Stammdatum stammdatum(@PathVariable UUID id,
            @RequestParam(name = "periode_art", required = false) String periodeArt,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis) {
        return bezugsgroessen.stammdatum(id, leer(periodeArt), tag("von", von), tag("bis", bis));
    }

    /**
     * Recht: {@code bezugsgroesse.eingeben} („Bezugsgröße eingeben / berichtigen (manuell)“). Ein Wert eines
     * Stammdatums ab einem Tag (E15/S4) — {@code {"wert": "180", "gueltig_ab": "2026-10-01"}}. Eine Bezugsfläche
     * wird hier nie geschrieben: sie steht in der Ortsstruktur (M4, E17).
     */
    @PutMapping("/{id}/stammdatum")
    public BezugsgroesseDto.Stammdatum stammdatumEintragen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        BezugsgroesseDto.StammdatumAnfrage a = streng(body, BezugsgroesseDto.StammdatumAnfrage.class);
        if (a.wert() == null || a.wert().isBlank()) {
            throw BezugsgroesseAbgelehnt.anfrage("wert");
        }
        if (a.gueltigAb() == null || a.gueltigAb().isBlank()) {
            throw BezugsgroesseAbgelehnt.anfrage("gueltig_ab");
        }
        return bezugsgroessen.stammdatumEintragen(id, a.wert(), tag("gueltig_ab", a.gueltigAb()), akteur(auth));
    }

    /** Recht: {@code bezugsgroesse.verwalten} (AP-09 §4.11, W8). */
    @PostMapping
    public ResponseEntity<BezugsgroesseDto.Bezugsgroesse> anlegen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        BezugsgroesseDto.Bezugsgroesse neu = bezugsgroessen.anlegen(entwurf(body), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/bezugsgroessen/" + neu.id())).body(neu);
    }

    /** Recht: {@code bezugsgroesse.verwalten}. Die ganze Bezugsgröße; nach dem ersten Wert bleibt die Bedeutung fest (M1). */
    @PutMapping("/{id}")
    public BezugsgroesseDto.Bezugsgroesse aendern(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return bezugsgroessen.aendern(id, entwurf(body), akteur(auth));
    }

    /** Recht: {@code bezugsgroesse.verwalten}. Die Werte bleiben lesbar (M6). */
    @PostMapping("/{id}/archivieren")
    public BezugsgroesseDto.Bezugsgroesse archivieren(@PathVariable UUID id, Authentication auth) {
        return bezugsgroessen.archivieren(id, akteur(auth));
    }

    /** Recht: {@code bezugsgroesse.verwalten}. Nur ohne einen einzigen Wert (M6); das Kennzeichen bleibt belegt. */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> loeschen(@PathVariable UUID id, Authentication auth) {
        bezugsgroessen.loeschen(id, akteur(auth));
        return ResponseEntity.noContent().build();
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
            throw BezugsgroesseAbgelehnt.anfrage(feld);
        }
    }

    /** Der strenge Mapper: ein JSON-Objekt, nur bekannte Felder, jedes Text oder {@code null}, die ID eine ID. */
    private BezugsgroesseRegeln.Entwurf entwurf(JsonNode body) {
        BezugsgroesseDto.Anfrage a = streng(body, BezugsgroesseDto.Anfrage.class);
        String geltungId = a.geltungId();
        if (geltungId != null && !geltungId.isBlank()) {
            try {
                geltungId = UUID.fromString(geltungId.strip()).toString();
            } catch (IllegalArgumentException e) {
                throw BezugsgroesseAbgelehnt.anfrage("geltung_id");
            }
        }
        return new BezugsgroesseRegeln.Entwurf(leer(a.kennzeichen()), a.name() == null ? null : a.name().strip(),
                leer(a.wertart()), leer(a.einheit()), leer(a.periodeArt()), leer(a.geltungArt()), geltungId);
    }

    /** Ein JSON-Objekt mit nur bekannten Feldern, jedes Text oder {@code null} — sonst 400 {@code anfrage_ungueltig} mit {@code feld}. */
    private <T> T streng(JsonNode body, Class<T> form) {
        if (body == null || !body.isObject()) {
            throw BezugsgroesseAbgelehnt.anfrage("");
        }
        T a;
        try {
            a = streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw BezugsgroesseAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw BezugsgroesseAbgelehnt.anfrage(e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName());
        } catch (JsonProcessingException e) {
            throw BezugsgroesseAbgelehnt.anfrage("");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = body.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            if (!f.getValue().isTextual() && !f.getValue().isNull()) {
                throw BezugsgroesseAbgelehnt.anfrage(f.getKey());
            }
        }
        return a;
    }

    /** Ein leerer Text ist „nicht angegeben“ — nichts wird sonst umgewandelt (auch nicht die Groß-/Kleinschreibung). */
    private static String leer(String text) {
        return text == null || text.isBlank() ? null : text;
    }

    /** {@code {code, message, …Fakten}} — Code, Status und Satz aus dem geschlossenen Satz des Vertrags. */
    @ExceptionHandler(BezugsgroesseAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BezugsgroesseAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(BezugsgroesseAbgelehnt.anfrage(""));
    }
}
