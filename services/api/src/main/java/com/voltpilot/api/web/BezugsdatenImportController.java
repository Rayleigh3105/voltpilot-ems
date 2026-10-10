package com.voltpilot.api.web;

import com.voltpilot.api.uems.ImportUebernahmeService;
import com.voltpilot.api.uems.KorrekturFreigabeService;
import com.voltpilot.api.uems.KorrekturFreigabeAbgelehnt;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.GetMapping;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.BezugsgroesseAbgelehnt;
import com.voltpilot.api.uems.CsvLeser;
import com.voltpilot.api.uems.ImportVorschau;
import com.voltpilot.api.uems.ImportVorschauService;
import com.voltpilot.api.uems.BezugsdatenZuordnung;
import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.multipart.support.MissingServletRequestPartException;

/**
 * Die Importschnittstelle der Bezugsdaten (UEMS AP-09 IP-12/IP-13, Vertrag {@code docs/contracts/v2/bezugsdaten.md} §10 —
 * Regel {@code vorschau}). Vorschau: {@link ImportVorschauService}; Übernahme, Rücknahme und Status:
 * {@link ImportUebernahmeService}. Die Vorschau-Regeln stehen in {@link ImportVorschau}.
 *
 * <p><b>Die Vorschau zeigt alles und schreibt nichts:</b> keinen Wert, keinen Import, keine Vorlage — und nicht die
 * Datei (E14). Zweimal dieselbe Datei mit derselben Zuordnung und demselben Bestand ergibt dieselbe Antwort. Die
 * Kennung der Vorschau ist kurzlebig ({@link ImportVorschau#GUELTIG}) und kein Auftrag: sie reserviert nichts;
 * die Übernahme (IP-13) bringt die Datei noch einmal mit und rechnet neu.
 *
 * <p><b>Die Anfrage:</b> {@code multipart/form-data} mit dem Teil {@code datei} (≤ 5 242 880 Bytes, C1) und dem
 * Teil {@code zuordnung} (JSON, C3). Die Zuordnung wird streng gelesen: ein unbekanntes Feld, ein falscher Typ oder
 * eine unvollständige Zuordnung ist 400 {@code anfrage_ungueltig} mit {@code feld}. Was an der DATEI nicht passt, ist
 * nie 400: es ist ein Befund an der Datei der Vorschau, eine zu große Datei 413 mit demselben Befund.
 *
 * <p><b>Rechte:</b> es gilt {@code authenticated()} plus die Mandanten-RLS: Bezugsgrößen, Werte
 * und Importe eines fremden Kundenbereichs sieht die Vorschau nicht — eine fremde Bezugsgröße ist
 * {@code bezug_unbekannt}, eine fremde Datei nicht {@code datei_bekannt}. Die Kennung der Route steht im Kommentar
 * ({@code RechteKennungenDerRoutenTest}); seit AP-03 IP-6 setzt {@code @Recht} sie vor dem Handler durch
 * (403 {@code recht_fehlt}, außerhalb des Geltungsbereichs 404).
 */
@RestController
@RequestMapping("/api/v1/bezugsdaten/importe")
public class BezugsdatenImportController {

    private final ImportVorschauService vorschauen;
    private final ObjectMapper streng;
    @Autowired
    private ImportUebernahmeService uebernahme;

