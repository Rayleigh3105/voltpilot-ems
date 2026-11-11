package com.voltpilot.api.web;

import com.voltpilot.api.erzeuger.AnlagensteuerungMessplan;
import com.voltpilot.api.erzeuger.AnlagensteuerungQuelle;
import com.voltpilot.api.erzeuger.AnlagensteuerungService;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.security.Principal;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Anlagensteuerung einer Erzeugeranlage (UEMS EZ-6, Konzept vp-erzeuger-wago-konzept §4.2, EW-3 A): Steuerung
 * als Gerät, Erzeugungseinheiten als Teile, Registerbild-Fassung, aktuelle Werte und die Stammdaten Netz und
 * Vermarktung — gezeigt in den bestehenden Seiten, kein eigener Reiter. Die Arbeit macht
 * {@link AnlagensteuerungService}. Eine fremde oder umzäunte Anlage und ein fremdes Gerät sind 404, nie 403.
 */
@RestController
public class AnlagensteuerungController {

    private final AnlagensteuerungService service;
    private final AnlagensteuerungMessplan messplan;
    private final AnlagensteuerungQuelle quelle;

    public AnlagensteuerungController(AnlagensteuerungService service, AnlagensteuerungMessplan messplan,
            AnlagensteuerungQuelle quelle) {
        this.service = service;
        this.messplan = messplan;
        this.quelle = quelle;
    }

    /**
     * Recht: {@code messwerte.ansehen}. Die Anlagensteuerungen der Anlage mit Datenquelle, laufender Fassung und
     * Einheiten — und ob das Portal die Einrichtung anbieten darf (eine Box meldet {@code erzeuger_registerbild}).
     */
    @GetMapping("/api/v1/sites/{siteId}/anlagensteuerungen")
    public AnlagensteuerungDto.Liste derAnlage(@PathVariable UUID siteId) {
        return service.liste(siteId);
    }

    /**
     * Recht: {@code geraet.einrichten}. Steuerung, Komponente, Einheiten und Fassung in einem Schritt; 409, solange
     * die zuständige Box das Erzeuger-Registerbild nicht lesen kann. Der Messplan (alle Punkte des Bilds, UEMS
     * EZ-18) geht nach dem Commit sofort an die Box; scheitert das, liefert der Abgleich binnen 30 s. Ebenso der
     * Registry-Push, der die Steuerung erst mit ihrer Datenquelle trägt — an eine Box mit
     * {@code anlagensteuerung_quelle} samt Treiber und Pin (EZ-21).
     */
    @PostMapping("/api/v1/sites/{siteId}/anlagensteuerungen")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    @ResponseStatus(HttpStatus.CREATED)
    public AnlagensteuerungDto.Anlagensteuerung anlegen(@PathVariable UUID siteId,
            @Valid @RequestBody AnlagensteuerungDto.Anlegen in, Principal actor) {
        AnlagensteuerungDto.Anlagensteuerung angelegt = service.anlegen(siteId, in, actor.getName());
        messplan.zustellen(siteId, angelegt.entityId());
        quelle.zustellen(siteId);
        return angelegt;
    }

    /**
     * Recht: {@code messwerte.ansehen}. Der jüngste Wert je Punkt des Bilds; ohne Wert {@code keine_daten}, nie 0.
     */
    @GetMapping("/api/v1/sites/{siteId}/anlagensteuerungen/{geraetId}/werte")
    public AnlagensteuerungDto.Werte werte(@PathVariable UUID siteId, @PathVariable UUID geraetId) {
        return service.werte(siteId, geraetId);
    }

    /**
     * Recht: {@code messwerte.ansehen}. Die Kurven des Bilds für Verlauf › Messwerte (UEMS EZ-10) über das Fenster
     * der Historie; ein Eimer ohne Wert fehlt, nie 0.
     */
    @GetMapping("/api/v1/sites/{siteId}/anlagensteuerungen/{geraetId}/verlauf")
    public AnlagensteuerungDto.Verlauf verlauf(@PathVariable UUID siteId, @PathVariable UUID geraetId,
            @RequestParam(defaultValue = "day") String range,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate at) {
        return service.verlauf(siteId, geraetId, range, at);
    }

    /** Recht: {@code geraet.einrichten}. Umbenennen ändert nur die Anzeige; Nummer und Messreihe bleiben. */
    @PutMapping("/api/v1/geraete/{id}/anlagensteuerung/einheiten/{teNr}")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.GERAET)
    public AnlagensteuerungDto.Einheit einheitAendern(@PathVariable UUID id, @PathVariable int teNr,
            @Valid @RequestBody AnlagensteuerungDto.EinheitAendern in) {
        return service.einheitAendern(id, teNr, in);
    }

    /**
     * Recht: {@code geraet.einrichten}. Die Namen, die das Bild nennt, als Vorbelegung; weicht der Netzbetreiber
     * vom Netzanschluss ab, kommt ein Hinweis zurück, nichts wird überschrieben.
     */
    @PostMapping("/api/v1/geraete/{id}/anlagensteuerung/namen")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.GERAET)
    public AnlagensteuerungDto.NetzVermarktung namenAusBild(@PathVariable UUID id,
            @Valid @RequestBody AnlagensteuerungDto.NamenAusBild in, Principal actor) {
        return service.namenAusBild(id, in, actor.getName());
    }

    /** Recht: {@code messwerte.ansehen}. Netzbetreiber (vom Netzanschluss), Direktvermarkter, Einspeisemanagement. */
    @GetMapping("/api/v1/sites/{siteId}/netz-vermarktung")
    public AnlagensteuerungDto.NetzVermarktung netzVermarktung(@PathVariable UUID siteId) {
        return service.netzVermarktung(siteId);
    }

    /** Recht: {@code anlage.verwalten}. Ersetzt Direktvermarkter und Einspeisemanagement bei passender Revision. */
    @PutMapping("/api/v1/sites/{siteId}/netz-vermarktung")
    @Recht(value = "anlage.verwalten", ziel = RechtZiel.ANLAGE)
    public AnlagensteuerungDto.NetzVermarktung netzVermarktungAendern(@PathVariable UUID siteId,
            @Valid @RequestBody AnlagensteuerungDto.NetzVermarktungAendern in, Principal actor) {
        return service.netzVermarktungAendern(siteId, in, actor.getName());
    }
}
