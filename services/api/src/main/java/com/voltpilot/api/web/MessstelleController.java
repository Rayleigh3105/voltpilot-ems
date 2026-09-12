package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.uems.MessstelleQuelleService;
import com.voltpilot.api.uems.MessstelleRegeln;
import com.voltpilot.api.uems.MessstelleRegisterService;
import com.voltpilot.api.uems.MessstelleService;
import com.voltpilot.api.uems.MessstelleZuordnungService;
import com.voltpilot.api.uems.ZaehlerwechselService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleQuelleDto;
import com.voltpilot.api.web.dto.ZaehlerwechselDto;
import java.net.URI;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.List;
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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Messstellen des Kundenbereichs (UEMS AP-04 IP-3, Vertrag
 * {@code docs/contracts/v2/messstelle.md}) und ihre Quellenbindungen (IP-13,
 * {@code …/{id}/quellen}). Die Arbeit machen {@link MessstelleService} und
 * {@link MessstelleQuelleService}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus
 * die Mandanten-RLS wie unter {@code /api/v1/sites/**} — eine fremde Messstelle ist 404, nie
 * 403; der Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}. Jede Route nennt
 * im Kommentar ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}, damit AP-03 sie
 * findet ({@code RechteKennungenDerRoutenTest} hält sie an die Matrix); eine eigene
 * Rechte-Annotation gibt es hier bewusst nicht.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein Feld, das es an der Route nicht gibt, ist 400
 * {@code anfrage_ungueltig} mit {@code feld} — nie still verworfen. Wer an {@code PUT} ein
 * Medium oder eine Hauptgröße schickt, soll nicht glauben, sie sei gespeichert; wer einen Ort
 * mitschickt, ebenso nicht — Ort und Stellung haben ihre eigenen, zeitgültigen Routen (IP-7,
 * {@link MessstelleZuordnungService}).
 */
@RestController
@RequestMapping("/api/v1/messstellen")
public class MessstelleController {

    private static final List<String> NIE_AENDERBAR = List.of("art", "medium", "hauptgroesse");

    private final MessstelleService messstellen;
    private final MessstelleRegisterService register;
    private final MessstelleZuordnungService zuordnungen;
    private final MessstelleQuelleService quellen;
    private final ZaehlerwechselService wechsel;
    private final ObjectMapper streng;

    public MessstelleController(MessstelleService messstellen, MessstelleRegisterService register,
            MessstelleZuordnungService zuordnungen, MessstelleQuelleService quellen,
            ZaehlerwechselService wechsel, ObjectMapper json) {
        this.messstellen = messstellen;
        this.register = register;
        this.zuordnungen = zuordnungen;
        this.quellen = quellen;
        this.wechsel = wechsel;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code messstelle.ansehen} (AP-04 §6.7). Das Register (IP-4): {@code messstellen} trägt
     * weiter die Vertrags-Form jeder Messstelle, {@code register} die Zeile zum {@code stichtag}
     * (Ort mit abgeleitetem Standort, Stellung, Quelle mit „davor“, Zustand). Die Filter gelten für
     * beide Listen; ein Standort, Ort oder eine Anlage, die es im Kundenbereich nicht gibt, findet
     * nichts (leer, nie 403) — {@code teilansicht} bleibt {@code false}, bis AP-03 Rechte durchsetzt.
     * Ein Stichtag ist ein Tag ({@code 2026-11-20}, dann gilt sein Beginn) oder ein Zeitpunkt mit
     * Versatz; fehlend = jetzt.
     */
    @GetMapping
    public MessstelleDto.Liste alle(
            @RequestParam(required = false) String standort,
            @RequestParam(required = false) String ort,
            @RequestParam(required = false) String anlage,
            @RequestParam(required = false) String zustand,
            @RequestParam(required = false) String ohneQuelle,
            @RequestParam(required = false) String stichtag) {
        return register.liste(stichtag(stichtag), new MessstelleRegisterService.Filter(
                leer(standort) ? null : standort.strip(), leer(ort) ? null : ort.strip(),
                anlage(anlage), zustand(zustand), ohneQuelle(ohneQuelle)));
    }

    /** Der Stichtag beider Lese-Routen: ein Tag (dann sein Beginn) oder ein Zeitpunkt; fehlend = jetzt. */
    private static Instant stichtag(String text) {
        try {
            return MessstelleQuelleService.stichtag(text, null);
        } catch (DateTimeParseException e) {
            throw MessstelleAbgelehnt.anfrage("stichtag",
                    "Der Stichtag ist ein Zeitpunkt (2026-11-18T10:40:00+01:00) oder ein Tag (2026-11-18).");
        }
    }

    private static UUID anlage(String text) {
        if (leer(text)) {
            return null;
        }
        try {
            return UUID.fromString(text.strip());
        } catch (IllegalArgumentException e) {
            throw MessstelleAbgelehnt.anfrage("anlage", "Die Anlage ist die ID einer Anlage.");
        }
    }

    private static String zustand(String text) {
        if (leer(text)) {
            return null;
        }
        String wert = text.strip();
        if (!MessstelleRegeln.LEBENSZYKLUS.contains(wert)) {
            throw MessstelleAbgelehnt.anfrage("zustand",
                    "Der Zustand ist einer von " + String.join(", ", MessstelleRegeln.LEBENSZYKLUS) + ".");
        }
        return wert;
    }

    private static boolean ohneQuelle(String text) {
        if (leer(text)) {
            return false;
        }
        String wert = text.strip();
        if (!"true".equals(wert) && !"false".equals(wert)) {
            throw MessstelleAbgelehnt.anfrage("ohneQuelle", "„ohne Quelle“ ist true oder false.");
        }
        return "true".equals(wert);
    }

    private static boolean leer(String text) {
        return text == null || text.isBlank();
    }

    /** Recht: {@code messstelle.bearbeiten} — der Vorschlag gehört zum Anlege-Dialog. */
    @GetMapping("/kennzeichen-vorschlag")
    public MessstelleDto.Vorschlag vorschlag() {
        return messstellen.vorschlag();
    }

    /** Recht: {@code messstelle.ansehen}. */
    @GetMapping("/{id}")
    public MessstelleDto.Messstelle eine(@PathVariable UUID id) {
        return messstellen.eine(id);
    }

    /** Recht: {@code messstelle.bearbeiten}. */
    @PostMapping
    public ResponseEntity<MessstelleDto.Messstelle> anlegen(
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        MessstelleDto.Anlegen anfrage = lies(body, MessstelleDto.Anlegen.class);
        MessstelleDto.Messstelle neu = messstellen.anlegen(anfrage, akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/messstellen/" + neu.id())).body(neu);
    }

    /** Recht: {@code messstelle.bearbeiten}. */
    @PutMapping("/{id}")
    public MessstelleDto.Messstelle bearbeiten(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return messstellen.bearbeiten(id, lies(body, MessstelleDto.Bearbeiten.class), akteur(auth));
    }

    /** Recht: {@code messstelle.bearbeiten}; mit einem Zeitpunkt vor jetzt zusätzlich {@code aenderung.rueckwirkend}. */
    @PostMapping("/{id}/anhalten")
    public MessstelleDto.Messstelle anhalten(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return messstellen.anhalten(id, uebergang(body), akteur(auth));
    }

    /** Recht: {@code messstelle.bearbeiten}; mit einem Zeitpunkt vor jetzt zusätzlich {@code aenderung.rueckwirkend}. */
    @PostMapping("/{id}/fortsetzen")
    public MessstelleDto.Messstelle fortsetzen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return messstellen.fortsetzen(id, uebergang(body), akteur(auth));
    }

    /** Recht: {@code messstelle.bearbeiten}; mit einem Zeitpunkt vor jetzt zusätzlich {@code aenderung.rueckwirkend}. */
    @PostMapping("/{id}/archivieren")
    public MessstelleDto.Messstelle archivieren(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return messstellen.archivieren(id, uebergang(body), akteur(auth));
    }

    // ------------------------------------------------------------ Zuordnungen (IP-7)

    /**
     * Recht: {@code messstelle.bearbeiten} („Ort … zuordnen“); mit „gültig ab“ vor heute
     * zusätzlich {@code aenderung.rueckwirkend}. Antwort: die Messstelle mit ihren Orten.
     */
    @PutMapping("/{id}/ort")
    public MessstelleDto.Messstelle ort(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        zuordnungen.ortZuordnen(id, lies(body, MessstelleDto.OrtAendern.class), akteur(auth));
        return messstellen.eine(id);
    }

    /**
     * Recht: {@code messstelle.bearbeiten}; mit „gültig ab“ vor heute zusätzlich
     * {@code aenderung.rueckwirkend}. Antwort: die Messstelle mit ihrer elektrischen Stellung.
     */
    @PutMapping("/{id}/stellung")
    public MessstelleDto.Messstelle stellung(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        zuordnungen.stellungZuordnen(id, lies(body, MessstelleDto.StellungAendern.class), akteur(auth));
        return messstellen.eine(id);
    }

    /** Recht: {@code messstelle.ansehen}; ein Tag in der Vergangenheit („Stand am“) zusätzlich {@code aenderungsprotokoll.lesen}. */
    @GetMapping("/{id}/standort")
    public MessstelleDto.StandortAm standort(@PathVariable UUID id,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate am) {
        return zuordnungen.standortAm(id, am);
    }

    // ---------------------------------------------------------- Quellenbindung (IP-13)

    /**
     * Recht: {@code messstelle.ansehen}. Je Größe die führende Quelle und die Vergleichsquellen zum
     * {@code stichtag} (Zeitpunkt mit Versatz oder Tag; fehlend = jetzt), der Zeitstrahl der
     * führenden Quellen mit jeder Lücke, dazu die ganze Historie.
     */
    @GetMapping("/{id}/quellen")
    public MessstelleQuelleDto.Liste quellen(@PathVariable UUID id,
            @RequestParam(required = false) String stichtag) {
        return quellen.liste(id, stichtag(stichtag));
    }

    /** Recht: {@code messstelle.ansehen}. */
    @GetMapping("/{id}/quellen/{quelleId}")
    public MessstelleQuelleDto.Quelle quelle(@PathVariable UUID id, @PathVariable UUID quelleId) {
        return quellen.eine(id, quelleId);
    }

    /**
     * Recht: {@code messstelle.quelle}; mit einem „gültig ab“ vor jetzt zusätzlich
     * {@code aenderung.rueckwirkend}. 201 mit {@code Location} der neuen Quelle; die Antwort nennt die
     * laufende Quelle, die die neue beendet hat, und die Rückwirkung.
     */
    @PostMapping("/{id}/quellen")
    public ResponseEntity<MessstelleQuelleDto.Vorgang> binden(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        MessstelleQuelleDto.Vorgang v = quellen.binden(id, lies(body, MessstelleQuelleDto.Binden.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/messstellen/" + id + "/quellen/" + v.quelle().id()))
                .body(v);
    }

    /**
     * Recht: {@code messstelle.quelle} („Führende Quelle binden · Zählerwechsel · Wandlerfaktoren");
     * mit einem Zeitpunkt vor jetzt zusätzlich {@code aenderung.rueckwirkend}. Der Zählerwechsel als
     * EIN Vorgang (IP-17) aus der Sicht der Messstelle: das Gerät ist das, aus dem sie zum
     * Wechselzeitpunkt liest — es wird nachgeschlagen, nie gewählt. Derselbe Vorgang wie
     * {@code POST /api/v1/geraete/{id}/austausch}; entweder alle Wirkungen landen oder keine.
     */
    @PostMapping("/{id}/quellen/wechsel")
    @ResponseStatus(HttpStatus.CREATED)
    public ZaehlerwechselDto.Vorgang wechseln(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return wechsel.anMessstelle(id, lies(body, ZaehlerwechselDto.Wechsel.class), akteur(auth));
    }

    /**
     * Recht: {@code messstelle.quelle}; mit einem Ende vor jetzt zusätzlich {@code aenderung.rueckwirkend}.
     * Ohne Inhalt endet die Quelle jetzt. Eine Quelle wird nie gelöscht — sie endet.
     */
    @PutMapping("/{id}/quellen/{quelleId}/beenden")
    public MessstelleQuelleDto.Vorgang beenden(@PathVariable UUID id, @PathVariable UUID quelleId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        MessstelleQuelleDto.Beenden b = body == null || body.isNull() ? null
                : lies(body, MessstelleQuelleDto.Beenden.class);
        return quellen.beenden(id, quelleId, b, akteur(auth));
    }

    // ---------------------------------------------------------------- Gerüst

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** Anhalten, Fortsetzen und Archivieren gehen auch ohne Inhalt: dann gilt jetzt. */
    private MessstelleDto.Uebergang uebergang(JsonNode body) {
        return body == null || body.isNull() ? null : lies(body, MessstelleDto.Uebergang.class);
    }

    private <T> T lies(JsonNode body, Class<T> typ) {
        if (body == null || !body.isObject()) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        try {
            return streng.treeToValue(body, typ);
        } catch (UnrecognizedPropertyException e) {
            String feld = pfad(e);
            throw MessstelleAbgelehnt.anfrage(feld, typ == MessstelleDto.Bearbeiten.class
                    && NIE_AENDERBAR.contains(feld)
                    ? "Art, Medium und Hauptgröße sind nie änderbar — eine andere Größe ist eine andere Messstelle."
                    : "„" + feld + "“ gibt es hier nicht.");
        } catch (JsonMappingException e) {
            String feld = pfad(e);
            throw MessstelleAbgelehnt.anfrage(feld, "„" + feld + "“ hat nicht die erwartete Form.");
        } catch (JsonProcessingException e) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
    }

    /** {@code hauptgroesse.einheit}, {@code nebengroessen[1].wertart} — der Weg zum Feld. */
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
    @ExceptionHandler(MessstelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MessstelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** {@code ?am=} kein Tag (JJJJ-MM-TT): dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keinTag(MethodArgumentTypeMismatchException e) {
        return abgelehnt(MessstelleAbgelehnt.anfrage(e.getName(), "„" + e.getName() + "“ ist ein Tag (JJJJ-MM-TT)."));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt."));
    }

    /** 403/404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
