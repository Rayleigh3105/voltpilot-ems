package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.KennzahlAbgelehnt;
import com.voltpilot.api.uems.MassnahmeBewertung;
import com.voltpilot.api.uems.MassnahmeService;
import com.voltpilot.api.uems.MassnahmeWirkung;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.VerbesserungAbgelehnt;
import com.voltpilot.api.uems.VorgangAntwort;
import com.voltpilot.api.web.dto.MassnahmeDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
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
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Maßnahmen (UEMS AP-18 IP-10, M1–M4, M6, M7, RE1–RE3): anlegen mit oder ohne Messgrundlage, lesen, ändern solange
 * geplant, Verantwortlicher, umgesetzt melden, verwerfen, Kommentare. Die Arbeit macht {@link MassnahmeService}; die
 * Wirkung liest {@link MassnahmeWirkung} (IP-11, WK1–WK5), die Bewertung als Stand Nr. n {@link MassnahmeBewertung}
 * (IP-12, WK6).
 *
 * <p><b>Rechte:</b> Schreibrouten {@code verbesserung.verwalten} an der Geltung der Kennzahl bzw. am Standort der
 * Maßnahme (403 {@code recht_fehlt}), bewerten {@code verbesserung.abschliessen} ebenda; Lesen {@code verbesserung.ansehen} als Kennung im Kommentar — die Sichtbarkeit
 * kommt über {@code standort_id} (RLS) und die Kennzahl, außerhalb 404.
 */
@RestController
@RequestMapping("/api/v1/massnahmen")
public class MassnahmeController {

    private final MassnahmeService massnahmen;
    private final MassnahmeWirkung wirkung;
    private final MassnahmeBewertung bewertung;
    private final VorgangAntwort antwort;
    private final ObjectMapper streng;

    public MassnahmeController(MassnahmeService massnahmen, MassnahmeWirkung wirkung, MassnahmeBewertung bewertung,
            VorgangAntwort antwort, ObjectMapper json) {
        this.massnahmen = massnahmen;
        this.wirkung = wirkung;
        this.bewertung = bewertung;
        this.antwort = antwort;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code verbesserung.ansehen} (Zaun über Standort und Kennzahl). Das Register; {@code zustand}
     * ({@code geplant · umgesetzt · bewertet · verworfen}), {@code ueberfaellig} ({@code true · false}, Operation
     * {@code frist} beim Abruf), {@code kennzahl} und {@code einsatz} (IDs) filtern.
     */
    @GetMapping
    public MassnahmeDto.Liste liste(@RequestParam(required = false) String zustand,
            @RequestParam(required = false) String ueberfaellig, @RequestParam(required = false) String kennzahl,
            @RequestParam(required = false) String einsatz, HttpServletRequest anfrage) {
        return massnahmen.liste(anfrage.getParameterMap().keySet(), zustand, ueberfaellig, kennzahl, einsatz);
    }

    /**
     * Recht: {@code verbesserung.verwalten} an der Geltung der Kennzahl bzw. am gewählten Standort. Legt M-JJJJ-nnnn
     * an; mit Messgrundlage die Ausgangslage als Kopie des Vergleich-Lesers mit Prüfsumme, ohne Messgrundlage ist
     * eine Zahl der erwarteten Wirkung 422 {@code ohne_messgrundlage}; der Verantwortliche ist ein aktives Konto
     * (422 {@code benutzer_unbekannt}).
     */
    @PostMapping
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<MassnahmeDto.Massnahme> anlegen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        MassnahmeDto.Massnahme neu = massnahmen.anlegen(lies(body, MassnahmeDto.Anlegen.class), akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/massnahmen/" + neu.id())).body(neu);
    }

    /** Recht: {@code verbesserung.ansehen}. Die Maßnahme mit Verlauf; außerhalb der Sicht 404. */
    @GetMapping("/{id}")
    public MassnahmeDto.Massnahme eine(@PathVariable UUID id) {
        return massnahmen.eine(id);
    }

    /**
     * Recht: {@code verbesserung.ansehen}. Die Wirkung (WK1–WK5): Nachher-Monate ab dem Monat nach {@code umgesetzt_am}
     * ({@code monate} 12 … 36, Vorgabe 12, sonst 400), je Monat der Vergleich gegen die Fassung am letzten Tag, der
     * Umsetzungsmonat „nicht gezählt“, Σ ÷ Σ über die bewertbaren, Ausschlüsse mit Grund, „x von N“, „vorläufig“; ohne
     * Messgrundlage nur der Satz. Ein Leser, kein gespeicherter Wert; außerhalb der Sicht 404.
     */
    @GetMapping("/{id}/wirkung")
    public MassnahmeDto.Wirkung wirkung(@PathVariable UUID id, @RequestParam(required = false) String monate,
            HttpServletRequest anfrage) {
        return wirkung.lesen(id, anfrage.getParameterMap().keySet(), monate);
    }

