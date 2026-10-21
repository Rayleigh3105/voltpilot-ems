package com.voltpilot.api.web;

import com.voltpilot.api.erzeuger.VorgabenService;
import com.voltpilot.api.web.dto.ErzeugerVorgabenDto;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Vorgaben einer Erzeugeranlage (UEMS EZ-7, Konzept vp-erzeuger-wago-konzept §4.6, EW-8 A, EW-12 A): wer wann wie
 * lange die Anlage begrenzt oder gesteuert hat — Grundlage des Protokolls im Verlauf (EZ-9) und der Kachel „Wer hat
 * heute geregelt?“. Nur lesend; abgeleitet hat sie der {@code VorgabenLaeufer}. Recht: {@code messwerte.ansehen}
 * (Standort-Zaun); eine fremde oder umzäunte Anlage ist 404, nie 403.
 */
@RestController
public class ErzeugerVorgabenController {

    private final VorgabenService service;

    public ErzeugerVorgabenController(VorgabenService service) {
        this.service = service;
    }

    /**
     * Die Chronik: Vorgaben, die {@code [von, bis)} berühren, und Datenlücken mit weiteren Wechseln. Ohne Zeitraum
     * die letzten sieben Tage; {@code urheber} und {@code te_nr} (0 = nur die ganze Anlage) grenzen ein.
     */
    @GetMapping("/api/v1/sites/{siteId}/erzeuger/vorgaben")
    public ErzeugerVorgabenDto.Chronik chronik(@PathVariable UUID siteId,
            @RequestParam(required = false) String von, @RequestParam(required = false) String bis,
            @RequestParam(required = false) String urheber,
            @RequestParam(name = "te_nr", required = false) Integer teNr) {
        return service.chronik(siteId, von, bis, urheber, teNr);
    }

    /** „Nach Art“: Anzahl, Dauer und geschätzte Energie je Urheber, Art und Einheit — je Tag oder Monat. */
    @GetMapping("/api/v1/sites/{siteId}/erzeuger/vorgaben/zaehlung")
    public ErzeugerVorgabenDto.Zaehlung zaehlung(@PathVariable UUID siteId,
            @RequestParam(required = false) String raster, @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis) {
        return service.zaehlung(siteId, raster, von, bis);
    }

    /** Heute (Europe/Berlin) bis jetzt und was gerade läuft — für „Wer hat heute geregelt?“. */
    @GetMapping("/api/v1/sites/{siteId}/erzeuger/vorgaben/heute")
    public ErzeugerVorgabenDto.Heute heute(@PathVariable UUID siteId) {
        return service.heute(siteId);
    }

    /** Eine Vorgabe mit Rohsignalen am Beginn und Ende, den Proben ihres Zeitraums und den Zählerständen. */
    @GetMapping("/api/v1/sites/{siteId}/erzeuger/vorgaben/{vorgabeId}")
    public ErzeugerVorgabenDto.Detail detail(@PathVariable UUID siteId, @PathVariable UUID vorgabeId) {
        return service.detail(siteId, vorgabeId);
    }

    /** „Vorgaben als CSV“: Spalten deutsch, de-DE-Zahlen, Semikolon, UTF-8. Ohne Zeitraum die letzten sieben Tage. */
    @GetMapping(value = "/api/v1/sites/{siteId}/erzeuger/vorgaben.csv", produces = "text/csv")
    public ResponseEntity<byte[]> csv(@PathVariable UUID siteId, @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=vorgaben.csv")
                .contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
                .body(service.csv(siteId, von, bis));
    }
}
