package com.voltpilot.api.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonMappingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.voltpilot.api.uems.BerichtAbgelehnt;
import com.voltpilot.api.uems.BerichtAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.BerichtRegeln;
import com.voltpilot.api.uems.BerichtRepository.AnstossZeile;
import com.voltpilot.api.uems.BerichtRepository.Kopf;
import com.voltpilot.api.uems.BerichtRepository.StandZeile;
import com.voltpilot.api.uems.BerichtService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.BerichtDto;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Berichte (UEMS AP-12 IP-7, E4/E5/E7/E12) — Meilenstein „Bericht freigebbar“: anlegen, lesen, Entwurf, Vergleich, Freigabe,
 * Stand, Anstoß verwerfen, archivieren. Die Arbeit macht {@link BerichtService}.
 *
 * <p><b>Rechte — hier DURCHGESETZT</b> über {@code BerichtRechte} → {@code RechteAbleitung}: jede Route nennt ihre Kennungen
 * aus {@code docs/contracts/v2/rechte-matrix.json} — am Standort-Bericht {@code bericht.standort_abrufen} bzw.
 * {@code bericht.standort_freigeben}, am Unternehmens-Bericht {@code bericht.unternehmen} (G1). Fremd und fremder Standort
 * ist 404 {@code nicht_gefunden}, fehlendes Recht 403 {@code recht_fehlt}; der Unterstützer bekommt keinen Entwurf und keinen
 * Stand. Diese Ablehnungen gibt es nur an diesen Routen.
 *
 * <p><b>Die Anfrage wird streng gelesen:</b> ein JSON-Objekt, nur bekannte Felder, Text oder {@code null} — sonst 400
 * {@code anfrage_ungueltig} mit {@code feld}.
 */
@RestController
@RequestMapping("/api/v1")
public class BerichtController {

    private static final Pattern KENNUNG = Pattern.compile("^BR-[0-9]{4}-[0-9]{4,}$");
    private static final Pattern NR = Pattern.compile("^[1-9][0-9]{0,8}$");

    private final BerichtService dienst;
    private final ObjectMapper streng;

    public BerichtController(BerichtService dienst, ObjectMapper json) {
        this.dienst = dienst;
        this.streng = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }

    /**
     * Recht: {@code bericht.standort_abrufen} bzw. {@code bericht.unternehmen} je Bericht — die Liste zeigt nur, was die
     * Person lesen darf; wer nirgends einen Bericht lesen darf (der Unterstützer), bekommt 403.
     */
    @GetMapping("/berichte")
    public BerichtDto.Liste liste(Authentication auth) {
        return new BerichtDto.Liste(dienst.liste(OrtAnfrage.akteur(auth)).stream().map(BerichtController::form).toList());
    }

    /**
     * Recht: {@code bericht.standort_abrufen} bzw. {@code bericht.unternehmen} je Bericht — die Zeile „Freigegebene Berichte: …“
     * der Folgen-Karten (Fläche ändern, Anlage zuordnen, Archivieren; AP-12 IP-9) nennt nur Stände, die die Person lesen
     * darf; wer nirgends einen Bericht lesen darf, bekommt 403. {@code anlass} ist die Anstoß-Art einer Strukturänderung
     * (400 sonst); ein Objekt, das der Kundenbereich nicht kennt oder das nicht zur Art passt, ist 404 {@code nicht_gefunden}.
     * Schreibt nichts.
     */
    @GetMapping("/berichte/betroffen")
    public BerichtDto.Betroffen betroffen(@RequestParam(required = false) String objekt,
            @RequestParam(name = "gilt_ab", required = false) String giltAb, @RequestParam(required = false) String anlass,
            Authentication auth) {
        if (!STRUKTUR_ANLAESSE.contains(anlass)) {
            throw BerichtAbgelehnt.anfrage("anlass");
        }
        UUID id = uuid(objekt, "objekt");
        LocalDate ab = tag(giltAb, "gilt_ab");
        BerichtService.Betroffen b = dienst.betroffen(id, ab, anlass, OrtAnfrage.akteur(auth));
        return new BerichtDto.Betroffen(b.anlass(), b.giltAb().toString(), b.berichteVorhanden(),
                b.betroffen().stream().map(s -> new BerichtDto.StandRef(s.kennung(), s.nr())).toList(),
                b.zitieren().stream().map(s -> new BerichtDto.StandRef(s.kennung(), s.nr())).toList());
    }

