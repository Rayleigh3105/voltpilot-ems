package com.voltpilot.api.web;

import com.voltpilot.api.direktvermarktung.DirektvermarktungService;
import com.voltpilot.api.direktvermarktung.DirektvermarktungService.Abgelehnt;
import com.voltpilot.api.direktvermarktung.DirektvermarktungService.Status;
import com.voltpilot.api.repo.DirektvermarktungRepository.ProtokollZeile;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.web.dto.DirektvermarktungDto;
import com.voltpilot.api.web.dto.DirektvermarktungDto.ProtokollZeileDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import com.voltpilot.api.zugriff.ZugriffContext;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
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
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Anschluss einer Anlage an einen Direktvermarkter (Einstellungen › Strom &amp; Geld, Seite
 * {@code #/anlage/{id}/direktvermarktung}; Konzept vp-direktvermarktung-konzept d2 §5.7/§7, E4 = A "der Kunde
 * richtet allein ein"). Das Hochladen der Zugangsdatei ({@code POST .../zugang}) ist sicherheitskritisch und
 * eigener Auftrag - diese Route gibt es hier bewusst (noch) nicht.
 *
 * <p>Recht: lesend wie jede {@code /api/v1/sites/**}-Route (Anmeldung + RLS); schreibend {@code anlage.verwalten}
 * (Muster {@link SiteEinspeiseverguetungController}) - derselbe Code, mit dem der Kunde heute schon Einspeise­
 * vergütung und Netzvermarktung bearbeitet.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/direktvermarktung")
public class SiteDirektvermarktungController {

    private static final String RECHT = "anlage.verwalten";

    private final DirektvermarktungService dienst;
    private final Geltungsbereich geltungsbereich;
    private final RechtPruefung recht;

    public SiteDirektvermarktungController(DirektvermarktungService dienst, Geltungsbereich geltungsbereich,
            RechtPruefung recht) {
        this.dienst = dienst;
        this.geltungsbereich = geltungsbereich;
        this.recht = recht;
    }

    @GetMapping
    public DirektvermarktungDto stand(@PathVariable UUID siteId) {
        geltungsbereich.requireSite(siteId);
        return DirektvermarktungDto.von(dienst.stand(siteId), darf(siteId));
    }

    @GetMapping("/verlauf")
    public List<ProtokollZeileDto> verlauf(@PathVariable UUID siteId,
            @RequestParam(name = "grenze", defaultValue = "200") int grenze) {
        geltungsbereich.requireSite(siteId);
        List<ProtokollZeile> zeilen = dienst.verlauf(siteId, Math.max(1, Math.min(grenze, 1000)));
        return zeilen.stream().map(ProtokollZeileDto::von).toList();
    }

    /** Bildschirm 4 "Direktvermarkter wählen". Body {@code {"partner": "luox"}}. */
    @PostMapping("/waehlen")
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    public DirektvermarktungDto waehlen(@PathVariable UUID siteId, @RequestBody Map<String, String> body,
            Authentication auth) {
        geltungsbereich.requireSite(siteId);
        String partner = pflicht(body, "partner", "Bitte einen Direktvermarkter wählen.");
        return antwort(siteId, dienst.waehlen(siteId, partner, akteur(auth), rolle()));
    }

    /** Bildschirm 6 "Zustimmen". Body {@code {"textfassung": "..."}}. */
    @PostMapping("/zustimmen")
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    public DirektvermarktungDto zustimmen(@PathVariable UUID siteId, @RequestBody Map<String, String> body,
            Authentication auth) {
        geltungsbereich.requireSite(siteId);
        String fassung = pflicht(body, "textfassung", "Bitte zuerst die Textfassung angeben, der zugestimmt wird.");
        return antwort(siteId, dienst.zustimmen(siteId, fassung, akteur(auth), rolle()));
    }

    /** Bildschirm 14 "Startdatum eintragen". Body {@code {"startdatum": "2026-12-01"}}, {@code null} setzt zurück. */
    @PutMapping("/startdatum")
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    public DirektvermarktungDto startdatum(@PathVariable UUID siteId,
            @RequestBody(required = false) Map<String, String> body, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return antwort(siteId, dienst.startdatumSetzen(siteId, datum(body, "startdatum"), akteur(auth), rolle()));
    }

    /** Bildschirm 27 "Beenden". Body {@code {"ende": "2026-11-30"}}. */
    @PostMapping("/beenden")
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    public DirektvermarktungDto beenden(@PathVariable UUID siteId, @RequestBody Map<String, String> body,
            Authentication auth) {
        geltungsbereich.requireSite(siteId);
        LocalDate ende = datum(body, "ende");
        if (ende == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Bitte ein Enddatum angeben.");
        return antwort(siteId, dienst.beenden(siteId, ende, akteur(auth), rolle()));
    }

    /** Bildschirm 28 "Wechsel geplant". Body {@code {"partner": "b", "stichtag": "2027-01-01"}}. */
    @PostMapping("/wechseln")
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    public DirektvermarktungDto wechseln(@PathVariable UUID siteId, @RequestBody Map<String, String> body,
            Authentication auth) {
        geltungsbereich.requireSite(siteId);
        String partner = pflicht(body, "partner", "Bitte den neuen Direktvermarkter angeben.");
        LocalDate stichtag = datum(body, "stichtag");
        if (stichtag == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Bitte einen Stichtag für den Wechsel angeben.");
        }
        return antwort(siteId, dienst.wechseln(siteId, partner, stichtag, akteur(auth), rolle()));
    }

    /** Bildschirm 19 "Jetzt neu verbinden". */
    @PostMapping("/neu-verbinden")
    @Recht(value = RECHT, ziel = RechtZiel.ANLAGE)
    public DirektvermarktungDto neuVerbinden(@PathVariable UUID siteId, Authentication auth) {
        geltungsbereich.requireSite(siteId);
        return antwort(siteId, dienst.neuVerbinden(siteId, akteur(auth), rolle()));
    }

    private DirektvermarktungDto antwort(UUID siteId, Status status) {
        return DirektvermarktungDto.von(status, darf(siteId));
    }

    private boolean darf(UUID siteId) {
        return recht.erlaubt(RECHT, RechtZiel.ANLAGE, siteId);
    }

    private static String akteur(Authentication auth) {
        return auth == null ? null : auth.getName();
    }

    private static String rolle() {
        return ZugriffContext.handelndeRolle().map(RechteAbleitung.Rolle::code)
                .orElse(RechteAbleitung.Rolle.KUNDENADMINISTRATOR.code());
    }

    private static String pflicht(Map<String, String> body, String feld, String fehlerText) {
        String wert = body == null ? null : body.get(feld);
        if (wert == null || wert.isBlank()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, fehlerText);
        return wert;
    }

    private static LocalDate datum(Map<String, String> body, String feld) {
        String wert = body == null ? null : body.get(feld);
        if (wert == null || wert.isBlank()) return null;
        try {
            return LocalDate.parse(wert);
        } catch (java.time.format.DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Bitte ein Datum im Format JJJJ-MM-TT angeben.");
        }
    }

    @ExceptionHandler(Abgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(Abgelehnt e) {
        HttpStatus status = "anlage_unbekannt".equals(e.grund()) ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT;
        return ResponseEntity.status(status).body(Map.of("grund", e.grund(), "message", e.getMessage()));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> fehler(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
