package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.GrenzNachweisService;
import com.voltpilot.api.uems.NetzanschlussAbgelehnt;
import com.voltpilot.api.uems.NetzanschlussAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.NetzanschlussGrenzeService;
import com.voltpilot.api.uems.NetzanschlussService;
import com.voltpilot.api.uems.NetzanschlussVorschlagService;
import java.util.List;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.NetzanschlussDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
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
 * Die Netzanschlüsse eines Standorts und ihre Bindung an Anlagen (UEMS AP-10 IP-6, Konzept §4.2, §5.1,
 * Entscheid E8 = A): anlegen, lesen, bearbeiten, eine Anlage ab einem Tag binden — nie löschen (es gibt
 * keine DELETE-Route; ein Anschluss wird beendet, eine Bindung endet am Vortag der nächsten). Die Arbeit
 * macht {@link NetzanschlussService}, die Regeln {@code NetzanschlussRegeln}, die Grenzen hält die
 * Datenbank ({@code V20260913235000}).
 *
 * <p><b>Rechte:</b> es gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS — ein fremder Standort oder ein Anschluss eines anderen Standorts ist 404
 * {@code nicht_gefunden}, nie 403. Jede Route nennt im Kommentar ihre Kennung aus
 * {@code docs/contracts/v2/rechte-matrix.json} ({@code RechteKennungenDerRoutenTest} hält sie an die
 * Matrix); seit AP-03 IP-6 setzt {@code @Recht} sie vor dem Handler durch
 * (403 {@code recht_fehlt}, außerhalb des Geltungsbereichs 404).
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein unbekanntes Feld (auch camelCase), ein Feld, das kein Text
 * ist (die Leistungen: Zahl oder Dezimaltext), ein Tag oder eine ID in falscher Form sind 400
 * {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1/standorte/{standortId}/netzanschluesse")
public class NetzanschlussController {

    /** Die Felder, die als Zahl ODER als Dezimaltext kommen dürfen. */
    private static final Set<String> ZAHLEN = Set.of("anschluss_kva", "vereinbart_kw", "einspeisegrenze_kw",
            "bezugsgrenze_kw");

    private final NetzanschlussService dienst;
    private final ObjectMapper streng;
    private final NetzanschlussVorschlagService vorschlaege;
    private final NetzanschlussGrenzeService grenzen;
    private final RechtPruefung rechte;
    private final GrenzNachweisService nachweise;

    public NetzanschlussController(NetzanschlussService dienst, ObjectMapper json, NetzanschlussVorschlagService vorschlaege,
            NetzanschlussGrenzeService grenzen, RechtPruefung rechte, GrenzNachweisService nachweise) {
        this.dienst = dienst;
        this.vorschlaege = vorschlaege;
        this.grenzen = grenzen;
        this.rechte = rechte;
        this.nachweise = nachweise;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: heute lesend — keine eigene Kennung (wie das Standort-Lesemodell). Ohne Stichtag alle, beendete
     * eingeschlossen. Der Standort-Zaun hält den Standort (RLS); eine gebundene Anlage außerhalb des Zugriffs fehlt
     * ({@code RechtPruefung#lesbar}).
     */
    @GetMapping
    public NetzanschlussDto.Netzanschluesse liste(@PathVariable UUID standortId,
            @RequestParam(required = false) String stichtag) {
        return dienst.liste(standortId, tag("stichtag", stichtag), anlage -> rechte.lesbar(RechtZiel.ANLAGE, anlage));
    }

    /** Recht: {@code netzanschluss.verwalten} (AP-10 §4.10, E15). Ohne Kennzeichen vergibt die Regel das nächste. */
    @PostMapping
    @Recht(value = "netzanschluss.verwalten", ziel = RechtZiel.STANDORT)
    public ResponseEntity<NetzanschlussDto.Netzanschluss> anlegen(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UUID id = dienst.anlegen(standortId, lies(body, NetzanschlussDto.Anschluss.class), akteur(auth));
        return ResponseEntity.created(URI.create(pfad(standortId, id))).body(dienst.netzanschluss(standortId, id));
    }

    /**
     * Recht: heute lesend — keine eigene Kennung (wie das Standort-Lesemodell). Zaun wie die Liste: Standort über RLS,
     * eine gebundene Anlage außerhalb des Zugriffs fehlt.
     */
    @GetMapping("/{id}")
    public NetzanschlussDto.Netzanschluss netzanschluss(@PathVariable UUID standortId, @PathVariable UUID id) {
        return dienst.netzanschluss(standortId, id, anlage -> rechte.lesbar(RechtZiel.ANLAGE, anlage));
    }

    /** Recht: {@code netzanschluss.verwalten}. Die ganze Menge; ein Ende wird nur vorgezogen. */
    @PutMapping("/{id}")
    @Recht(value = "netzanschluss.verwalten", ziel = RechtZiel.STANDORT)
    public NetzanschlussDto.Netzanschluss bearbeiten(@PathVariable UUID standortId, @PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.bearbeiten(standortId, id, lies(body, NetzanschlussDto.Anschluss.class), akteur(auth));
        return dienst.netzanschluss(standortId, id);
    }

    /**
     * Recht: {@code netzanschluss.verwalten}; mit „gültig ab“ vor heute zusätzlich {@code aenderung.rueckwirkend}.
     * Ab dem Tag hängt die Anlage an diesem Anschluss — eine laufende Bindung endet am Vortag.
     */
    @PostMapping("/{id}/anlagen")
    @Recht(value = "netzanschluss.verwalten", ziel = RechtZiel.STANDORT)
    public ResponseEntity<NetzanschlussDto.Netzanschluss> binden(@PathVariable UUID standortId, @PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        dienst.binden(standortId, id, lies(body, NetzanschlussDto.Binden.class), akteur(auth));
        return ResponseEntity.created(URI.create(pfad(standortId, id))).body(dienst.netzanschluss(standortId, id));
    }

    /** Recht: {@code netzanschluss.verwalten}; liest nur, reserviert kein Kennzeichen. */
    @GetMapping("/vorschlaege")
    public List<NetzanschlussDto.Vorschlag> vorschlaege(@PathVariable UUID standortId) {
        return vorschlaege.liste(standortId);
    }

    /** Recht: {@code netzanschluss.verwalten}; rückwirkend zusätzlich {@code aenderung.rueckwirkend}. */
    @PostMapping("/vorschlaege/{anlageId}/uebernehmen")
    @Recht(value = "netzanschluss.verwalten", ziel = RechtZiel.STANDORT)
    public ResponseEntity<NetzanschlussDto.Netzanschluss> uebernehmen(@PathVariable UUID standortId,
            @PathVariable UUID anlageId, @RequestBody(required = false) JsonNode body, Authentication auth) {
        var n = vorschlaege.uebernehmen(standortId, anlageId, lies(body, NetzanschlussDto.Uebernehmen.class), akteur(auth));
        return ResponseEntity.created(URI.create(pfad(standortId, n.id()))).body(n);
    }

    /** Recht: {@code netzanschluss.verwalten}; Entscheidung merken, ohne einen Anschluss anzulegen. */
    @PostMapping("/vorschlaege/{anlageId}/verwerfen")
    @Recht(value = "netzanschluss.verwalten", ziel = RechtZiel.STANDORT)
    public ResponseEntity<Void> verwerfen(@PathVariable UUID standortId, @PathVariable UUID anlageId, Authentication auth) {
        vorschlaege.verwerfen(standortId, anlageId, akteur(auth));
        return ResponseEntity.noContent().build();
    }

    /**
     * Recht: heute lesend — keine eigene Kennung (wie der Anschluss selbst); der Zaun fragt
     * {@code RechtPruefung#pruefenLesen} am Standort — außerhalb dieselbe Antwort wie ein unbekannter (404).
     * Das Grenzblatt (UEMS AP-15 IP-3): alle wirksamen Fassungen und die am Stichtag (ohne: heute) gültige.
     */
    @GetMapping("/{id}/grenzen")
    public NetzanschlussDto.Grenzblatt grenzblatt(@PathVariable UUID standortId, @PathVariable UUID id,
            @RequestParam(required = false) String stichtag) {
        rechte.pruefenLesen(RechtZiel.STANDORT, standortId, () -> NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        return grenzen.grenzblatt(standortId, id, tag("stichtag", stichtag));
    }

    /**
     * Recht: heute lesend — keine eigene Kennung (wie der Anschluss selbst); der Zaun fragt
     * {@code RechtPruefung#pruefenLesen} am Standort — außerhalb dieselbe Antwort wie ein unbekannter (404); ein
     * Hauptzähler außerhalb des Zugriffs nimmt seiner Richtung die Zahlen ({@code RechtPruefung#alleLesbar}).
     * Der Grenz-Nachweis (UEMS AP-15 IP-31): gerechnet über die abgeschlossenen Tage des Monats (ohne: der laufende).
     */
    @GetMapping("/{id}/grenznachweis")
    public NetzanschlussDto.GrenzNachweis grenznachweis(@PathVariable UUID standortId, @PathVariable UUID id,
            @RequestParam(required = false) String monat, @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis) {
        rechte.pruefenLesen(RechtZiel.STANDORT, standortId, () -> NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        return nachweise.nachweis(standortId, id, monat, von, bis,
                ms -> rechte.alleLesbar(RechtZiel.MESSSTELLE, ms));
    }

    /**
     * Recht: {@code netzanschluss.verwalten}; mit „gültig ab“ vor heute zusätzlich {@code aenderung.rueckwirkend}.
     * Ab dem Tag gilt diese Fassung des Grenzblatts (UEMS AP-15 IP-3) — Plausibilität gegen vereinbarte Leistung und
     * Anschlussleistung (422). Der Mandant kommt aus der Anmeldung, nie aus dem Körper.
     */
    @PostMapping("/{id}/grenzen")
    @Recht(value = "netzanschluss.verwalten", ziel = RechtZiel.STANDORT)
    public ResponseEntity<NetzanschlussDto.Grenzblatt> grenzeSetzen(@PathVariable UUID standortId, @PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        NetzanschlussDto.GrenzeSetzen g = lies(body, NetzanschlussDto.GrenzeSetzen.class);
        rechte.rueckwirkend(tag("gueltig_ab", g.gueltigAb()));
        grenzen.setzen(standortId, id, g, akteur(auth));
        return ResponseEntity.created(URI.create(pfad(standortId, id) + "/grenzen"))
                .body(grenzen.grenzblatt(standortId, id, null));
    }

    // ----------------------------------------------------------------------------- Gerüst

    private static String pfad(UUID standortId, UUID id) {
        return "/api/v1/standorte/" + standortId + "/netzanschluesse/" + id;
    }

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
            throw NetzanschlussAbgelehnt.anfrage(feld);
        }
    }

    /** Der strenge Mapper: ein JSON-Objekt, nur bekannte Felder, Text oder {@code null}, Leistungen auch Zahl; das ausdrückliche Kennzeichen nur Boolean. */
    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || !body.isObject()) {
            throw NetzanschlussAbgelehnt.anfrage("");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = body.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            JsonNode wert = f.getValue();
            if ("einspeisegrenze_keine".equals(f.getKey())) {
                if (!wert.isBoolean()) {
                    throw NetzanschlussAbgelehnt.anfrage(f.getKey());
                }
                continue;
            }
            boolean zahl = ZAHLEN.contains(f.getKey()) && wert.isNumber();
            if (!zahl && !wert.isTextual() && !wert.isNull()) {
                throw NetzanschlussAbgelehnt.anfrage(f.getKey());
            }
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw NetzanschlussAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw NetzanschlussAbgelehnt.anfrage(e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName());
        } catch (JsonProcessingException e) {
            throw NetzanschlussAbgelehnt.anfrage("");
        }
    }

    /** {@code {code, message, …Fakten}} — Code, Status und Satz aus dem geschlossenen Satz. */
    @ExceptionHandler(NetzanschlussAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(NetzanschlussAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(NetzanschlussAbgelehnt.anfrage(""));
    }
}
