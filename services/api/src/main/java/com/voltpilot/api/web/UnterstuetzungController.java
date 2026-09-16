package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import com.voltpilot.api.unterstuetzung.UnterstuetzungAbgelehnt;
import com.voltpilot.api.unterstuetzung.UnterstuetzungAbgelehnt.Ablehnung;
import com.voltpilot.api.unterstuetzung.UnterstuetzungRepository;
import com.voltpilot.api.unterstuetzung.UnterstuetzungService;
import com.voltpilot.api.unterstuetzung.UnterstuetzungService.Gewaehrt;
import com.voltpilot.api.unterstuetzung.UnterstuetzungService.Gewaehrung;
import com.voltpilot.api.unterstuetzung.UnterstuetzungService.Sicht;
import com.voltpilot.api.web.dto.UnterstuetzungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
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

/**
 * Die Unterstützung im Kundenbereich (UEMS AP-03 IP-8, Konzept §4.6, E6–E9): gewähren, verlängern, beenden,
 * die Anfragen von VoltPilot entscheiden und das eigene Hinweis-Postfach lesen.
 *
 * <p><b>Was dieser Controller am Zaun ändert:</b> nichts an dem, was ein heutiges Konto sieht — er legt den
 * Zugang an, den es bisher nur von Hand in der Datenbank gab. Seit IP-4 nimmt {@code X-Kundenbereich} einen
 * Partner oder VoltPilot NUR gegen eine WIRKSAME Unterstützung an; bis hierher konnte sie niemand gewähren.
 * Das Gewähren selbst gehört allein dem Kundenadministrator ({@code unterstuetzung.verwalten} = U, E2), und
 * ein Unterstützer gewährt nie eine Unterstützung — die Matrix-Zelle sagt für ihn {@code -}.
 *
 * <p><b>Die Arbeit macht {@link UnterstuetzungService}</b>, die Regeln über Dauer, Standort, Umfang und Grund
 * spricht der Rechte-Vertrag. Jede Ablehnung ist {@code {code, message, …Fakten}} aus dem geschlossenen Satz
 * {@link Ablehnung}; wenn sie fliegt, ist nichts geschrieben.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein unbekanntes Feld (auch camelCase), ein falsch geformtes
 * Datum oder eine Kennung, die keine ist, sind 400 {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1/unterstuetzung")
public class UnterstuetzungController {

    /** Die Kennung, die JEDE Route dieses Controllers verlangt - schreibend wie lesend (Matrix-Zelle U). */
    static final String RECHT = "unterstuetzung.verwalten";

    private final UnterstuetzungService dienst;
    private final RechtPruefung rechte;
    private final ObjectMapper streng;

    public UnterstuetzungController(UnterstuetzungService dienst, RechtPruefung rechte, ObjectMapper json) {
        this.dienst = dienst;
        this.rechte = rechte;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Die Lesewege tragen kein {@code @Recht} - der Interceptor bindet nur Schreibwege (IP-6). Sie pruefen
     * dieselbe Kennung hier: wer eine Unterstuetzung nicht gewaehren darf, liest auch nicht, WER Zugriff auf
     * seinen Kundenbereich hat. Den Banner sieht trotzdem jeder - der steht in der Selbstauskunft (IP-4).
     */
    private void leseRechtPruefen() {
        rechte.pruefen(RECHT, RechtZiel.UNTERNEHMEN, null,
                () -> UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    // ------------------------------------------------------------------ Gewährungen

    /** Recht: {@code unterstuetzung.verwalten} — lesend gilt dieselbe Zeile (nur der Kundenadministrator). */
    @GetMapping
    public List<UnterstuetzungDto.Unterstuetzung> liste() {
        leseRechtPruefen();
        return dienst.liste().stream().map(s -> dto(s, null)).toList();
    }

    /**
     * Recht: {@code unterstuetzung.verwalten} (AP-03 §4.3, E2 — nur der Kundenadministrator).
     *
     * <p>Gewähren (§4.6): bei unbekannter E-Mail entsteht ein Partner-Konto mit Startpasswort, das GENAU
     * EINMAL in dieser Antwort steht (E14). Eine Unterstützung für VoltPilot gibt es nur auf eine Anfrage hin.
     */
    @PostMapping
    @Recht(value = RECHT, ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<UnterstuetzungDto.Unterstuetzung> gewaehren(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        UnterstuetzungDto.Gewaehren g = lies(body, UnterstuetzungDto.Gewaehren.class);
        Gewaehrt gewaehrt = dienst.gewaehren(new Gewaehrung(
                UnterstuetzungService.wort(Art.class, "art", g.art()), g.email(), g.standorte(),
                UnterstuetzungService.wort(Umfang.class, "umfang", g.umfang()),
                g.gueltigAb() == null ? null : g.gueltigAb().toInstant(), g.gueltigBis(), g.grund(), g.anfrageId()),
                akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/unterstuetzung/" + gewaehrt.id()))
                .body(dto(eine(gewaehrt.id()), gewaehrt.startpasswort()));
    }

    /** Recht: {@code unterstuetzung.verwalten} — lesend gilt dieselbe Zeile. */
    @GetMapping("/{id}")
    public UnterstuetzungDto.Unterstuetzung eineUnterstuetzung(@PathVariable UUID id) {
        leseRechtPruefen();
        return dto(eine(id), null);
    }

    /**
     * Recht: {@code unterstuetzung.verwalten}. Verlängern ist ein NEUES Enddatum (§4.6): die laufende
     * Gewährung endet jetzt, eine neue beginnt lückenlos — darum antwortet die Route ihren neuen Griff.
     */
    @PutMapping("/{id}")
    @Recht(value = RECHT, ziel = RechtZiel.UNTERNEHMEN)
    public UnterstuetzungDto.Unterstuetzung verlaengern(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        UnterstuetzungDto.Verlaengern v = lies(body, UnterstuetzungDto.Verlaengern.class);
        return dto(eine(dienst.verlaengern(id, v.gueltigBis(), akteur(auth))), null);
    }

    /** Recht: {@code unterstuetzung.verwalten}. Beenden wirkt SOFORT — mit der nächsten Anfrage (§4.7). */
    @DeleteMapping("/{id}")
    @Recht(value = RECHT, ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Void> beenden(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        String grund = body != null && body.hasNonNull("grund") ? body.get("grund").asText() : null;
        dienst.beenden(id, grund, akteur(auth));
        return ResponseEntity.noContent().build();
    }

    // ------------------------------------------------------------------ Anfragen von VoltPilot

    /** Recht: {@code unterstuetzung.verwalten} — lesend gilt dieselbe Zeile. */
    @GetMapping("/anfragen")
    public List<UnterstuetzungDto.Anfrage> anfragen(@RequestParam(required = false) Boolean offen) {
        leseRechtPruefen();
        return dienst.anfragen(offen == null || offen).stream().map(UnterstuetzungController::dto).toList();
    }

    /**
     * Recht: {@code unterstuetzung.verwalten}. Ablehnen — die Anfrage bleibt sichtbar und gewährt nie etwas.
     * Bestätigt wird sie über {@code POST /api/v1/unterstuetzung} mit {@code anfrage_id} (auch mit geändertem
     * Umfang oder anderer Dauer, §4.6).
     */
    @PostMapping("/anfragen/{id}/ablehnen")
    @Recht(value = RECHT, ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Void> ablehnen(@PathVariable UUID id, Authentication auth) {
        dienst.ablehnen(id, akteur(auth));
        return ResponseEntity.noContent().build();
    }

    // ------------------------------------------------------------------ Hinweise (das Postfach)

    /**
     * Recht: {@code konto.eigenes} — jede Person liest nur ihr eigenes Postfach; die Route nennt kein fremdes
     * Subject, sondern liest das des Aufrufers. Solange kein SMTP steht, ist das der Weg, auf dem der Kunde
     * vom Notfall-Zugriff erfährt (E8).
     */
    @GetMapping("/hinweise")
    public List<UnterstuetzungDto.Hinweis> hinweise(@RequestParam(required = false) Boolean offen,
            Authentication auth) {
        return dienst.hinweise(akteur(auth).sub(), offen == null || offen).stream()
                .map(UnterstuetzungController::dto).toList();
    }

    /** Recht: {@code konto.eigenes} — der Aufrufer schließt nur seine eigenen Hinweise. */
    @PostMapping("/hinweise/{id}/gelesen")
    public ResponseEntity<Void> gelesen(@PathVariable UUID id, Authentication auth) {
        dienst.hinweisGelesen(id, akteur(auth).sub());
        return ResponseEntity.noContent().build();
    }

    // ------------------------------------------------------------------ Abbildung

    static UnterstuetzungDto.Unterstuetzung dto(Sicht s, String startpasswort) {
        return new UnterstuetzungDto.Unterstuetzung(s.id(), s.art().code(),
                s.umfang() == null ? null : s.umfang().code(), s.standorte(), s.kennzeichen(),
                new UnterstuetzungDto.Person(s.unterstuetzer().kennung(), s.unterstuetzer().name()),
                zeit(s.gueltigAb()), s.gueltigBis(), zeit(s.endet()), s.zustand(), s.erinnerung(), s.grund(),
                s.banner(), s.text(), startpasswort);
    }

    static UnterstuetzungDto.Anfrage dto(UnterstuetzungRepository.Anfrage a) {
        return new UnterstuetzungDto.Anfrage(a.id(), a.art().code(), a.umfang().code(), a.standorte(),
                new UnterstuetzungDto.Person(a.angefragtVon(), a.angefragtName()), zeit(a.gueltigAb()),
                a.gueltigBis(), a.grund(), a.zustand(), zeit(a.entschiedenAm()), a.zugriffId(), zeit(a.erzeugtAm()));
    }

    static UnterstuetzungDto.Hinweis dto(UnterstuetzungRepository.Hinweis h) {
        return new UnterstuetzungDto.Hinweis(h.id(), h.anlass().code(), h.text(), h.zugriffId(), h.anfrageId(),
                zeit(h.erzeugtAm()), zeit(h.gelesenAm()), zeit(h.emailVersandtAm()));
    }

    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private Sicht eine(UUID id) {
        return dienst.liste().stream().filter(s -> s.id().equals(id)).findFirst()
                .orElseThrow(() -> UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth)
                .orElseThrow(() -> UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || !body.isObject()) {
            throw UnterstuetzungAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw UnterstuetzungAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw UnterstuetzungAbgelehnt.anfrage(e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName());
        } catch (JsonProcessingException e) {
            throw UnterstuetzungAbgelehnt.anfrage("");
        }
    }

    /** {@code {code, message, …Fakten}} — Code, Status und Satz aus dem geschlossenen Satz. */
    @ExceptionHandler(UnterstuetzungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(UnterstuetzungAbgelehnt e) {
        return ResponseEntity.status(e.status()).body(e.koerper());
    }

    /** Eine Kennung im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(UnterstuetzungAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> keinJson(HttpMessageNotReadableException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(UnterstuetzungAbgelehnt.anfrage("").koerper());
    }
}
