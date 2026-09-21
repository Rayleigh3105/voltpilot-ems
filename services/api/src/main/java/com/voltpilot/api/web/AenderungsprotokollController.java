package com.voltpilot.api.web;

import com.voltpilot.api.uems.AenderungsprotokollService;
import com.voltpilot.api.uems.AenderungsprotokollService.Anfrage;
import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.web.dto.ProtokollDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das ÄNDERUNGSPROTOKOLL des Unternehmens-Energiemanagements (UEMS AP-04 IP-21) — drei
 * Lesewege auf dieselben Einträge: je Messstelle, je Gerät und für das ganze Unternehmen über
 * einen Zeitraum. Die Arbeit macht {@link AenderungsprotokollService}. Seit AP-02 IP-14 dazu je
 * Gebäude/Bereich und je Standort (samt Kindern und Anlagen-Zuordnungen) und die Achse
 * {@code gueltigkeit} (welche Einträge in einen Zeitraum aus Tagen reichen).
 *
 * <p><b>Nur lesend.</b> Geschrieben wird ein Eintrag ausschließlich vom jeweiligen Fachweg
 * (Messstelle anlegen und bearbeiten, Ort und elektrische Stellung, Quellenbindung,
 * Einstellungs-Fassungen, Zählerwechsel, Datenquelle) — diese Routen legen keinen an und
 * ändern keinen.
 *
 * <p><b>Die zwei Zeitachsen.</b> {@code von}/{@code bis} filtern auf der Achse, die
 * {@code achse} nennt: {@code wirkung} (Vorgabe) ist „gilt ab“, {@code eintrag} ist
 * „eingetragen am“. Ein rückwirkender Zählerwechsel gilt am 18.11. um 10:40 und wurde um 11:05
 * eingetragen — er steht mit der Vorgabe im Zeitraum des BETROFFENEN Zeitpunkts. Die Antwort
 * sagt, welche Achse gewirkt hat.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus
 * die Mandanten-RLS wie unter {@code /api/v1/sites/**} — eine fremde Messstelle und ein fremdes
 * Gerät sind 404, nie 403; der Plattform-Admin wählt den Kundenbereich über {@code X-Tenant-Id}.
 * Jede Route nennt im Kommentar ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}
 * ({@code RechteKennungenDerRoutenTest} hält sie an die Matrix).
 */
@RestController
public class AenderungsprotokollController {

    private final AenderungsprotokollService protokoll;
    private final RechtPruefung rechte;

    public AenderungsprotokollController(AenderungsprotokollService protokoll, RechtPruefung rechte) {
        this.protokoll = protokoll;
        this.rechte = rechte;
    }

    /** Recht: {@code aenderungsprotokoll.lesen}. Anlagenprotokoll mit Zeit, Änderung und Akteur. */
    @GetMapping("/api/v1/sites/{siteId}/aenderungen")
    public ProtokollDto.Protokoll anlage(@PathVariable UUID siteId,
            @RequestParam(required = false) String von, @RequestParam(required = false) String bis,
            @RequestParam(required = false) String achse, @RequestParam(required = false) String limit,
            @RequestParam(required = false) String nach) {
        return protokoll.anlage(siteId, anfrage(von, bis, achse, limit, nach));
    }

    /**
     * Recht: {@code aenderungsprotokoll.lesen}. Das Protokoll EINER Messstelle, jüngster
     * Eintrag zuerst: anlegen, bearbeiten, anhalten, fortsetzen, archivieren, Ort, elektrische
     * Stellung, Quellenbindung, Einstellungs-Fassung und Zählerwechsel.
     */
    @GetMapping("/api/v1/messstellen/{id}/aenderungen")
    public ProtokollDto.Protokoll messstelle(@PathVariable UUID id,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis,
            @RequestParam(required = false) String achse,
            @RequestParam(required = false) String limit,
            @RequestParam(required = false) String nach) {
        Anfrage a = anfrage(von, bis, achse, limit, nach);
        // Außerhalb des Zugriffs (AP-03 R-A1): Status und Körper einer Messstelle, die es nicht gibt.
        rechte.pruefenLesen(RechtZiel.MESSSTELLE, id,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        return protokoll.messstelle(id, a);
    }

    /**
     * Recht: {@code aenderungsprotokoll.lesen}. Das Protokoll EINES Geräts: was an seinen
     * Bindungen, seinen Einstellungen und bei seinem Ein- und Ausbau geschehen ist. Ein
     * Zählerwechsel steht in beiden Geräte-Protokollen — beim ausgebauten und beim eingebauten.
     */
    @GetMapping("/api/v1/geraete/{id}/aenderungen")
    public ProtokollDto.Protokoll geraet(@PathVariable UUID id,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis,
            @RequestParam(required = false) String achse,
            @RequestParam(required = false) String limit,
            @RequestParam(required = false) String nach) {
        return protokoll.geraet(id, anfrage(von, bis, achse, limit, nach));
    }

    /**
     * Recht: {@code aenderungsprotokoll.lesen}. Das Protokoll des ganzen Unternehmens über
     * einen Zeitraum — Messstellen, Quellen und Einstellungen zusammen mit Standorten,
     * Gebäuden, Bereichen, Anlagen und Datenquellen. Seitenweise: {@code limit} (Vorgabe 100,
     * höchstens 500) und {@code nach} = der Wert {@code weiter} der vorigen Seite. Ein Eintrag erscheint nur, wenn sein
     * Objekt im Zugriff des Aufrufers liegt ({@link RechtPruefung#lesbar}, AP-03 R-A1); unternehmensweite Rollen sehen alle.
     */
    @GetMapping("/api/v1/unternehmen/aenderungen")
    public ProtokollDto.Protokoll unternehmen(
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis,
            @RequestParam(required = false) String achse,
            @RequestParam(required = false) String limit,
            @RequestParam(required = false) String nach) {
        return protokoll.unternehmen(anfrage(von, bis, achse, limit, nach), rechte::lesbar);
    }

    /**
     * Recht: {@code aenderungsprotokoll.lesen}. Das Protokoll EINES Gebäudes oder Bereichs (AP-02
     * IP-14, H2): angelegt, bearbeitet, Fläche, verschoben, archiviert, wiederhergestellt — und
     * das Löschen eines Bereichs, der an ihm hing.
     */
    @GetMapping("/api/v1/orte/{id}/aenderungen")
    public ProtokollDto.Protokoll ort(@PathVariable UUID id,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis,
            @RequestParam(required = false) String achse,
            @RequestParam(required = false) String limit,
            @RequestParam(required = false) String nach) {
        return protokoll.ort(id, anfrage(von, bis, achse, limit, nach));
    }

    /**
     * Recht: {@code aenderungsprotokoll.lesen}. Das Protokoll EINES Standorts EINSCHLIESSLICH seiner
     * Gebäude, Bereiche und Anlagen-Zuordnungen (AP-02 IP-14) — jedes Kind mit den Einträgen aus
     * der Zeit, in der es an diesem Standort hing; ein Umzug steht bei beiden Standorten.
     */
    @GetMapping("/api/v1/standorte/{id}/aenderungen")
    public ProtokollDto.Protokoll standort(@PathVariable UUID id,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis,
            @RequestParam(required = false) String achse,
            @RequestParam(required = false) String limit,
            @RequestParam(required = false) String nach) {
        return protokoll.standort(id, anfrage(von, bis, achse, limit, nach));
    }

    private static Anfrage anfrage(String von, String bis, String achse, String limit, String nach) {
        return AenderungsprotokollService.anfrage(von, bis, achse, limit, nach);
    }

    /** Dieselbe Fehlerform wie die übrige Messstellen-Schnittstelle: {@code {code, message, feld}}. */
    @ExceptionHandler(MessstelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MessstelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Ein Pfad-Teil, der keine ID ist: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(MessstelleAbgelehnt.anfrage(e.getName(), "„" + e.getName() + "“ ist eine ID."));
    }

    /** 404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