    /** Recht: {@code bezugsgroesse.importieren}, jedes Ziel wird im Dienst geprüft. */
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @Recht(value = "bezugsgroesse.importieren", ziel = RechtZiel.DIENST)
    public ImportUebernahmeService.Ergebnis uebernehmen(
            @RequestPart("datei") MultipartFile datei,
            @RequestPart(value = "zuordnung", required = false) String zuordnung,
            @RequestPart(value = "vorlage_id", required = false) String vorlageIdText,
            @RequestPart("bestaetigung") String bestaetigung,
            Authentication auth) throws IOException {
        ImportUebernahmeService.Bestaetigung b;
        try { b = streng.readValue(bestaetigung, ImportUebernahmeService.Bestaetigung.class); }
        catch (JsonProcessingException e) { throw BezugsgroesseAbgelehnt.anfrage("bestaetigung"); }
        UUID vorlageId;
        try { vorlageId = vorlageIdText == null ? null : UUID.fromString(vorlageIdText); }
        catch (IllegalArgumentException e) { throw BezugsgroesseAbgelehnt.anfrage("vorlage_id"); }
        if ((vorlageId == null) == (zuordnung == null)) throw BezugsgroesseAbgelehnt.anfrage("zuordnung");
        return uebernahme.uebernehmen(datei.getBytes(), datei.getOriginalFilename(),
                vorlageId == null ? zuordnung(zuordnung) : null, b, OrtAnfrage.akteur(auth), vorlageId);
    }

    public record Ruecknahme(String begruendung) {}

    @Autowired
    private KorrekturFreigabeService freigaben;

    /** Recht: {@code korrektur.freigeben}, mit derselben Vier-Augen-Prüfung wie Einzelberichtigungen. */
    @PostMapping("/{kennung}/freigeben")
    @Recht(value = "korrektur.freigeben", ziel = RechtZiel.DIENST)
    public ImportUebernahmeService.Ergebnis freigeben(
            @PathVariable String kennung,
            @RequestBody String body,
            Authentication auth) {
        if (!kennung.matches("^I-[0-9]{4}-[0-9]{4,}$")) throw BezugsgroesseAbgelehnt.von(
                com.voltpilot.api.uems.BezugsgroesseRegeln.Ablehnung.NICHT_GEFUNDEN);
        freigaben.freigeben(kennung, grund(body).begruendung(), OrtAnfrage.akteur(auth));
        return uebernahme.status(kennung);
    }

    private Ruecknahme grund(String body) {
        try {
            Ruecknahme a = streng.readValue(body, Ruecknahme.class);
            if (a == null) throw BezugsgroesseAbgelehnt.anfrage("begruendung");
            return a;
        } catch (JsonProcessingException e) {
            throw BezugsgroesseAbgelehnt.anfrage("begruendung");
        }
    }

    /** Recht: lesend — keine eigene Kennung; der Dienst prüft alle Ziele und verbirgt fremde Importe. */
    @GetMapping("/{kennung}")
    public ImportUebernahmeService.ProtokollEintrag status(
            @PathVariable String kennung) {
        return uebernahme.detail(kennung);
    }

    /** Recht: {@code bezugsgroesse.importieren}; ein Eintrag mit einem Ziel außerhalb des Zugriffs fehlt. */
    @GetMapping
    public ImportUebernahmeService.Protokoll importe() {
        return uebernahme.protokoll();
    }

    /** Recht: {@code bezugsgroesse.importieren}; reine Vorschau, dieselbe Planung wie die Rücknahme. */
    @GetMapping("/{kennung}/ruecknahme/vorschau")
    public ImportUebernahmeService.RuecknahmeVorschau ruecknahmeVorschau(@PathVariable String kennung) {
        return uebernahme.ruecknahmeVorschau(kennung);
    }

    /** Recht: {@code bezugsgroesse.importieren}, jedes Ziel wird im Dienst geprüft. */
    @PostMapping("/{kennung}/ruecknahme")
    @Recht(value = "bezugsgroesse.importieren", ziel = RechtZiel.DIENST)
    public ImportUebernahmeService.Ergebnis ruecknahme(
            @PathVariable String kennung,
            @RequestBody String body,
            Authentication auth) {
        return uebernahme.ruecknahme(kennung, grund(body).begruendung(),
                OrtAnfrage.akteur(auth));
    }


    public BezugsdatenImportController(ImportVorschauService vorschauen, ObjectMapper json) {
        this.vorschauen = vorschauen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
    }

