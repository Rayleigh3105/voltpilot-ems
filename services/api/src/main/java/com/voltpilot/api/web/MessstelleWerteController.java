package com.voltpilot.api.web;

import com.voltpilot.api.uems.MessstelleAbgelehnt;
import com.voltpilot.api.uems.MessstelleWerteRegeln;
import com.voltpilot.api.uems.MessstelleWerteService;
import com.voltpilot.api.uems.WertVersionenRegeln;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Lese-Modell „Werte je Messstelle“ (UEMS AP-08 IP-9): Menge bzw. Mittel/Min/Max je Schritt
 * eines Rasters, und nie ohne Zustand, Abdeckung und Kennzeichen. Die Arbeit macht
 * {@link MessstelleWerteService}.
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} (SecurityConfig) plus die
 * Mandanten-RLS — eine fremde Messstelle ist 404, nie 403. Die Route nennt ihre Kennung aus
 * {@code docs/contracts/v2/rechte-matrix.json} im Kommentar ({@code RechteKennungenDerRoutenTest});
 * durchgesetzt wird sie hier NICHT.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein unbekanntes Raster, ein Zeitpunkt neben dem Raster,
 * {@code von} nicht vor {@code bis}, ein Tag, den es nicht gibt, oder zu viele Schritte sind 400
 * {@code anfrage_ungueltig} mit {@code feld} und {@code grund} — nie ein technischer Fehler.
 */
@RestController
@RequestMapping("/api/v1/messstellen")
public class MessstelleWerteController {

    private final MessstelleWerteService werte;
    private final RechtPruefung rechte;

    public MessstelleWerteController(MessstelleWerteService werte, RechtPruefung rechte) {
        this.werte = werte;
        this.rechte = rechte;
    }

    /**
     * Recht: {@code messwerte.ansehen} (AP-08 §4.8 „Werte, Zustände, Kennzeichen, Versionen ansehen“).
     * {@code raster} viertelstunde · stunde · tag · monat · jahr; {@code von}/{@code bis} ein Tag
     * (JJJJ-MM-TT, {@code bis} = letzter Tag einschließlich) oder ein Zeitpunkt mit Versatz
     * ({@code bis} ausschließlich), beide auf den Grenzen des Rasters in der Zeitzone des Standorts;
     * {@code version} optional.
     */
    @GetMapping("/{kennzeichen}/werte")
    public MessstelleWerteDto.Werte werte(@PathVariable String kennzeichen,
            @RequestParam(required = false) String raster,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis,
            @RequestParam(required = false) String version) {
        return werte.werteDerRoute(kennzeichen, raster, von, bis, version, this::imZugriff);
    }

    /**
     * Recht: {@code messwerte.ansehen} (AP-08 §4.8 „Werte, Zustände, Kennzeichen, Versionen ansehen“). Die
     * Versions-Historie EINER Periode (AP-08 IP-18): je Version der Wert davor und danach, wer, wann, warum.
     * {@code raster} viertelstunde · tag · monat · jahr (die Stunde hat keine eigenen Versionen); {@code von} und
     * {@code bis} wie an {@code …/werte}, genau ein Schritt.
     */
    @GetMapping("/{kennzeichen}/werte/versionen")
    public MessstelleWerteDto.Historie versionen(@PathVariable String kennzeichen,
            @RequestParam(required = false) String raster,
            @RequestParam(required = false) String von,
            @RequestParam(required = false) String bis) {
        return werte.historie(kennzeichen, raster, von, bis, this::imZugriff);
    }

    /** Außerhalb des Zugriffs (AP-03 R-A1): Status und Körper eines Kennzeichens, das es nicht gibt. */
    private void imZugriff(UUID id) {
        rechte.pruefenLesen(RechtZiel.MESSSTELLE, id,
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
    }

    /**
     * 404 {@code version_gibt_es_nicht}: die angefragte Version gibt es an keinem Schritt — benannt, mit der neuesten,
     * nie eine leere Antwort und nie stillschweigend die höchste.
     */
    @ExceptionHandler(WertVersionenRegeln.VersionGibtEsNicht.class)
    public ResponseEntity<Map<String, Object>> versionGibtEsNicht(WertVersionenRegeln.VersionGibtEsNicht e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", WertVersionenRegeln.VersionGibtEsNicht.CODE);
        body.put("message", e.getMessage());
        body.put("feld", "version");
        body.put("grund", WertVersionenRegeln.VersionGibtEsNicht.CODE);
        body.put("version", e.version());
        body.put("hoechste_version", e.hoechste());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(body);
    }

    /**
     * 404 {@code wert_nicht_mehr_gespeichert} (UEMS AP-12 IP-16, Bericht-Vertrag S4/B16): EINE Periode liegt jenseits der
     * Aufbewahrung und ist nicht mehr gespeichert — mit dem Satz des Bericht-Vertrags und dem Berichtsstand, der sie
     * festhält ({@code stand} null: keiner). Nie ein stilles „keine Werte“.
     */
    @ExceptionHandler(MessstelleWerteRegeln.WertNichtMehrGespeichert.class)
    public ResponseEntity<Map<String, Object>> wertNichtMehrGespeichert(MessstelleWerteRegeln.WertNichtMehrGespeichert e) {
        Map<String, Object> zeitraum = new LinkedHashMap<>();
        zeitraum.put("art", e.zeitraumArt());
        zeitraum.put("schluessel", e.schluessel());
        Map<String, Object> stand = null;
        if (e.standNr() != null) {
            stand = new LinkedHashMap<>();
            stand.put("nr", e.standNr());
            stand.put("freigegeben_am", e.standFreigegebenAm());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", MessstelleWerteRegeln.WertNichtMehrGespeichert.CODE);
        body.put("message", e.getMessage());
        body.put("zeitraum", zeitraum);
        body.put("stand", stand);
        return ResponseEntity.status(e.status()).body(body);
    }

    /** {@code {code, message, feld, grund}} — dieselbe Form wie jede Ablehnung der Messstellen-Schnittstelle. */
    @ExceptionHandler(MessstelleAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(MessstelleAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** 404: ein deutscher {@code {message}}-Körper wie überall in der API. */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
