package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.GemeinsameSteuerungAbgelehnt;
import com.voltpilot.api.uems.GemeinsameSteuerungErklaerung;
import com.voltpilot.api.uems.GemeinsameSteuerungService;
import com.voltpilot.api.uems.GemeinsameSteuerungVorschau;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.web.dto.GemeinsameSteuerungDto;
import com.voltpilot.api.web.dto.GemeinsameSteuerungEinrichtenDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
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
 * <p>Der Körper von {@code PUT} ist {@code {"mitglieder": [{"box_id", "rolle", "messpunkt_id", "vorgabe_signal",
 * "geraete", "ungeregelt"}], "ungesteuerte_erzeuger", "vorbehalt"}} — alles außer {@code box_id}/{@code rolle}
 * wahlfrei. Die ERKLÄRUNG (§5.2 Fragen 4/5, {@link GemeinsameSteuerungErklaerung}) beginnt, sobald eines der Felder
 * {@code geraete}, {@code ungeregelt}, {@code ungesteuerte_erzeuger} oder {@code vorbehalt} steht; dann ist sie
 * vollständig oder 422. Jedes andere Feld — ausdrücklich ein Mandant, eine Anlage oder eine Schreibfreigabe — ist 400
 * {@code anfrage_ungueltig}: Mandant und Anlage kommen aus Anmeldung und Pfad, die Schreibfreigabe aus dem Bestand.
 */
@RestController
public class GemeinsameSteuerungController {

    private static final String PFAD = "/api/v1/sites/{siteId}/gemeinsame-steuerung";
    private static final Set<String> FELDER = Set.of("mitglieder", "ungesteuerte_erzeuger", "vorbehalt");
    private static final Set<String> FELDER_MITGLIED = Set.of("box_id", "rolle", "messpunkt_id", "vorgabe_signal",
            "geraete", "ungeregelt");
    private static final Set<String> FELDER_GERAET = Set.of("komponente_id", "richtung", "nenn_kw");
    private static final Set<String> FELDER_UNGEREGELT = Set.of("richtung", "hoechstwert_kw");
    private static final Set<String> FELDER_ERZEUGER = Set.of("bezeichnung", "nenn_kw");
    private static final Set<String> FELDER_RUECKFALL = Set.of("richtung", "rueckfall", "rueckfall_kw", "nach_s",
            "hinweis");

    private final GemeinsameSteuerungService dienst;
    private final GemeinsameSteuerungErklaerung erklaerung;
    private final RechtPruefung recht;
    private final GemeinsameSteuerungVorschau vorschau;

