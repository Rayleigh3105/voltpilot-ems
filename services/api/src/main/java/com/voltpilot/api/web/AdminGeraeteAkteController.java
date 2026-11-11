package com.voltpilot.api.web;

import com.voltpilot.api.enrollment.EnrollmentRepository;
import com.voltpilot.api.fernwartung.FernwartungRepository.Zugang;
import com.voltpilot.api.fernwartung.FernwartungService;
import com.voltpilot.api.geraete.BoxAusbauenAdminService;
import com.voltpilot.api.geraete.BoxBefundSql;
import com.voltpilot.api.geraete.BoxEndgueltigAbgelehnt;
import com.voltpilot.api.geraete.BoxEndgueltigLoeschenService;
import com.voltpilot.api.geraete.BoxLoesenAbgelehnt;
import com.voltpilot.api.geraete.BoxLoesenRegel;
import com.voltpilot.api.geraete.BoxLoesenService;
import com.voltpilot.api.repo.AdminGeraeteAkteRepository;
import com.voltpilot.api.repo.AdminGeraeteAkteRepository.AkteBoxRow;
import com.voltpilot.api.repo.AdminGeraeteListeRepository;
import com.voltpilot.api.repo.AdminGeraeteListeRepository.GeraeteListeZeile;
import com.voltpilot.api.uems.BoxKonflikt;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.AdminGeraeteAkteDto;
import com.voltpilot.api.web.dto.BoxAusbauenDto;
import com.voltpilot.api.web.dto.BoxEndgueltigDto;
import com.voltpilot.api.web.dto.BoxLoesenDto.AnfrageDto;
import com.voltpilot.api.web.dto.BoxLoesenDto.AnmeldungDto;
import com.voltpilot.api.web.dto.BoxLoesenDto.BefundDto;
import com.voltpilot.api.web.dto.BoxLoesenDto.ErgebnisDto;
import com.voltpilot.api.web.dto.BoxLoesenDto.FaktenDto;
import com.voltpilot.api.werkstatt.WerkstattRepository;
import java.util.Map;
import java.util.Optional;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Geräteakte in EINER Antwort: {@code GET /api/v1/admin/geraete/{ref}}
 * (Lücke L3, Adminview-Konzept Abschnitt 3.4/4.4). Führt zusammen, was die
 * Akte heute client-seitig aus mehreren Listen zusammensetzen müsste: Geräte-
 * und Software-Stand ({@link AdminGeraeteAkteRepository}), Lebensabschnitt
 * ({@link AdminGeraeteListeRepository}, Lücke L7), Zertifikat
 * ({@link EnrollmentRepository}, Lücke L4) und ein Blick auf Fernwartung
 * bzw. Werkstatt für diese EINE Box.
 *
 * <p>Sicherheits-Disziplin wie {@link AdminFleetController}:
 * {@code @PreAuthorize("hasRole('platform-admin')")}; die RLS-Umgehung bleibt
 * auf die admin-geschützten Repositories beschränkt.
 */
@RestController
@RequestMapping("/api/v1/admin/geraete")
@PreAuthorize("hasRole('platform-admin')")
public class AdminGeraeteAkteController {

    private final AdminGeraeteAkteRepository akte;
    private final AdminGeraeteListeRepository liste;
    private final EnrollmentRepository enrollments;
    private final FernwartungService fernwartung;
    private final WerkstattRepository werkstatt;
    private final BoxLoesenService loesen;
    private final BoxEndgueltigLoeschenService endgueltig;
    private final BoxAusbauenAdminService ausbauen;

    public AdminGeraeteAkteController(AdminGeraeteAkteRepository akte,
            AdminGeraeteListeRepository liste, EnrollmentRepository enrollments,
            FernwartungService fernwartung, WerkstattRepository werkstatt, BoxLoesenService loesen,
            BoxEndgueltigLoeschenService endgueltig, BoxAusbauenAdminService ausbauen) {
        this.akte = akte;
        this.liste = liste;
        this.enrollments = enrollments;
        this.fernwartung = fernwartung;
        this.werkstatt = werkstatt;
        this.loesen = loesen;
        this.endgueltig = endgueltig;
        this.ausbauen = ausbauen;
    }

