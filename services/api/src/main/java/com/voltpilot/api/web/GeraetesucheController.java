package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.geraetesuche.GeraetesucheAbgelehnt;
import com.voltpilot.api.geraetesuche.GeraetesucheDienst;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.GeraetesucheDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.Duration;
import java.time.Instant;
import java.util.Iterator;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Gerätesuche (OpenAPI-Tag {@code geraetesuche}; Vertrag {@code docs/contracts/v2/mqtt-geraetesuche.md}): „Geräte
 * suchen“ startet auf der Box einen lesenden Suchlauf im Heimnetz, die Routen zeigen ihn, brechen ihn ab und listen
 * den Verlauf.
 *
 * <p>Alle vier tragen das Recht {@code geraet.einrichten} an der Anlage (DP-4 A) - die zwei schreibenden über
 * {@link Recht}, die zwei lesenden im Handler über {@link RechtPruefung#pruefen} (an Leserouten steht kein
 * {@code @Recht}). Der Mandant kommt aus dem Token bzw. dem Mandantensprung, nie aus dem Körper; eine fremde Anlage,
 * eine Box an einer anderen Anlage und eine unbekannte Suche sind dieselbe 404. Im Mandantensprung handelt die
 * Plattform als Kundenadministrator; protokolliert wird die eigene Person ({@link ProtokollAkteur}).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/geraetesuche")
public class GeraetesucheController {

    /** Die Route der Anfrage-Kennung ({@code anfrage_kennung.route}). */
    static final String ROUTE_STARTEN = "POST /api/v1/sites/{siteId}/geraetesuche";
    private static final String RECHT = "geraet.einrichten";
    private static final Pattern UUID_FORM =
            Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

    private final GeraetesucheDienst dienst;
    private final AnfrageKennungen anfrageKennungen;
    private final RechtPruefung rechte;

    public GeraetesucheController(GeraetesucheDienst dienst, AnfrageKennungen anfrageKennungen,
            RechtPruefung rechte) {
        this.dienst = dienst;
        this.anfrageKennungen = anfrageKennungen;
        this.rechte = rechte;
    }

    /** Der Fingerabdruck der Anfrage-Kennung: Anlage und Box, in fester Form. */
    private record Anfrage(UUID siteId, UUID deviceId) {
    }

    // Recht: `geraet.einrichten` an der Anlage (DP-4 A).
    @PostMapping
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    @Transactional
    public ResponseEntity<?> starten(@PathVariable UUID siteId,
            @RequestHeader(value = AnfrageKennungen.KOPF, required = false) String anfrageKopf,
            @RequestBody(required = false) JsonNode koerper, Authentication auth) {
        UUID deviceId = deviceId(koerper);
        String kennung = AnfrageKennungen.kennung(anfrageKopf);
        String fingerabdruck = kennung == null ? null : anfrageKennungen.fingerabdruck(new Anfrage(siteId, deviceId));
        if (kennung != null) {
            anfrageKennungen.sperren(ROUTE_STARTEN, kennung);
            Optional<AnfrageKennungen.Gemerkt> gemerkt = anfrageKennungen.gemerkt(ROUTE_STARTEN, kennung,
                    fingerabdruck);
            if (gemerkt.isPresent()) {
                return AnfrageKennungen.antwort(gemerkt.get());
            }
        }
        GeraetesucheDto.Suche suche = dienst.starten(siteId, deviceId, akteur(auth), s -> {
            if (kennung != null) {
                anfrageKennungen.merken(ROUTE_STARTEN, kennung, fingerabdruck, HttpStatus.ACCEPTED, s);
            }
        });
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(suche);
    }

    // Recht: `geraet.einrichten` an der Anlage (DP-4 A), im Handler geprüft.
    @GetMapping
    public GeraetesucheDto.Verlauf verlauf(@PathVariable UUID siteId,
            @RequestParam(required = false) UUID deviceId) {
        rechte.pruefen(RECHT, RechtZiel.ANLAGE, siteId, GeraetesucheAbgelehnt::nichtGefunden);
        return dienst.verlauf(siteId, deviceId);
    }

    // Recht: `geraet.einrichten` an der Anlage (DP-4 A), im Handler geprüft.
    @GetMapping("/{suchId}")
    public GeraetesucheDto.Suche eine(@PathVariable UUID siteId, @PathVariable UUID suchId) {
        rechte.pruefen(RECHT, RechtZiel.ANLAGE, siteId, GeraetesucheAbgelehnt::nichtGefunden);
        return dienst.eine(siteId, suchId);
    }

    // Recht: `geraet.einrichten` an der Anlage (DP-4 A).
    @DeleteMapping("/{suchId}")
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    @ResponseStatus(HttpStatus.ACCEPTED)
    public GeraetesucheDto.Suche abbrechen(@PathVariable UUID siteId, @PathVariable UUID suchId,
            Authentication auth) {
        return dienst.abbrechen(siteId, suchId, akteur(auth));
    }

    /**
     * Der Körper nennt genau die Box ({@code {"deviceId": …}}); jedes andere Feld - auch ein Mandant, eine Anlage, ein
     * Netz oder ein Port - ist 400 {@code anfrage_ungueltig}: die Cloud nennt der Box keine Netze (DP-5 A).
     */
    static UUID deviceId(JsonNode koerper) {
        if (koerper == null || !koerper.isObject()) {
            throw GeraetesucheAbgelehnt.anfrageUngueltig("Die Anfrage nennt die Box als deviceId.");
        }
        for (Iterator<String> it = koerper.fieldNames(); it.hasNext();) {
            String feld = it.next();
            if (!"deviceId".equals(feld)) {
                throw GeraetesucheAbgelehnt.anfrageUngueltig("Die Anfrage nennt nur die Box (deviceId), nicht "
                        + feld + ".");
            }
        }
        JsonNode d = koerper.path("deviceId");
        if (!d.isTextual() || !UUID_FORM.matcher(d.asText()).matches()) {
            throw GeraetesucheAbgelehnt.anfrageUngueltig("Die Anfrage nennt die Box als deviceId.");
        }
        return UUID.fromString(d.asText());
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
    }

    @ExceptionHandler(GeraetesucheAbgelehnt.class)
    public ResponseEntity<GeraetesucheDto.Fehler> abgelehnt(GeraetesucheAbgelehnt e) {
        ResponseEntity.BodyBuilder antwort = ResponseEntity.status(e.status());
        if (e.wiederAb() != null) {
            long sekunden = Math.max(1, Duration.between(Instant.now(), e.wiederAb()).toSeconds() + 1);
            antwort.header(HttpHeaders.RETRY_AFTER, Long.toString(sekunden));
        }
        return antwort.body(new GeraetesucheDto.Fehler(e.code(), e.getMessage(), e.suchId(), e.zuletztGesehen(),
                e.wiederAb()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<GeraetesucheDto.Fehler> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(GeraetesucheAbgelehnt.anfrageUngueltig("Die Anfrage nennt die Box als deviceId."));
    }
}
