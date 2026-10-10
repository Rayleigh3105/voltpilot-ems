package com.voltpilot.api.web;

import com.voltpilot.api.optimizer.WhatIfClient;
import com.voltpilot.api.repo.OptimizerDiagnosticsRepository;
import com.voltpilot.api.repo.OptimizerDiagnosticsRepository.SiteContext;
import com.voltpilot.api.vorschau.Vorschau;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die KUNDEN-VORSCHAU (Steuerung Stufe 7, Konzept `vp-steuerung-konzept-b3`
 * §3.5 + §3.8 G1): „was ändert diese Entscheidung an meinem Fahrplan?" - in
 * Euro, VOR dem Klick.
 *
 * <p>Sie ist die Kunden-Tür zu derselben Rechen-Maschine, die der Admin-Panel
 * seit dem Optimizer-Umbau benutzt ({@code POST /admin/sites/{id}/
 * optimizer-what-if}). <b>Es entsteht keine zweite Vorschau-Logik</b> - das
 * wäre eine zweite Wahrheit über dieselbe Zahl; es entsteht eine zweite,
 * SCHMALERE Tür.
 *
 * <p><b>Was diese Tür anders macht als die Admin-Tür - jedes einzeln
 * begründet:</b>
 *
 * <ul>
 *   <li><b>Der Zaun.</b> Mandantenbezogen wie jede {@code /api/v1/sites/**}-
 *       Route: KEIN {@code @PreAuthorize}, Authentifizierung + RLS sind der
 *       Zaun, eine fremde Anlage ist <b>404, nie 403</b>. Das ist
 *       SICHERHEITS-RELEVANT: der Rechendienst löst Anlagen mit den
 *       vertrauenswürdigen Zugangsdaten auf und kennt keinen Mandanten - die
 *       Id darf ihn also erst erreichen, nachdem sie durch den RLS-Pfad
 *       nachgewiesen wurde.</li>
 *   <li><b>Die Knöpfe.</b> Nur die drei, die ein Kunde wirklich treffen kann
 *       ({@link Vorschau#knoepfe}). Verschleisskosten, SoC-Band und die
 *       Netzlade-Haltung sind nicht Teil des Rumpfs - eine Vorschau darf keine
 *       Tür zu Einstellungen sein, die anderswo geschützt sind.</li>
 *   <li><b>Der Deckel.</b> Eine Vorschau ist ein echter MILP-Lauf. Der
 *       {@link VorschauRateLimiter} antwortet mit einem deutschen Satz,
 *       BEVOR der Rechendienst überhaupt gefragt wird; sein Semaphor bleibt
 *       die harte Grenze dahinter.</li>
 *   <li><b>Die Antwort.</b> EINE Zahl plus ihre Ehrlichkeit
 *       ({@link Vorschau#ausAntwort}) statt zweier voller Pläne - die
 *       Folgen-Karte braucht nicht mehr, und die Slot-Reihen des Admin-Blicks
 *       gehören nicht auf eine Kundenfläche.</li>
 * </ul>
 *
 * <p><b>Es wird NICHTS festgeschrieben.</b> Die Ephemeralität ist eine
 * Eigenschaft des Python-Moduls (es importiert weder Persistenz noch einen der
 * Publisher, per Import-Graph-Test festgenagelt) - keine Route auf dieser
 * Seite kann sie unterlaufen.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteVorschauController {

    /**
     * Die Entscheidung, die vorgerechnet werden soll.
     *
     * <p>Jedes Feld ist OPTIONAL und {@code null} heisst „lass es, wie die
     * Anlage es hat" - deshalb ist ein LEERER Rumpf eine sinnvolle Anfrage:
     * er rechnet die Anlage zweimal gleich und liefert eine Differenz von
     * null, also die ehrliche Aussage „das ändert nichts".
     */
    public record VorschauRequest(
            Boolean socFloorNow,
            @Min(1) @Max(192) Integer forcedChargeSlots,
            @Min(0) @Max(191) Integer verbraucherAbSlot,
            @Min(1) @Max(192) Integer verbraucherSlots,
            @DecimalMin("0.1") BigDecimal verbraucherKw) {}

    /** Die Vorschau, wie die Folgen-Karte sie liest. */
    public record VorschauDto(BigDecimal deltaEur, BigDecimal basisEur, BigDecimal varianteEur,
            Integer horizonSlots, boolean naeherung, String grund) {}

    static final String ZU_VIELE =
            "Sie haben gerade viele Vorschauen angefordert - bitte einen Moment warten. "
                    + "Ihre Anlage und Ihr Fahrplan sind davon nicht betroffen.";

    private final OptimizerDiagnosticsRepository sites;
    private final WhatIfClient whatIf;
    private final VorschauRateLimiter limiter;

    public SiteVorschauController(OptimizerDiagnosticsRepository sites, WhatIfClient whatIf,
            VorschauRateLimiter limiter) {
        this.sites = sites;
        this.whatIf = whatIf;
        this.limiter = limiter;
    }

    /**
     * Zwei Läufe über EINE Eingabe: die Anlage wie sie ist, und die Anlage
     * unter dieser Entscheidung. Die Differenz ist die Zahl der Folgen-Karte.
     *
     * <p><b>Die Reihenfolge ist tragend:</b> erst der Mandanten-Zaun, dann der
     * Speicher-Nachweis, dann der Deckel - und erst danach der teure Lauf. Ein
     * Aufruf, der ohnehin abgelehnt wird, darf keine Rechenzeit kosten und
     * keinen Platz im Fenster des Deckels verbrauchen.
     */
    @PostMapping("/steuerung-vorschau")
    @Recht(value = "messwerte.ansehen", ziel = RechtZiel.ANLAGE)
    public VorschauDto vorschau(@PathVariable UUID siteId,
            @Valid @RequestBody(required = false) VorschauRequest request,
            HttpServletRequest http) {
        SiteContext site = requireSite(siteId);
        if (!site.hasBattery()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat keinen Speicher - für sie rechnet VoltPilot keinen "
                            + "Fahrplan, den eine Entscheidung ändern könnte.");
        }
        VorschauRequest r = request != null
                ? request : new VorschauRequest(null, null, null, null, null);
        requireVollstaendigesFenster(r);
        if (!limiter.tryAcquire(limiter.clientKey(http))) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, ZU_VIELE);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("siteId", siteId.toString());
        payload.put("overrides", Vorschau.knoepfe(r.socFloorNow(), r.forcedChargeSlots(),
                r.verbraucherAbSlot(), r.verbraucherSlots(), r.verbraucherKw()));
        Vorschau.Ergebnis e = Vorschau.ausAntwort(whatIf.reoptimize(payload));
        return new VorschauDto(e.deltaEur(), e.basisEur(), e.varianteEur(), e.horizonSlots(),
                e.naeherung(), e.grund());
    }

    /**
     * ⚠ Ein HALB gefülltes Verbraucher-Fenster wird ABGELEHNT, nie ergänzt:
     * eine geratene Startzeit oder Leistung wäre eine Aussage über eine
     * Kundenanlage, die niemand getroffen hat. (Der Rechendienst prüft es ein
     * zweites Mal - hier fällt es nur auf, bevor der Lauf Geld kostet.)
     */
    private static void requireVollstaendigesFenster(VorschauRequest r) {
        boolean irgendwas = r.verbraucherAbSlot() != null || r.verbraucherSlots() != null
                || r.verbraucherKw() != null;
        boolean alles = r.verbraucherAbSlot() != null && r.verbraucherSlots() != null
                && r.verbraucherKw() != null;
        if (irgendwas && !alles) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Für ein Verbraucher-Fenster gehören Beginn, Länge und Leistung zusammen.");
        }
    }

    /**
     * ⚠ Der Zaun UND die Stammdaten in EINER Abfrage - sie ist RLS-gefenced,
     * eine fremde Anlage ist also schlicht unsichtbar (404), und die Id
     * erreicht den Rechendienst erst danach.
     */
    private SiteContext requireSite(UUID siteId) {
        SiteContext site = sites.siteContext(siteId);
        if (site == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return site;
    }

    /** Deutsche Gründe erreichen das Portal als {"message": …}. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