    @GetMapping("/{ref}")
    public AdminGeraeteAkteDto akte(@PathVariable String ref) {
        GeraeteListeZeile lebenslauf = liste.eineBox(ref)
                .orElseThrow(() -> new ResponseStatusException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "Unbekannte Referenz: " + ref));

        Optional<AkteBoxRow> box = akte.box(ref);
        AdminGeraeteAkteDto.Kopf kopf = box.map(b -> new AdminGeraeteAkteDto.Kopf(
                b.deviceId().toString(), b.name(), b.siteId().toString(), b.siteName(),
                b.tenantId().toString(), b.tenantName(), b.herzschlagAm(), b.messwertAm(),
                b.lastSeenAt(), b.ausgebautAm())).orElse(null);

        AdminGeraeteAkteDto.Software software = box.map(b -> new AdminGeraeteAkteDto.Software(
                AdminFleetController.edgeDto(b.edge()), AdminFleetController.updateDto(b.update()),
                b.supports(), AdminFleetController.boxArt(b.edge(), b.update()))).orElse(null);

        Optional<Zugang> zugang = fernwartung.box(ref);
        Optional<EnrollmentRepository.Enrollment> enrollment = enrollments.find(ref);
        AdminGeraeteAkteDto.Verbindung verbindung =
                (box.isPresent() || zugang.isPresent())
                        ? new AdminGeraeteAkteDto.Verbindung(
                                box.map(AkteBoxRow::lanHost).orElse(null),
                                box.map(AkteBoxRow::lanSeenAt).orElse(null),
                                zugang.map(Zugang::aktiv).orElse(null),
                                zugang.map(Zugang::adresse).orElse(null))
                        : null;

        boolean inWerkstatt = werkstatt.box(ref).isPresent();
        AdminGeraeteAkteDto.Einrichtung einrichtung =
                (enrollment.isPresent() || inWerkstatt)
                        ? new AdminGeraeteAkteDto.Einrichtung(
                                enrollment.map(EnrollmentRepository.Enrollment::issuedAt).orElse(null),
                                enrollment.map(EnrollmentRepository.Enrollment::notAfter).orElse(null),
                                "werkstatt".equals(lebenslauf.lebensabschnitt())
                                        ? lebenslauf.seit() : null)
                        : null;

