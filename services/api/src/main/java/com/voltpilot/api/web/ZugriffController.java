package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import com.voltpilot.api.zugriff.ZugriffAenderung;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.net.URI;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Zuweisungen eines Kundenbereichs (UEMS AP-03 IP-9, §4.7, §5.2, A6/A8) — zuweisen, entziehen, lesen.
 *
 * <p><b>Was dieser Controller am Zaun ändert:</b> er macht den ENTZUG erreichbar, den es bisher nur für die
 * Unterstützung gab (IP-8). Er gewährt nichts, was nicht schon gewährt werden konnte: die Rollen und ihre
 * Rechte stehen seit IP-1 in der Matrix und werden seit IP-6/IP-7 durchgesetzt; hier entsteht der Weg, sie
 * einer Person zu geben und wieder zu nehmen. Das Recht ist {@code zuweisung.verwalten} (Matrix-Zelle U = nur
 * Kundenadministrator, E2); ein Konto anzulegen gehört NICHT dazu (das ist {@code benutzer.verwalten},
 * IP-13/IP-14) — diese Routen arbeiten mit Konten, die es im Kundenbereich schon gibt.
 *
 * <p><b>Zwei Regeln lehnen mit 409 ab</b>, und zwar im Dienst, nicht hier: die eigene Zuweisung ist
 * unveränderlich ({@code eigene_zuweisung}) und der letzte Kundenadministrator ist geschützt
 * ({@code letzter_kundenadministrator}). Beides entscheidet der Rechte-Vertrag; der EINE Prüfpunkt ist
 * {@link ZugriffAenderung}.
 *
 * <p><b>Der Entzug wirkt mit der nächsten Anfrage des Betroffenen</b> (§4.7): sie bekommt 404/403
 * {@code zugriff_beendet}. Gesetzte Handeingriffe bleiben (E15) — ein Entzug ist keine Steuerung.
 */
@RestController
@RequestMapping("/api/v1/zugriff")
public class ZugriffController {

    /** Die Kennung, die jede Route dieses Controllers verlangt — schreibend wie lesend (Matrix-Zelle U). */
    static final String RECHT = "zuweisung.verwalten";

    /** Eine Zuweisung, wie das Portal sie liest — die Namen von {@code docs/contracts/openapi.yaml}. */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record ZugriffDto(UUID id, String benutzerSub, String benutzerName, String rolle, UUID standortId,
            String standortKurzzeichen, String standortName, String gueltigAb, String beendetAm) {}

    private final ZugriffAenderung aenderung;
    private final ZugriffRepository zugriffe;
    private final com.voltpilot.api.zugriff.RechtPruefung rechte;

    public ZugriffController(ZugriffAenderung aenderung, ZugriffRepository zugriffe,
            com.voltpilot.api.zugriff.RechtPruefung rechte) {
        this.aenderung = aenderung;
        this.zugriffe = zugriffe;
        this.rechte = rechte;
    }

    /**
     * Recht: {@code zuweisung.verwalten} — lesend gilt dieselbe Zeile (der Interceptor bindet nur Schreibwege,
     * darum fragt die Route im Rumpf).
     */
    @GetMapping
    public List<ZugriffDto> liste(@RequestParam(required = false) String benutzer) {
        rechte.pruefen(RECHT, RechtZiel.UNTERNEHMEN, null, null);
        if (benutzer == null || benutzer.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "benutzer fehlt.");
        }
        return zugriffe.zuweisungen(benutzer).stream().map(ZugriffController::dto).toList();
    }

    /** Recht: {@code zuweisung.verwalten}. Eine neue Zuweisung gilt ab jetzt; nie die eigene (409). */
    @PostMapping
    @Recht(value = RECHT, ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<ZugriffDto> zuweisen(@RequestBody(required = false) JsonNode body, Authentication auth) {
        if (body == null || !body.hasNonNull("benutzer_sub") || !body.hasNonNull("rolle")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "benutzer_sub und rolle sind Pflicht.");
        }
        Rolle rolle;
        try {
            rolle = Rolle.vonCode(body.get("rolle").asText());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Rolle unbekannt.");
        }
        UUID standort = body.hasNonNull("standort_id") ? uuid(body.get("standort_id").asText()) : null;
        String grund = body.hasNonNull("grund") ? body.get("grund").asText() : null;
        UUID id = aenderung.zuweisen(body.get("benutzer_sub").asText(), rolle, standort, grund, akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/zugriff/" + id))
                .body(zugriffe.zeile(id).map(ZugriffController::dto).orElseThrow());
    }

    /**
     * Recht: {@code zuweisung.verwalten}. Der Entzug wirkt SOFORT — mit der nächsten Anfrage des Betroffenen
     * (§4.7). Der letzte Kundenadministrator ist geschützt (409), die eigene Zuweisung unveränderlich (409).
     */
    @DeleteMapping("/{id}")
    @Recht(value = RECHT, ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Void> entziehen(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        String grund = body != null && body.hasNonNull("grund") ? body.get("grund").asText() : null;
        aenderung.entziehen(id, grund, akteur(auth));
        return ResponseEntity.noContent().build();
    }

    private static ZugriffDto dto(ZugriffRepository.Zeile z) {
        return new ZugriffDto(z.id(), z.benutzerSub(), null, z.rolle().code(), z.standortId(),
                z.standortKurzzeichen(), z.standortName(), z.gueltigAb().toString(),
                z.beendetAm() == null ? null : z.beendetAm().toString());
    }

    private static UUID uuid(String wert) {
        try {
            return UUID.fromString(wert);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "standort_id ist keine Kennung.");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Nicht angemeldet."));
    }
}