    public GemeinsameSteuerungController(GemeinsameSteuerungService dienst, GemeinsameSteuerungErklaerung erklaerung,
            RechtPruefung recht, GemeinsameSteuerungVorschau vorschau) {
        this.dienst = dienst;
        this.erklaerung = erklaerung;
        this.recht = recht;
        this.vorschau = vorschau;
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

    /**
     * Recht: heute lesend — keine eigene Kennung (wie {@code GET …/gemeinsame-steuerung}); der Zaun fragt
     * {@code RechtPruefung#pruefenLesen} an der Anlage. „Einrichten in sechs Fragen“ (§5.2): der Vorschlag aus dem
     * Bestand, die Erklärung und das Ergebnis (Frage 6). Ohne Gemeinsame Steuerung nur der Vorschlag — schreibt nie.
     */
    @GetMapping(PFAD + "/einrichten")
    public GemeinsameSteuerungEinrichtenDto.Einrichten einrichtenLesen(@PathVariable UUID siteId) {
        recht.pruefenLesen(RechtZiel.ANLAGE, siteId, GemeinsameSteuerungAbgelehnt::nichtGefunden);
        return erklaerung.lesen(siteId);
    }

    /** Recht: {@code funktion.steuern_einrichten} an der Anlage — einrichten oder ändern (S0/S1), mit der Erklärung. */
    @PutMapping(PFAD)
    @Recht(value = "funktion.steuern_einrichten", ziel = RechtZiel.ANLAGE)
    public GemeinsameSteuerungDto.Zustand einrichten(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return dienst.einrichten(siteId, mitglieder(body), erklaerung(body), akteur(auth));
    }

    /**
     * Recht: {@code funktion.steuern_einrichten} an der Anlage (wie einrichten) — Frage 6 für einen ENTWURF (§5.2 Nr. 6,
     * vor „Absenden“): derselbe Körper wie {@code PUT}, dieselben 400/409/422, die Antwort ist das Bild von
     * {@code GET …/einrichten} und der Zustand für diesen Entwurf. Schreibt nichts ({@link GemeinsameSteuerungVorschau}).
     */
    @PostMapping(PFAD + "/einrichten/vorschau")
    @Recht(value = "funktion.steuern_einrichten", ziel = RechtZiel.ANLAGE)
    public GemeinsameSteuerungEinrichtenDto.Vorschau einrichtenVorschau(@PathVariable UUID siteId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return vorschau.vorschau(siteId, mitglieder(body), erklaerung(body), akteur(auth));
    }

    /**
     * Recht: heute lesend — keine eigene Kennung; der Zaun fragt {@code RechtPruefung#pruefenLesen} an der Anlage. Die
     * Rückfall-Angaben einer Komponente der Anlage (IP-6), neueste zuerst; eine fremde Komponente ist 404.
     */
    @GetMapping(PFAD + "/komponenten/{komponenteId}/rueckfall")
    public List<GemeinsameSteuerungEinrichtenDto.RueckfallAngabe> rueckfallLesen(@PathVariable UUID siteId,
            @PathVariable UUID komponenteId) {
        recht.pruefenLesen(RechtZiel.ANLAGE, siteId, GemeinsameSteuerungAbgelehnt::nichtGefunden);
        return erklaerung.rueckfallVerlauf(siteId, komponenteId);
    }

    /**
     * Recht: {@code funktion.steuern_einrichten} an der Anlage (wie einrichten) — hinterlegen, was am Gerät als sicherer
     * Rückfallwert eingestellt ist (IP-6, G3): {@code {"richtung", "rueckfall", "rueckfall_kw", "nach_s", "hinweis"}}.
     */
    @PutMapping(PFAD + "/komponenten/{komponenteId}/rueckfall")
    @Recht(value = "funktion.steuern_einrichten", ziel = RechtZiel.ANLAGE)
    public List<GemeinsameSteuerungEinrichtenDto.RueckfallAngabe> rueckfallHinterlegen(@PathVariable UUID siteId,
            @PathVariable UUID komponenteId, @RequestBody(required = false) JsonNode body, Authentication auth) {
        objekt(body, FELDER_RUECKFALL, "Erwartet ist {\"richtung\", \"rueckfall\", …}.");
        Grenzart richtung = richtung(body.get("richtung"));
        GeraeteRueckfall wort = Arrays.stream(GeraeteRueckfall.values())
                .filter(g -> body.get("rueckfall") != null && g.code().equals(body.get("rueckfall").asText()))
                .findFirst().orElseThrow(() -> GemeinsameSteuerungAbgelehnt.anfrage("rueckfall ist haelt_letzten_wert, "
                        + "faellt_auf_wert, laeuft_frei oder unbekannt."));
        JsonNode nach = body.get("nach_s");
        if (nach != null && !nach.isNull() && !nach.canConvertToInt()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("nach_s ist eine ganze Zahl.");
        }
        return erklaerung.rueckfallHinterlegen(siteId, komponenteId, richtung, wort, zahl(body.get("rueckfall_kw"),
                false), nach == null || nach.isNull() ? null : nach.intValue(), text(body.get("hinweis")),
                akteur(auth));
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

    /**
     * Recht: {@code steuerung.starten_beenden} an der Anlage — eine Box scheidet aus (§5.5): Zweischritt, ihr Anteil
     * fällt auf den Rückfall ihrer Geräte; die anderen bekommen den Rest erst nach ihrer Quittung. 409
     * {@code fuehrende_box_bleibt} für die führende Box, solange eine andere mitsteuert.
     */
    @PostMapping(PFAD + "/mitglieder/{boxId}/ausscheiden")
    @Recht(value = "steuerung.starten_beenden", ziel = RechtZiel.ANLAGE)
    public GemeinsameSteuerungDto.Zustand ausscheiden(@PathVariable UUID siteId, @PathVariable UUID boxId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        leer(body);
        return dienst.ausscheiden(siteId, boxId, akteur(auth));
    }

    // ----------------------------------------------------------------------------- Gerüst

    /** Liest {@code mitglieder}; jedes andere Feld (Mandant, Anlage, …) ist 400. */
    static List<GemeinsameSteuerungDto.MitgliedWunsch> mitglieder(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Erwartet ist {\"mitglieder\": […]}.");
        }
        for (Iterator<String> it = body.fieldNames(); it.hasNext(); ) {
            String feld = it.next();
            if (!FELDER.contains(feld)) {
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
            JsonNode signal = m.get("vorgabe_signal");
            if (signal != null && !signal.isNull() && !signal.isTextual()) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("vorgabe_signal ist ja, nein oder unbekannt.");
            }
            out.add(new GemeinsameSteuerungDto.MitgliedWunsch(uuid(m.get("box_id"), true), text(m.get("rolle")),
                    uuid(m.get("messpunkt_id"), false), text(signal)));
        }
        return out;
    }

    /**
     * Liest die Erklärung (§5.2 Fragen 4/5) — {@code null}, wenn der Körper keines ihrer Felder trägt (nur die
     * Struktur, wie bisher). {@code ungesteuerte_erzeuger} ist dann Pflicht: {@code "keine"} oder eine nicht leere
     * Liste; fehlt es, nennt 422 die Lücke. Der Vorbehalt der Einspeiseseite folgt aus den Erzeugern (400, wenn er
     * erklärt wird).
     */
    static GemeinsameSteuerungErklaerung.Wunsch erklaerung(JsonNode body) {
        JsonNode liste = body.get("mitglieder");
        boolean erklaert = body.has("ungesteuerte_erzeuger") || body.has("vorbehalt");
        for (JsonNode m : liste) {
            erklaert |= m.has("geraete") || m.has("ungeregelt");
        }
        if (!erklaert) {
            return null;
        }
        Map<UUID, GemeinsameSteuerungErklaerung.BoxErklaerung> jeBox = new LinkedHashMap<>();
        for (JsonNode m : liste) {
            JsonNode geraete = m.get("geraete");
            JsonNode ungeregelt = m.get("ungeregelt");
            if (geraete == null) {
                if (ungeregelt != null) {
                    throw GemeinsameSteuerungAbgelehnt.anfrage("ungeregelt steht nur zusammen mit geraete.");
                }
                continue;
            }
            List<GemeinsameSteuerungErklaerung.Geraet> g = new ArrayList<>();
            for (JsonNode e : array(geraete, "geraete")) {
                objekt(e, FELDER_GERAET, "Ein Gerät ist {\"komponente_id\", \"richtung\", \"nenn_kw\"} — die "
                        + "Schreibfreigabe kommt aus dem Bestand.");
                g.add(new GemeinsameSteuerungErklaerung.Geraet(uuid(e.get("komponente_id"), true),
                        richtung(e.get("richtung")), zahl(e.get("nenn_kw"), true)));
            }
            List<GemeinsameSteuerungErklaerung.Ungeregelt> u = new ArrayList<>();
            if (ungeregelt != null) {
                for (JsonNode e : array(ungeregelt, "ungeregelt")) {
                    objekt(e, FELDER_UNGEREGELT, "Das Ungeregelte ist {\"richtung\", \"hoechstwert_kw\"}.");
                    u.add(new GemeinsameSteuerungErklaerung.Ungeregelt(richtung(e.get("richtung")),
                            zahl(e.get("hoechstwert_kw"), true)));
                }
            }
            jeBox.put(uuid(m.get("box_id"), true), new GemeinsameSteuerungErklaerung.BoxErklaerung(g, u));
        }
        List<GemeinsameSteuerungErklaerung.Erzeuger> erzeuger = null;
        JsonNode e = body.get("ungesteuerte_erzeuger");
        if (e != null) {
            if (e.isTextual() && GemeinsameSteuerungErklaerung.KEINE.equals(e.asText())) {
                erzeuger = List.of();
            } else if (e.isArray() && !e.isEmpty()) {
                erzeuger = new ArrayList<>();
                for (JsonNode z : e) {
                    objekt(z, FELDER_ERZEUGER, "Ein Erzeuger ist {\"bezeichnung\", \"nenn_kw\"}.");
                    erzeuger.add(new GemeinsameSteuerungErklaerung.Erzeuger(text(z.get("bezeichnung")),
                            zahl(z.get("nenn_kw"), true)));
                }
            } else {
                throw GemeinsameSteuerungAbgelehnt.anfrage("ungesteuerte_erzeuger ist „keine“ oder eine Liste — "
                        + "unbekannt ist keine Null.");
            }
        }
        BigDecimal bezug = null;
        JsonNode v = body.get("vorbehalt");
        if (v != null) {
            if (v.has("einspeisung_kw")) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Der Vorbehalt der Einspeiseseite folgt aus den "
                        + "ungesteuerten Erzeugern.");
            }
            objekt(v, Set.of("bezug_kw"), "Der Vorbehalt ist {\"bezug_kw\"}.");
            bezug = zahl(v.get("bezug_kw"), true);
        }
        return new GemeinsameSteuerungErklaerung.Wunsch(jeBox, erzeuger, bezug);
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