    /**
     * Recht: {@code verbesserung.verwalten}. Titel, Termin und erwartete Wirkung, solange geplant (sonst 409
     * {@code massnahme_nicht_geplant}), mit Begründung — eine Zeile im Verlauf.
     */
    @PutMapping("/{id}")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme aendern(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return massnahmen.aendern(id, lies(body, MassnahmeDto.Aendern.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Setzt den Verantwortlichen (aktives Konto) mit Begründung. */
    @PutMapping("/{id}/verantwortlicher")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme verantwortlicher(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return massnahmen.verantwortlicher(id, lies(body, MassnahmeDto.Verantwortlicher.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Umgesetzt am Tag (nie in der Zukunft) mit Begründung — einmalig. */
    @PostMapping("/{id}/umgesetzt")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme umgesetzt(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return massnahmen.umgesetzt(id, lies(body, MassnahmeDto.Umgesetzt.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Verwirft die geplante Maßnahme mit Begründung — endgültig. */
    @PostMapping("/{id}/verwerfen")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme verwerfen(@PathVariable UUID id, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return massnahmen.verwerfen(id, lies(body, MassnahmeDto.Verwerfen.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.verwalten}. Ein Kommentar im Verlauf (geplant oder umgesetzt). */
    @PostMapping("/{id}/eintraege")
    @Recht(value = "verbesserung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<MassnahmeDto.Massnahme> eintrag(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(massnahmen.eintrag(id, lies(body, MassnahmeDto.NeuerEintrag.class), akteur(auth)));
    }

    /** Recht: {@code verbesserung.ansehen}. Alle Stände der Bewertung nach Nr. (WK6); außerhalb der Sicht 404. */
    @GetMapping("/{id}/bewertungen")
    public MassnahmeDto.Bewertungen bewertungen(@PathVariable UUID id) {
        return bewertung.liste(id);
    }

    /**
     * Recht: {@code verbesserung.abschliessen} an der Geltung der Kennzahl bzw. am Standort. Bewertet die umgesetzte
     * Maßnahme (sonst 409 {@code massnahme_nicht_umgesetzt}) als Stand Nr. n: Ergebnis
     * {@code belegt · nicht_belegt · nicht_messbar}, Begründung 10–500 Zeichen, Kopie der Wirkung mit Prüfsumme (WK6);
     * ohne Messgrundlage nur {@code nicht_messbar} (422 {@code ohne_messgrundlage}); mit Vier-Augen 409
     * {@code vieraugen_beantragen}. Ein weiterer Stand ist Nr. n + 1 — der alte bleibt.
     */
    @PostMapping("/{id}/bewertungen")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public ResponseEntity<MassnahmeDto.Massnahme> bewerten(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(bewertung.bewerten(id, lies(body, MassnahmeDto.Bewerten.class), akteur(auth)));
    }

    /**
     * Recht: {@code verbesserung.abschliessen}. Mit Vier-Augen beantragt die erste Person den Stand Nr. n (Ergebnis,
     * Begründung, Kopie mit Prüfsumme); ohne Vier-Augen 409 {@code vieraugen_aus}; ein offener Antrag 409
     * {@code bewertung_beantragt}.
     */
    @PostMapping("/{id}/bewertungen/beantragen")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public ResponseEntity<MassnahmeDto.Massnahme> bewertungBeantragen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(bewertung.beantragen(id, lies(body, MassnahmeDto.Bewerten.class), akteur(auth)));
    }

    /**
     * Recht: {@code verbesserung.abschliessen}. Die zweite Person (KA/EM) bestätigt den Antrag; wer beantragt hat, 422
     * {@code vieraugen_urheber}; der Verantwortliche der Maßnahme 422 {@code vieraugen_verantwortlich}; ohne Antrag 409
     * {@code bewertung_nicht_beantragt}.
     */
    @PostMapping("/{id}/bewertungen/freigeben")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme bewertungFreigeben(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return bewertung.freigeben(id, lies(body, MassnahmeDto.Entscheid.class), akteur(auth));
    }

    /** Recht: {@code verbesserung.abschliessen}. Die zweite Person lehnt den Antrag mit Begründung ab. */
    @PostMapping("/{id}/bewertungen/ablehnen")
    @Recht(value = "verbesserung.abschliessen", ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme bewertungAblehnen(@PathVariable UUID id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return bewertung.ablehnen(id, lies(body, MassnahmeDto.Entscheid.class), akteur(auth));
    }

    /**
     * Recht: {@code verbesserung.verwalten} bzw. {@code verbesserung.abschliessen} (für {@code neu_bewertet}) an der
     * Geltung der Kennzahl oder am Standort. Die Antwort auf einen Anstoß am Vorgang (IP-17, M5) — einmalig (409
     * {@code anstoss_beantwortet}): {@code bleibt} mit Begründung · {@code neu_kopiert} (nur
     * {@code ausgangslage_korrigiert}: Ausgangslage neu aus dem Leser, die alte im Protokoll) · {@code neu_bewertet}
     * mit {@code ergebnis} (Stand Nr. n + 1, bei Vier-Augen als Antrag); was nicht zur Art passt, 422
     * {@code antwort_passt_nicht}. Ein Anstoß eines anderen Vorgangs 404.
     */
    @PostMapping("/{id}/anstoesse/{aid}/antwort")
    @Recht(value = {"verbesserung.verwalten", "verbesserung.abschliessen"}, ziel = RechtZiel.DIENST)
    public MassnahmeDto.Massnahme anstossAntwort(@PathVariable UUID id, @PathVariable UUID aid,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return antwort.massnahme(id, aid, lies(body, MassnahmeDto.AnstossAntwort.class), akteur(auth));
    }

    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || body.isNull()) {
            body = streng.createObjectNode();
        }
        if (!body.isObject()) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw VerbesserungAbgelehnt.anfrage(e.getPropertyName());
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
    }

    private static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(VerbesserungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(VerbesserungAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Die Kennzahl bzw. der Standort lehnt ab (404 außerhalb der Sicht, 403 ohne Recht an der Geltung). */
    @ExceptionHandler(KennzahlAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> kennzahl(KennzahlAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine Maßnahme, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new VerbesserungAbgelehnt(404, "nicht_gefunden", "Diese Maßnahme gibt es nicht.", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(VerbesserungAbgelehnt.anfrage(""));
    }
}