    /** Recht: {@code bezugsgroesse.importieren} (AP-09 §4.11 — Vorschau und Übernahme eines Imports). */
    @PostMapping(path = "/vorschau", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @Recht(value = "bezugsgroesse.importieren", ziel = RechtZiel.DIENST)
    public BezugsdatenImportDto.Vorschau vorschau(
            @RequestPart("datei") MultipartFile datei,
            @RequestPart(value = "zuordnung", required = false) String zuordnung,
            @RequestPart(value = "vorlage_id", required = false) String vorlageIdText) throws IOException {
        UUID vorlageId;
        try {
            vorlageId = vorlageIdText == null ? null : UUID.fromString(vorlageIdText);
        } catch (IllegalArgumentException e) {
            throw BezugsgroesseAbgelehnt.anfrage("vorlage_id");
        }
        if (vorlageId != null && zuordnung != null) {
            throw BezugsgroesseAbgelehnt.anfrage("zuordnung");
        }
        ImportVorschau.Zuordnung z = vorlageId == null ? zuordnung(zuordnung) : null;
        return vorschauen.vorschau(datei.getBytes(), datei.getOriginalFilename(), z, vorlageId);
    }

    private ImportVorschau.Zuordnung zuordnung(String json) {
        BezugsdatenImportDto.Zuordnung a;
        try {
            a = streng.readValue(json, BezugsdatenImportDto.Zuordnung.class);
        } catch (UnrecognizedPropertyException e) {
            throw BezugsgroesseAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw BezugsgroesseAbgelehnt.anfrage(pfad(e));
        } catch (JsonProcessingException e) {
            throw BezugsgroesseAbgelehnt.anfrage("zuordnung");
        }
        return BezugsdatenZuordnung.aus(a);
    }

    private static String pfad(JsonMappingException e) {
        List<String> teile = e.getPath().stream()
                .map(r -> r.getFieldName() != null ? r.getFieldName() : String.valueOf(r.getIndex())).toList();
        return teile.isEmpty() ? "zuordnung" : String.join(".", teile);
    }

    @ExceptionHandler(KorrekturFreigabeAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> korrekturAbgelehnt(KorrekturFreigabeAbgelehnt e) {
        Map<String,Object> body = new LinkedHashMap<>(e.fakten());
        body.put("code", e.code()); body.put("message", e.getMessage());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** {@code {code, message, feld}} — dieselbe Form wie jede Ablehnung der Bezugsgrößen-Routen. */
    @ExceptionHandler(BezugsgroesseAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BezugsgroesseAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Ein fehlender Teil ({@code datei} oder {@code zuordnung}) ist eine unvollständige Anfrage. */
    @ExceptionHandler(MissingServletRequestPartException.class)
    public ResponseEntity<Map<String, Object>> teilFehlt(MissingServletRequestPartException e) {
        return abgelehnt(BezugsgroesseAbgelehnt.anfrage(e.getRequestPartName()));
    }

    /**
     * Über 5 242 880 Bytes liest niemand die Datei — die Antwort ist trotzdem der Befund des Lesers
     * ({@code datei_zu_gross} + {@code zu_viele_bytes}), nicht ein roher Fehler. Ohne gelesene Bytes gibt es keinen
     * Fingerabdruck.
     */
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<Map<String, Object>> zuGross(MaxUploadSizeExceededException e) {
        Map<String, Object> befund = new LinkedHashMap<>();
        befund.put("befund", CsvLeser.DATEI_ZU_GROSS);
        befund.put("satz", ImportVorschau.satz(CsvLeser.DATEI_ZU_GROSS));
        befund.put("hinweis", false);
        Map<String, Object> datei = new LinkedHashMap<>();
        datei.put("sha256", null);
        datei.put("befund", befund);
        datei.put("zusatz", CsvLeser.ZU_VIELE_BYTES);
        datei.put("zusatz_satz", CsvLeser.zusatz(CsvLeser.ZU_VIELE_BYTES));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", CsvLeser.DATEI_ZU_GROSS);
        body.put("message", ImportVorschau.satz(CsvLeser.DATEI_ZU_GROSS));
        body.put("datei", datei);
        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(body);
    }
}