    private static void objekt(JsonNode n, Set<String> felder, String satz) {
        if (n == null || !n.isObject()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage(satz);
        }
        for (Iterator<String> it = n.fieldNames(); it.hasNext(); ) {
            String feld = it.next();
            if (!felder.contains(feld)) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Unbekanntes Feld „" + feld + "“. " + satz);
            }
        }
    }

    private static JsonNode array(JsonNode n, String feld) {
        if (!n.isArray()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage(feld + " ist eine Liste.");
        }
        return n;
    }

    private static Grenzart richtung(JsonNode n) {
        String code = text(n);
        if (Grenzart.EINSPEISUNG.code().equals(code)) {
            return Grenzart.EINSPEISUNG;
        }
        if (Grenzart.BEZUG.code().equals(code)) {
            return Grenzart.BEZUG;
        }
        throw GemeinsameSteuerungAbgelehnt.anfrage("richtung ist einspeisung oder bezug.");
    }

    private static BigDecimal zahl(JsonNode n, boolean pflicht) {
        if (n == null || n.isNull()) {
            if (pflicht) {
                throw GemeinsameSteuerungAbgelehnt.anfrage("Eine Leistung in kW fehlt.");
            }
            return null;
        }
        if (!n.isNumber()) {
            throw GemeinsameSteuerungAbgelehnt.anfrage("Eine Leistung ist eine Zahl in kW.");
        }
        return n.decimalValue();
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
