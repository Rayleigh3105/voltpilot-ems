package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.BezugsgroesseAbgelehnt;
import com.voltpilot.api.uems.CsvLeser;
import com.voltpilot.api.uems.ImportVorschau;
import com.voltpilot.api.uems.ImportVorschauService;
import com.voltpilot.api.web.dto.BezugsdatenImportDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
 * Die Import-VORSCHAU der Bezugsdaten (UEMS AP-09 IP-12, Vertrag {@code docs/contracts/v2/bezugsdaten.md} §10 —
 * Regel {@code vorschau}). Die Arbeit macht {@link ImportVorschauService}, die Regeln {@link ImportVorschau}.
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

    public BezugsdatenImportController(ImportVorschauService vorschauen, ObjectMapper json) {
        this.vorschauen = vorschauen;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
    }

    /** Recht: {@code bezugsgroesse.importieren} (AP-09 §4.11 — Vorschau und Übernahme eines Imports). */
    @PostMapping(path = "/vorschau", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @Recht(value = "bezugsgroesse.importieren", ziel = RechtZiel.DIENST)
    public BezugsdatenImportDto.Vorschau vorschau(
            @RequestPart("datei") MultipartFile datei, @RequestPart("zuordnung") String zuordnung) throws IOException {
        ImportVorschau.Zuordnung z = zuordnung(zuordnung);
        return vorschauen.vorschau(datei.getBytes(), datei.getOriginalFilename(), z);
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
        if (a == null) {
            throw BezugsgroesseAbgelehnt.anfrage("zuordnung");
        }
        BezugsdatenImportDto.Csv c = a.csv();
        if (c != null && c.kodierung() != null && !CsvLeser.KODIERUNGEN.contains(c.kodierung())) {
            throw BezugsgroesseAbgelehnt.anfrage("csv.kodierung");
        }
        if (c != null && c.trennzeichen() != null && !CsvLeser.TRENNZEICHEN.contains(c.trennzeichen())) {
            throw BezugsgroesseAbgelehnt.anfrage("csv.trennzeichen");
        }
        BezugsdatenImportDto.Spalten s = a.spalten();
        ImportVorschau.Zuordnung z = new ImportVorschau.Zuordnung(
                c == null ? CsvLeser.Vorgabe.ERKENNEN : new CsvLeser.Vorgabe(c.kodierung(), c.trennzeichen(), c.kopfzeile()),
                s == null ? null : new ImportVorschau.Spalten(s.periode(), s.bis(), s.wert(), s.einheit(), s.bezug(), s.bemerkung()),
                a.deutung(), a.zahlformat(), leer(a.einheit()), leer(a.bezugsgroesse()),
                a.bezugTabelle() == null ? Map.of() : a.bezugTabelle(), a.synonyme() == null ? Map.of() : a.synonyme());
        String fehler = ImportVorschau.zuordnungFehler(z);
        if (fehler != null) {
            throw BezugsgroesseAbgelehnt.anfrage(fehler);
        }
        return z;
    }

    private static String pfad(JsonMappingException e) {
        List<String> teile = e.getPath().stream()
                .map(r -> r.getFieldName() != null ? r.getFieldName() : String.valueOf(r.getIndex())).toList();
        return teile.isEmpty() ? "zuordnung" : String.join(".", teile);
    }

    private static String leer(String text) {
        return text == null || text.isBlank() ? null : text;
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
