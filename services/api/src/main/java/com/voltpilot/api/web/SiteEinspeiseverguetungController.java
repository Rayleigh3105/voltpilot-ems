package com.voltpilot.api.web;

import com.voltpilot.api.optimizer.EegRates;
import com.voltpilot.api.optimizer.EinspeiseverguetungStand;
import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.repo.EinspeiseverguetungRepository;
import com.voltpilot.api.repo.EinspeiseverguetungRepository.Grundlage;
import com.voltpilot.api.web.dto.EinspeiseverguetungDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Karte "Einspeisevergütung" einer Anlage (Einstellungen › Strom &amp; Geld):
 * der heute wirksame Satz mit Herkunft ({@code GET}) und die Angabe des Kunden
 * ({@code PUT}): ein eigener fester Satz oder - mit {@code null} - zurück zur
 * Herleitung aus dem EEG.
 *
 * <p>Die Angabe wirkt überall, wo heute die Herleitung wirkt - im Fahrplan
 * (pricing.py liest dieselbe Spalte beim nächsten Lauf) und in jeder Euro-Zahl
 * der Erlöse ({@code SlotEconomics.exportValueCtSql}); sie ist eine Ebene ÜBER
 * dem EEG-Satzplan und ändert ihn nicht.
 *
 * <p>Mandantenbegrenzt wie jede {@code /api/v1/sites/**}-Route
 * ({@link SiteSupplyPriceController}-Muster): Anmeldung + Postgres-RLS sind der
 * Zaun, eine fremde Anlage ist 404 (nie 403), und eine Plattform-Rolle erreicht
 * jede Anlage über den {@code X-Tenant-Id}-Umschalter auf DEMSELBEN Weg. Der
 * Voll-PUT der Anlage schreibt die Spalte nie - eine ältere Fläche, die ihn
 * sendet, kann die Angabe also nicht still löschen.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/einspeiseverguetung")
public class SiteEinspeiseverguetungController {

    /** Die Plausibilitätsgrenze: kein EEG-Satz lag je darüber (2004: 57,4 ct). */
    static final BigDecimal SATZ_MAX = new BigDecimal("100");

    /** NUMERIC(8, 3) der Spalte. */
    private static final int SATZ_SCALE = 3;

    private final EinspeiseverguetungRepository repo;
    private final Geltungsbereich geltungsbereich;
    private final EegRates eegRates;

    public SiteEinspeiseverguetungController(EinspeiseverguetungRepository repo,
            Geltungsbereich geltungsbereich, OptimizerProperties optimizer) {
        this.repo = repo;
        this.geltungsbereich = geltungsbereich;
        // Derselbe Satzplan wie Optimierer und Erlöse (OPTIMIZER_EEG_RATES_JSON).
        this.eegRates = EegRates.fromJson(optimizer.eegRatesJson());
    }

    @GetMapping
    public EinspeiseverguetungDto get(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        return stand(siteId);
    }

    /**
     * Body {@code {"satzCtKwh": 8.2}} setzt den eigenen Satz (ct/kWh, 0 bis
     * 100; ein deutsches Komma ist erlaubt), {@code {"satzCtKwh": null}} setzt
     * auf die Herleitung zurück. Ein Feld, das fehlt, ist ein Fehler - nie ein
     * stilles Zurücksetzen. Bei Direktvermarktung gibt es keinen festen Satz:
     * setzen ist dann 409, zurücksetzen geht immer.
     *
     * <p>§ 51a EEG (keine Vergütung bei negativem Börsenpreis) hängt am
     * Inbetriebnahmedatum. Fehlt es (keine MaStR-Verknüpfung), verlangt die
     * Angabe {@code "inbetriebnahmeAbSolarspitzengesetz": true|false} - ging
     * die Anlage ab dem 25.02.2025 in Betrieb? Sonst rechnete der Fahrplan den
     * eigenen Satz still auch in Negativpreis-Viertelstunden. Mit Datum
     * entscheidet das Datum, eine mitgesendete Antwort wird nicht gespeichert.
     */
    @PutMapping
    @Recht(value = "anlage.verwalten", ziel = RechtZiel.ANLAGE)
    public EinspeiseverguetungDto put(@PathVariable UUID siteId,
            @RequestBody(required = false) Map<String, Object> body) {
        geltungsbereich.requireSite(siteId);
        if (body == null || !body.containsKey("satzCtKwh")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Bitte geben Sie satzCtKwh an - eine Zahl in ct/kWh, oder null für die "
                            + "Herleitung aus dem EEG.");
        }
        BigDecimal satz = satz(body.get("satzCtKwh"));
        Boolean abSolarspitzengesetz = null;
        if (satz != null) {
            Grundlage g = repo.find(siteId);
            if (g == null) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
            }
            if ("direktvermarktung".equals(g.plantKind())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Bei Direktvermarktung gibt es keine feste Einspeisevergütung - Ihr "
                                + "Erlös ist der Börsenpreis plus Marktprämie (anzulegender Wert).");
            }
            if (g.inbetriebnahme() == null) {
                abSolarspitzengesetz = abSolarspitzengesetz(body.get("inbetriebnahmeAbSolarspitzengesetz"));
            }
        }
        if (!repo.setAngegeben(siteId, satz, abSolarspitzengesetz)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return stand(siteId);
    }

    /** Die Antwort zu § 51a für eine Anlage ohne Inbetriebnahmedatum - Pflicht, ja oder nein. */
    static Boolean abSolarspitzengesetz(Object raw) {
        if (raw instanceof Boolean b) {
            return b;
        }
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                "Ohne Inbetriebnahmedatum brauchen wir eine Angabe: Ging Ihre Anlage vor oder ab dem "
                        + "25.02.2025 in Betrieb (inbetriebnahmeAbSolarspitzengesetz: true oder false)? "
                        + "Davon hängt ab, ob es bei negativem Börsenpreis eine Vergütung gibt.");
    }

    private EinspeiseverguetungDto stand(UUID siteId) {
        Grundlage g = repo.find(siteId);
        if (g == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return EinspeiseverguetungStand.von(g, eegRates);
    }

    /** Der Satz: null setzt zurück; sonst ct/kWh zwischen 0 und 100. */
    static BigDecimal satz(Object raw) {
        if (raw == null) {
            return null;
        }
        BigDecimal v;
        if (raw instanceof Number n) {
            v = new BigDecimal(n.toString());
        } else {
            try {
                v = new BigDecimal(raw.toString().trim().replace(',', '.'));
            } catch (NumberFormatException e) {
                throw ungueltig();
            }
        }
        if (v.signum() < 0 || v.compareTo(SATZ_MAX) > 0) {
            throw ungueltig();
        }
        return v.setScale(SATZ_SCALE, RoundingMode.HALF_UP);
    }

    private static ResponseStatusException ungueltig() {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST,
                "Bitte geben Sie die Einspeisevergütung als Zahl in ct/kWh zwischen 0 und 100 an, "
                        + "z. B. 8,2.");
    }

    /** Deutsche Gründe erreichen das Portal als {"message": ...} (Muster SiteSupplyPriceController). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
