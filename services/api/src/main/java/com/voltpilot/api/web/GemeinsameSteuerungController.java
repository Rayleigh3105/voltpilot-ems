package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.GemeinsameSteuerungAbgelehnt;
import com.voltpilot.api.uems.GemeinsameSteuerungService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Gemeinsame Steuerung einer Anlage für den Kunden (UEMS AP-15 IP-5, Konzept §5.2, §5.5, I5): lesen, einrichten
 * bzw. ändern, anhalten, fortsetzen, auflösen. Scharfschalten und Mitglied bestätigen sind Handgriffe des Betreibers
 * und liegen NICHT hier, sondern unter {@code /api/v1/admin} ({@link AdminGemeinsameSteuerungController}) — der Kunde
 * schaltet nicht scharf (W9). Die Arbeit macht {@link GemeinsameSteuerungService}.
 *
 * <p><b>Rechte (AP-03 IP-6/IP-7):</b> Einrichten ist {@code funktion.steuern_einrichten}, anhalten · fortsetzen ·
 * auflösen sind Rahmen ({@code steuerung.starten_beenden}, nur Kundenadministrator) — je Route an der Anlage. Lesen
 * trägt keine eigene Kennung; eine Anlage außerhalb des Zugriffs ist dieselbe 404 wie eine unbekannte. Jede Route nennt
 * im Kommentar ihre Kennung aus {@code docs/contracts/v2/rechte-matrix.json}.
 *
 * <p>Der Körper von {@code PUT} ist {@code {"mitglieder": [{"box_id", "rolle", "messpunkt_id"}]}}. Jedes andere Feld —
 * ausdrücklich ein Mandant oder eine Anlage — ist 400 {@code anfrage_ungueltig}: beide kommen aus Anmeldung und Pfad.
 */
@RestController
public class GemeinsameSteuerungController {

    private static final String PFAD = "/api/v1/sites/{siteId}/gemeinsame-steuerung";
    private static final Set<String> FELDER_MITGLIED = Set.of("box_id", "rolle", "messpunkt_id");

    private final GemeinsameSteuerungService dienst;
    private final RechtPruefung recht;

    public GemeinsameSteuerungController(GemeinsameSteuerungService dienst, RechtPruefung recht) {
        this.dienst = dienst;
        this.recht = recht;
    }

    /**
     * Recht: heute lesend — keine eigene Kennung (wie das Standort-Lesemodell); der Zaun fragt
     * {@code RechtPruefung#pruefenLesen} an der Anlage — außerhalb dieselbe Antwort wie eine unbekannte (404). Ohne
     * Gemeinsame Steuerung: „nicht eingerichtet“ und die Warnung Z1, sonst nichts.
     */
    @GetMapping(PFAD)
    public GemeinsameSteuerungDto.Zustand lesen(@PathVariable UUID siteId) {
        recht.pruefenLesen(RechtZiel.ANLAGE, siteId, GemeinsameSteuerungAbgelehnt::nichtGefunden);
        return dienst.lesen(siteId);
    }

    /** Recht: {@code funktion.steuern_einrichten} an der Anlage — einrichten oder ändern (S0/S1). */
    @PutMapping(PFAD)
    @Recht(value = "funktion.steuern_einrichten", ziel = RechtZiel.ANLAGE)
    public GemeinsameSteuerungDto.Zustand einrichten(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return dienst.einrichten(siteId, mitglieder(body), akteur(auth));
    }

    /** Recht: {@code steuerung.starten_beenden} an der Anlage — anhalten (I5); die Anteile bleiben in Kraft. */
    @PostMapping(PFAD + "/anhalten")
    @Recht(value = "steuerung.starten_beenden", ziel = RechtZiel.ANLAGE)
    public GemeinsameSteuerungDto.Zustand anhalten(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        leer(body);
        return dienst.anhalten(siteId, akteur(auth));
    }

    /**
     * Recht: {@code steuerung.starten_beenden} an der Anlage — fortsetzen nach dem Anhalten, Bedingungen erneut; nach
     * einem Anhalten des Betreibers 409 {@code vom_betreiber_angehalten} (dann fortsetzen nur über {@code /admin}).
     */
    @PostMapping(PFAD + "/fortsetzen")
    @Recht(value = "steuerung.starten_beenden", ziel = RechtZiel.ANLAGE)
    public GemeinsameSteuerungDto.Zustand fortsetzen(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        leer(body);
        return dienst.fortsetzen(siteId, akteur(auth));
    }

    /** Recht: {@code steuerung.starten_beenden} an der Anlage — auflösen, solange keine Anteile in Kraft sind. */
    @PostMapping(PFAD + "/aufloesen")
    @Recht(value = "steuerung.starten_beenden", ziel = RechtZiel.ANLAGE)
    public GemeinsameSteuerungDto.Zustand aufloesen(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        leer(body);
        return dienst.aufloesen(siteId, akteur(auth));
    }

    // ----------------------------------------------------------------------------- Gerüst

    /** Liest {@code mitglieder}; jedes andere Feld (Mandant, Anlage, …) ist 400. */
    static List<GemeinsameSteuerungDto.MitgliedWunsch> mitglieder(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Erwartet ist {\"mitglieder\": […]}.");
        }
        for (Iterator<String> it = body.fieldNames(); it.hasNext(); ) {
            String feld = it.next();
            if (!"mitglieder".equals(feld)) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Unbekanntes Feld „" + feld
                        + "“ — Mandant und Anlage kommen aus Anmeldung und Pfad.");
            }
        }
        JsonNode liste = body.get("mitglieder");
        if (liste == null || !liste.isArray()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Erwartet ist {\"mitglieder\": […]}.");
        }
        List<GemeinsameSteuerungDto.MitgliedWunsch> out = new ArrayList<>();
        for (JsonNode m : liste) {
            if (!m.isObject()) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Jedes Mitglied ist ein Objekt.");
            }
            for (Iterator<String> it = m.fieldNames(); it.hasNext(); ) {
                String feld = it.next();
                if (!FELDER_MITGLIED.contains(feld)) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("Unbekanntes Feld „" + feld + "“ an einem Mitglied.");
                }
            }
            out.add(new GemeinsameSteuerungDto.MitgliedWunsch(uuid(m.get("box_id"), true), text(m.get("rolle")),
                    uuid(m.get("messpunkt_id"), false)));
        }
        return out;
    }

    /** Ein Übergang braucht keinen Körper; ein Körper mit Feldern ist 400 (Mandant/Anlage nie aus dem Körper). */
    static void leer(JsonNode body) {
        if (body != null && !body.isNull() && !(body.isObject() && body.isEmpty())) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Dieser Übergang erwartet keinen Körper.");
        }
    }

    private static UUID uuid(JsonNode n, boolean pflicht) {
        if (n == null || n.isNull()) {
            if (pflicht) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Jedes Mitglied braucht box_id und rolle.");
            }
            return null;
        }
        try {
            return UUID.fromString(n.asText());
        } catch (IllegalArgumentException e) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Keine gültige Kennung: " + n.asText());
        }
    }

    private static String text(JsonNode n) {
        return n == null || !n.isTextual() ? null : n.asText();
    }

    static ProtokollAkteur akteur(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }

    /** {@code {code, message[, fehlt]}}. */
    @ExceptionHandler(GemeinsameSteuerungAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(GemeinsameSteuerungAbgelehnt e) {
        return ResponseEntity.status(e.status()).body(e.body());
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(GemeinsameSteuerungAbgelehnt.nichtGefunden());
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(GemeinsameSteuerungAbgelehnt.anfrage("Die Anfrage ist nicht lesbar."));
    }
}