    /** Recht: {@code bericht.standort_freigeben} bzw. {@code bericht.unternehmen} — Anlegen folgt dem Freigabe-Recht (G1). */
    @PostMapping("/berichte")
    public ResponseEntity<BerichtDto.Bericht> anlegen(@RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        BerichtDto.Anlegen b = lies(body, BerichtDto.Anlegen.class);
        pflicht(b.vorlage(), "vorlage");
        pflicht(b.geltungId(), "geltung_id");
        pflicht(b.zeitraum(), "zeitraum");
        return ResponseEntity.status(201).body(form(dienst.anlegen(b.vorlage(), b.geltungId(), b.zeitraum(), wer)));
    }

    /** Recht: {@code bericht.standort_abrufen} bzw. {@code bericht.unternehmen} — Kopf, Stände, Anstöße. */
    @GetMapping("/berichte/{kennung}")
    public BerichtDto.Detail detail(@PathVariable String kennung, Authentication auth) {
        BerichtService.Detail d = dienst.detail(kennung(kennung), OrtAnfrage.akteur(auth));
        return new BerichtDto.Detail(form(d.bericht()), d.staende().stream().map(BerichtController::kurz).toList(),
                d.anstoesse().stream().map(BerichtController::anstoss).toList());
    }

    /** Recht: {@code bericht.standort_abrufen} bzw. {@code bericht.unternehmen} — mit D4-Prüfung, nötigenfalls neu gebildet. */
    @GetMapping("/berichte/{kennung}/entwurf")
    public BerichtDto.Entwurf entwurf(@PathVariable String kennung, Authentication auth) {
        BerichtService.Entwurf e = dienst.entwurf(kennung(kennung), OrtAnfrage.akteur(auth));
        Kopf k = e.kopf();
        return new BerichtDto.Entwurf(k.kennung(), utc(e.entwurf().datenstand()), e.entwurf().gebildetVon(), e.neuGebildet(),
                e.entwurf().pruefsumme(), BerichtRegeln.kopf(e.entwurf().datenstand(), k.zone(), null, null, null),
                e.teilansicht(), e.entwurf().abzug());
    }

    /** Recht: {@code bericht.standort_abrufen} bzw. {@code bericht.unternehmen} — R1, der Entwurf gegen Stand Nr. {@code gegen}. */
    @GetMapping("/berichte/{kennung}/entwurf/vergleich")
    public BerichtDto.Vergleich vergleich(@PathVariable String kennung, @RequestParam(required = false) String gegen,
            Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        if (gegen == null || !NR.matcher(gegen).matches()) {
            throw BerichtAbgelehnt.anfrage("gegen");
        }
        BerichtService.Vergleich v = dienst.vergleich(k, Integer.parseInt(gegen), wer);
        return new BerichtDto.Vergleich(v.kopf().kennung(), v.gegen(), utc(v.entwurfDatenstand()), v.abweichungen().stream()
                .map(a -> new BerichtDto.Abweichung(a.quelle(), a.mengeArt(), dezimal(a.vorher()), dezimal(a.nachher()),
                        a.version(), a.anlass())).toList());
    }

    /**
     * Recht: {@code bericht.standort_freigeben} bzw. {@code bericht.unternehmen} — F1–F5: 201 mit dem neuen Stand, 200 für
     * dieselbe Freigabe noch einmal.
     */
    @PostMapping("/berichte/{kennung}/freigeben")
    public ResponseEntity<BerichtDto.Stand> freigeben(@PathVariable String kennung,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        BerichtDto.Freigeben b = lies(body, BerichtDto.Freigeben.class);
        pflicht(b.entwurfDatenstand(), "entwurf_datenstand");
        Instant datenstand;
        try {
            datenstand = OffsetDateTime.parse(b.entwurfDatenstand()).toInstant();
        } catch (DateTimeParseException e) {
            throw BerichtAbgelehnt.anfrage("entwurf_datenstand");
        }
        BerichtService.Freigabe f = dienst.freigeben(k, datenstand, wer);
        return ResponseEntity.status(f.neu() ? 201 : 200).body(stand(f.stand()));
    }