        return new AdminGeraeteAkteDto(ref, lebenslauf.lebensabschnitt(), lebenslauf.seit(),
                kopf, software, verbindung, einrichtung);
    }

    /**
     * Der Befund „Vom Kunden lösen" (L1, Vertrag Abschnitt 3.5): informativ, prüft NICHTS unter
     * Sperre - die verbindliche Prüfung läuft erst im POST, in {@link BoxLoesenService}.
     */
    @GetMapping("/{ref}/loesen")
    public BefundDto loesenBefund(@PathVariable String ref) {
        return befundDto(loesen.befund(ref));
    }

    /**
     * Lösen (B1 = A): löscht die Verknüpfung, als wäre sie nie gewesen - nur solange die Box sich nie
     * gemeldet hat (B2 = A: ein abgeholter Schlüssel blockiert den Admin nicht). 409 mit Gründen und
     * nichts geändert, wenn die Regel es nicht erlaubt ({@link #abgelehnt}).
     */
    @PostMapping("/{ref}/loesen")
    public ErgebnisDto loesen(@PathVariable String ref, @RequestBody AnfrageDto anfrage, Authentication auth) {
        BoxLoesenService.Ergebnis ergebnis = loesen.loesen(ref, anfrage.anlass(), anfrage.anlassText(),
                ProtokollAkteur.aus(auth).orElse(null));
        return new ErgebnisDto(ergebnis.externalRef(), ergebnis.anlass());
    }

    @ExceptionHandler(BoxLoesenAbgelehnt.class)
    public org.springframework.http.ResponseEntity<Map<String, Object>> abgelehnt(BoxLoesenAbgelehnt e) {
        return org.springframework.http.ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

    /**
     * Box ausbauen (vp-admin-box-ausbauen): derselbe Einstieg "Vom Kunden lösen" bietet dies an,
     * wenn die Box nicht mehr lösbar ist (hat schon Daten) - dieselbe Umsetzung wie "Gerät entfernen"
     * ({@link BoxAusbauenAdminService}), kein Mandantensprung nötig. 409 {@code box_hat_zustaendigkeiten}
     * mit Grund, solange die Box noch Datenquellen liest oder geplante Zuständigkeiten hat.
     */
    @PostMapping("/{ref}/ausbauen")
    public BoxAusbauenDto.ErgebnisDto ausbauen(@PathVariable String ref,
            @RequestBody BoxAusbauenDto.AnfrageDto anfrage, Authentication auth) {
        BoxAusbauenAdminService.Ergebnis e = ausbauen.ausbauen(ref, anfrage.anlass(), anfrage.anlassText(),
                ProtokollAkteur.aus(auth).orElse(null));
        return new BoxAusbauenDto.ErgebnisDto(e.externalRef(), e.deviceId().toString(), e.ausgebautAm(), e.anlass(),
                e.bereitsAusgebaut());
    }

    @ExceptionHandler(BoxKonflikt.class)
    public org.springframework.http.ResponseEntity<Map<String, String>> boxKonflikt(BoxKonflikt e) {
        return org.springframework.http.ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

    /**
     * Der Befund „Endgültig löschen" einer AUSGEBAUTEN Box (vierter Löschweg,
     * vp-box-endgueltig-loeschen): informativ, prüft nichts unter Sperre - die verbindliche Prüfung
     * läuft erst im POST, in {@link BoxEndgueltigLoeschenService}. Die Akte zeigt mit der Liste
     * {@code daten} ruhig, WARUM eine Box bleibt - nie ein toter Knopf.
     */
    @GetMapping("/{ref}/endgueltig-loeschen")
    public BoxEndgueltigDto.BefundDto endgueltigBefund(@PathVariable String ref) {
        BoxEndgueltigLoeschenService.Befund b = endgueltig.befund(ref);
        return new BoxEndgueltigDto.BefundDto(b.zeile().deviceId(), b.loeschbar(), b.daten(),
                new BoxEndgueltigDto.FaktenDto(b.zeile().verbundenAm(), b.zeile().ausgebautAm(),
                        b.zeile().tenantName(), b.zeile().siteName()));
    }

    /**
     * Endgültig löschen: nur eine ausgebaute Box, die nie Daten geliefert hat ({@code BoxDatenBestand},
     * Beleg-Regeln). Idempotent über die Geräte-ID aus dem Befund; 409 mit der Liste der Datenarten
     * und nichts geändert, wenn doch Daten da sind ({@link #endgueltigAbgelehnt}). Werkstatt- und
     * Fernwartungs-Protokolle bleiben.
     */
    @PostMapping("/{ref}/endgueltig-loeschen")
    public BoxEndgueltigDto.ErgebnisDto endgueltigLoeschen(@PathVariable String ref,
            @RequestBody BoxEndgueltigDto.AnfrageDto anfrage, Authentication auth) {
        BoxEndgueltigLoeschenService.Ergebnis e = endgueltig.loeschen(ref, anfrage.deviceId(),
                ProtokollAkteur.aus(auth).orElse(null));
        return new BoxEndgueltigDto.ErgebnisDto(e.externalRef(), e.deviceId(), e.geloeschtAm(),
                e.bereitsGeloescht());
    }

    @ExceptionHandler(BoxEndgueltigAbgelehnt.class)
    public org.springframework.http.ResponseEntity<Map<String, Object>> endgueltigAbgelehnt(
            BoxEndgueltigAbgelehnt e) {
        return org.springframework.http.ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

    private static BefundDto befundDto(BoxBefundSql.Zeile z) {
        var gruende = BoxLoesenRegel.gruende(z.befund(), true);
        var fakten = new FaktenDto(z.verbundenAm(), z.befund().herzschlagAm(), z.befund().messwertAm(),
                z.befund().meldungAm(), new AnmeldungDto(z.zuletztAngefragtAm(), z.befund().schluesselAbgeholtAm()));
        return new BefundDto(gruende.isEmpty(), gruende, fakten);
    }
}