    /** Recht: {@code bericht.standort_abrufen} bzw. {@code bericht.unternehmen} — die Prüfsumme wird geprüft. */
    @GetMapping("/berichte/{kennung}/staende/{nr}")
    public BerichtDto.Stand stand(@PathVariable String kennung, @PathVariable String nr, Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        if (!NR.matcher(nr).matches()) {
            throw BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        return stand(dienst.stand(k, Integer.parseInt(nr), wer));
    }

    /**
     * Recht: {@code export.standort} bzw. {@code export.unternehmen} (G1) — der Berichts-CSV eines Stands in Kundenform
     * (DA3), jeder Abruf protokolliert (DA5); ein Entwurf hat keinen (EW4). Ablehnungen wie am Stand, als JSON.
     */
    @GetMapping("/berichte/{kennung}/staende/{nr}/csv")
    public ResponseEntity<byte[]> csv(@PathVariable String kennung, @PathVariable String nr, Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        if (!NR.matcher(nr).matches()) {
            throw BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        BerichtService.Datei datei = dienst.csv(k, Integer.parseInt(nr), wer);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + datei.name())
                .body(datei.inhalt());
    }

    /**
     * Recht: {@code bericht.standort_abrufen} bzw. {@code bericht.unternehmen} (G1: das PDF folgt dem Abrufen) — das PDF eines
     * Stands (DA2), server-seitig aus dem Abzug, byte-gleich bei jedem Abruf; jeder Abruf protokolliert (DA5); ein Entwurf hat
     * keins (EW4). Ablehnungen wie am Stand, als JSON — darum kein {@code produces}.
     */
    @GetMapping("/berichte/{kennung}/staende/{nr}/pdf")
    public ResponseEntity<byte[]> pdf(@PathVariable String kennung, @PathVariable String nr, Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        if (!NR.matcher(nr).matches()) {
            throw BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        BerichtService.Datei datei = dienst.pdf(k, Integer.parseInt(nr), wer);
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + datei.name())
                .body(datei.inhalt());
    }

    /** Recht: {@code bericht.standort_freigeben} bzw. {@code bericht.unternehmen} — R4, mit Begründung. */
    @PostMapping("/berichte/{kennung}/anstoesse/{id}/verwerfen")
    public BerichtDto.Anstoss verwerfen(@PathVariable String kennung, @PathVariable String id,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        BerichtDto.Verwerfen b = lies(body, BerichtDto.Verwerfen.class);
        return anstoss(dienst.verwerfen(k, id, b.begruendung(), wer).anstoss());
    }

    /** Recht: {@code bericht.standort_freigeben} bzw. {@code bericht.unternehmen} — Archivieren folgt dem Freigabe-Recht (G1). */
    @PostMapping("/berichte/{kennung}/archivieren")
    public BerichtDto.Bericht archivieren(@PathVariable String kennung, @RequestBody(required = false) JsonNode body,
            Authentication auth) {
        ProtokollAkteur wer = OrtAnfrage.akteur(auth);
        String k = kennung(kennung);
        if (body != null && !body.isNull() && !(body.isObject() && body.isEmpty())) {
            throw BerichtAbgelehnt.anfrage(body.isObject() ? body.fieldNames().next() : "");
        }
        return form(dienst.archivieren(k, wer));
    }

    // ------------------------------------------------------------------ Formen

    private static BerichtDto.Bericht form(BerichtService.Uebersicht u) {
        Kopf k = u.kopf();
        return new BerichtDto.Bericht(k.kennung(), k.vorlage(), k.vorlageFassung(), k.geltungArt(), text(k.geltungId()),
                k.geltungName(), k.zeitraumArt(), k.schluessel(),
                BerichtRegeln.zeitraum(k.zeitraumArt(), k.schluessel(), k.zone()).bezeichnung(), k.zeitzone(),
                new BerichtDto.Person(k.angelegtVonName(), null), utc(k.angelegtAm()), utc(k.archiviertAm()),
                u.standZeichen(), u.standText(), u.neuesteNr(), utc(u.entwurfDatenstand()));
    }

    private static BerichtDto.StandKurz kurz(StandZeile s) {
        return new BerichtDto.StandKurz(s.nr(), utc(s.datenstand()), utc(s.freigegebenAm()),
                new BerichtDto.Person(s.freigeberName(), s.freigeberRolle()), s.pruefsumme(), s.ersetztDurchNr(),
                text(s.anlassAnstossId()));
    }

    private static BerichtDto.Stand stand(BerichtService.Stand st) {
        Kopf k = st.kopf();
        StandZeile s = st.stand();
        return new BerichtDto.Stand(k.kennung(), s.nr(), utc(s.datenstand()), utc(s.freigegebenAm()),
                new BerichtDto.Person(s.freigeberName(), s.freigeberRolle()), s.pruefsumme(), true, s.ersetztDurchNr(),
                text(s.anlassAnstossId()), s.vorlageFassung(),
                BerichtRegeln.kopf(s.datenstand(), k.zone(), s.nr(), s.freigegebenAm(), s.freigeberName()), st.teilansicht(),
                s.darstellung(), s.regelwerk(), s.abzug());
    }

    private static BerichtDto.Anstoss anstoss(AnstossZeile a) {
        return new BerichtDto.Anstoss(a.id().toString(), a.nr(), a.art(), a.anlassKennung(), a.anlassFassung(),
                BerichtRegeln.anlass(a.anlassKennung()), utc(a.erkanntAm()), a.zustand(), a.erledigtDurchNr(),
                a.verworfenBegruendung(), a.verworfenVonName() == null ? null : new BerichtDto.Person(a.verworfenVonName(), null),
                utc(a.verworfenAm()));
    }

    private static OffsetDateTime utc(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static String text(UUID id) {
        return id == null ? null : id.toString();
    }

    private static String dezimal(java.math.BigDecimal d) {
        return d == null ? null : d.toPlainString();
    }

    /** Eine Kennung, die keine ist: dieselbe Antwort wie ein Bericht, den es nicht gibt. */
    private static String kennung(String text) {
        if (text == null || !KENNUNG.matcher(text).matches()) {
            throw BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        return text;
    }

    private static void pflicht(String wert, String feld) {
        if (wert == null || wert.isBlank()) {
            throw BerichtAbgelehnt.anfrage(feld);
        }
    }

    /** Die Anstoß-Arten einer Strukturänderung (Pfad 2) — die Werte von {@code anlass} an {@code /berichte/betroffen}. */
    private static final List<String> STRUKTUR_ANLAESSE = List.of(BerichtRegeln.ZUORDNUNG_RUECKWIRKEND,
            BerichtRegeln.ANLAGE_UMZUG_RUECKWIRKEND, BerichtRegeln.FLAECHE_RUECKWIRKEND, BerichtRegeln.VERTEILUNG_RUECKWIRKEND);

    private static UUID uuid(String wert, String feld) {
        pflicht(wert, feld);
        try {
            return UUID.fromString(wert);
        } catch (IllegalArgumentException e) {
            throw BerichtAbgelehnt.anfrage(feld);
        }
    }

    private static LocalDate tag(String wert, String feld) {
        pflicht(wert, feld);
        try {
            return LocalDate.parse(wert);
        } catch (DateTimeParseException e) {
            throw BerichtAbgelehnt.anfrage(feld);
        }
    }

    /** Der strenge Mapper: ein JSON-Objekt, nur bekannte Felder, Text oder {@code null}. */
    private <T> T lies(JsonNode body, Class<T> form) {
        if (body == null || !body.isObject()) {
            throw BerichtAbgelehnt.anfrage("");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = body.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            if (!f.getValue().isNull() && !f.getValue().isTextual()) {
                throw BerichtAbgelehnt.anfrage(f.getKey());
            }
        }
        try {
            return streng.treeToValue(body, form);
        } catch (UnrecognizedPropertyException e) {
            throw BerichtAbgelehnt.anfrage(e.getPropertyName());
        } catch (JsonMappingException e) {
            throw BerichtAbgelehnt.anfrage(e.getPath().isEmpty() ? "" : e.getPath().get(0).getFieldName());
        } catch (JsonProcessingException e) {
            throw BerichtAbgelehnt.anfrage("");
        }
    }

    /** {@code {code, message, …Fakten}} — Code, Status und Satz aus dem geschlossenen Satz bzw. der Regel. */
    @ExceptionHandler(BerichtAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(BerichtAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Kein lesbares JSON: dieselbe Form wie jede andere Ablehnung der Anfrage. */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> unlesbar(HttpMessageNotReadableException e) {
        return abgelehnt(BerichtAbgelehnt.anfrage(""));
    }
}
