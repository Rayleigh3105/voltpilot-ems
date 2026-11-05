package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.werkstatt.LanNetz;
import com.voltpilot.api.werkstatt.WerkstattPruefungen;
import com.voltpilot.api.werkstatt.WerkstattRepository.Abnahme;
import com.voltpilot.api.werkstatt.DienstAnsichtService;
import com.voltpilot.api.werkstatt.LaufSeiteService;
import com.voltpilot.api.werkstatt.FreigabeRepository;
import com.voltpilot.api.werkstatt.FreigabeRepository.Abbild;
import com.voltpilot.api.werkstatt.FreigabeRepository.Programm;
import com.voltpilot.api.werkstatt.FreigabeService;
import com.voltpilot.api.werkstatt.WerkstattService;
import com.voltpilot.api.werkstatt.WerkstattService.Angelegt;
import com.voltpilot.api.werkstatt.WerkstattService.SchrittStand;
import com.voltpilot.api.werkstatt.WerkstattService.Stand;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Werkstatt unter {@code /api/v1/admin/werkstatt} (Entscheid des Kapitäns
 * vom 26.10.2026, erster Schnitt aus dem Bericht voltpilot-box-einrichtung-portal):
 * das Register der Boxen, die gerade eingerichtet werden oder wurden, ihre
 * Schritte, ihr LAN-Netz (Entscheid 6a) und die Abnahme nach der
 * Werkstatt-Regel ({@code edge-light/docs/mango.md}).
 *
 * <p><b>Nur VoltPilot-Admins</b>, klassenweit {@code hasRole('platform-admin')},
 * wie die Fernwartung. Eine Box in der Werkstatt gehört noch keinem Mandanten;
 * die Tabellen liest und schreibt nur {@code WerkstattRepository} an der
 * BYPASSRLS-Rolle.
 *
 * <p>Dazu die Freigabe der Werkstatt (Werkstatt-Automatik V1, WI-4 A):
 * {@code /freigaben} - „Werkstatt freigeben“ und „Freigabe beenden“. Lesen darf
 * sie außerdem der Werkstatt-Dienst in seinem eigenen Baum
 * ({@link WerkstattDienstController}); freigeben kann nur ein Admin.
 *
 * <p>Tunnel-Schlüssel und Fenster legt die Seite über die Routen der
 * Fernwartung an; hier entsteht davon nichts. Keine Route nimmt ein Passwort
 * an: das Root-Passwort der Box entsteht im Browser und bleibt dort.
 */
@RestController
@RequestMapping("/api/v1/admin/werkstatt")
@PreAuthorize("hasRole('platform-admin')")
public class AdminWerkstattController {

    // ── Antworten ─────────────────────────────────────────────────────────

    public record SchrittDto(String am, String von) {
        static SchrittDto of(SchrittStand s) {
            return new SchrittDto(s.am(), s.von());
        }
    }

    /**
     * Ein Abnahmeprotokoll. {@code probe} trägt das Fenster der Werkstatt-Probe
     * und was der Tunnel-Dienst dazu gemeldet hatte ({@code schluesselAbgeholtUm}
     * null = keine Meldung nannte es abgeholt): Anzeige, kein Beweis.
     */
    public record AbnahmeDto(UUID id, String edgeRef, String hostSchluessel, String fassung, String tunnelAdresse,
            String lanNetz, List<String> pruefungen, JsonNode probe, String notiz, Instant erfasstAm,
            String erfasstVon, String quelle, JsonNode belege, UUID freigabeId, UUID einloesungId,
            String passwortAge) {
    }

    /**
     * Eine Box des Registers; {@code abnahmen} neueste zuerst, leer = noch nicht abgenommen.
     * {@code inGebrauch}: was das Löschen sperrt (Abnahme, Kopplung), in Worten; leer = die Box
     * lässt sich mit {@code DELETE /boxen/{ref}} löschen. {@code loeschtMit}: was dabei mitgeht
     * (Tunnel-Schlüssel, Fenster, Codes, Geräteschlüssel, Zertifikatsanfrage). {@code kunde}: wer die Box über
     * den QR-Einstieg eingerichtet hat (Claim); null = noch kein Kunde.
     */
    public record BoxDto(UUID id, String edgeRef, String boxArt, String lanNetz, Map<String, SchrittDto> schritte,
            String notiz, Instant angelegtAm, String angelegtVon, Instant geaendertAm, List<AbnahmeDto> abnahmen,
            List<String> inGebrauch, List<String> loeschtMit, KundeDto kunde) {
    }

    /** Der Kunde einer Box: Mandant, Anlage (null = ohne Anlage) und seit wann sie zu ihm gehört. */
    public record KundeDto(String mandant, String anlage, Instant seit) {
    }

    /** Was die Seite vor allem anderen braucht: die geschlossene Liste der Prüfungen und den Vorschlag fürs LAN. */
    public record GrundlagenDto(List<String> pruefungen, String lanNetzVorschlag) {
    }

    /**
     * Eine Freigabe: {@code zustand} {@code laufend}, {@code beendet} oder
     * {@code abgelaufen}, {@code grund} in Worten, wenn sie nicht läuft.
     */
    public record FreigabeDto(UUID id, String kennung, String boxArt, Instant gueltigAb, Instant gueltigBis,
            int obergrenze, Abbild openwrt, Programm edgeLight, String notiz, Instant erteiltAm, String erteiltVon,
            Instant beendetAm, String beendetVon, String zustand, String grund) {
        static FreigabeDto of(FreigabeService.Stand st) {
            FreigabeRepository.Freigabe f = st.freigabe();
            return new FreigabeDto(f.id(), f.kennung(), f.boxArt(), f.gueltigAb(), f.gueltigBis(), f.obergrenze(),
                    f.openwrt(), f.edgeLight(), f.notiz(), f.erteiltAm(), name(f.erteiltVonName(), f.erteiltVon()),
                    f.beendetAm(), f.beendetVon() == null ? null : name(f.beendetVonName(), f.beendetVon()),
                    st.zustand(), st.grund());
        }
    }

    /** Der letzte Stand eines Laufs des Werkstatt-Dienstes. */
    public record LaufDto(String kennung, String freigabe, String boxArt, String zustand, String schritt, String titel,
            String grund, Instant beginn, Instant ende, Instant aktualisiertAm, JsonNode stand) {
        static LaufDto of(DienstAnsichtService.Lauf l) {
            return new LaufDto(l.kennung(), l.freigabe(), l.boxArt(), l.zustand(), l.schritt(), l.titel(), l.grund(),
                    l.beginn(), l.ende(), l.aktualisiertAm(), l.stand());
        }
    }

    /**
     * Was der Werkstatt-Dienst zuletzt gemeldet hat ({@code ansicht}, Vertrag
     * werkstatt-ansicht-v1) mit seinem Alter: {@code aktuell} ist false, wenn
     * die letzte Meldung älter als 60 s ist oder nie eine kam ({@code ansicht}
     * dann null). Dazu die letzten Läufe.
     */
    public record DienstDto(JsonNode ansicht, Instant gemeldetAm, Instant dienstZeit, Long alterSekunden,
            boolean aktuell, List<LaufDto> laeufe, List<ZurSeiteDto> zurSeite) {
    }

    /** Eine zur Seite gelegte Box (E2 A der Lauf-Seite): Fall, Lösung, Grund, wann, wer. */
    public record ZurSeiteDto(UUID id, String lauf, String box, String fall, String loesungTitel, String schritt,
            String grund, Instant gelegtAm, String gelegtVon) {
        static ZurSeiteDto of(LaufSeiteService.ZurSeite z) {
            return new ZurSeiteDto(z.id(), z.lauf(), z.box(), z.fall(), z.loesungTitel(), z.schritt(), z.grund(),
                    z.gelegtAm(), z.gelegtVon());
        }
    }

    /** Ein Auftrag an den Werkstatt-Dienst; er holt ihn mit seiner nächsten Meldung ab. */
    public record AuftragDto(UUID id, String art, String lauf, Instant erteiltAm) {
    }

    /** {@code lauf}: die Kennung des angehaltenen Laufs. */
    public record LaufRequest(@NotBlank String lauf) {
    }

    // ── Anfragen ──────────────────────────────────────────────────────────

    /** Werkstatt freigeben: Box-Art (Vorgabe mango), wie viele Tage ab jetzt, Obergrenze, Fassungen. */
    public record FreigabeRequest(String boxArt, Integer tage, Integer obergrenze, Abbild openwrt,
            Programm edgeLight, @Size(max = 500) String notiz) {
    }

    /** {@code schritte}: was vor dem Aufnehmen schon erledigt war. */
    public record BoxRequest(@NotBlank String edgeRef, String boxArt, List<String> schritte,
            @Size(max = 500) String notiz) {
    }

    public record SchrittRequest(@NotNull Boolean erledigt) {
    }

    public record LanNetzRequest(@NotBlank String lanNetz) {
    }

    public record AbnahmeRequest(String hostSchluessel, String fassung, List<String> pruefungen,
            UUID probeFensterId, @Size(max = 500) String notiz) {
    }

    private final WerkstattService service;
    private final FreigabeService freigaben;
    private final DienstAnsichtService ansichten;
    private final LaufSeiteService laufSeite;
    private final ObjectMapper json;

    public AdminWerkstattController(WerkstattService service, FreigabeService freigaben,
            DienstAnsichtService ansichten, LaufSeiteService laufSeite, ObjectMapper json) {
        this.service = service;
        this.freigaben = freigaben;
        this.ansichten = ansichten;
        this.laufSeite = laufSeite;
        this.json = json;
    }

    /** Was der Werkstatt-Dienst gerade tut (für die Werkstatt-Bildschirme). */
    @GetMapping("/dienst")
    public DienstDto dienst() {
        List<LaufDto> laeufe = ansichten.laeufe(30).stream().map(LaufDto::of).toList();
        List<ZurSeiteDto> zurSeite = laufSeite.zurSeite(50).stream().map(ZurSeiteDto::of).toList();
        return ansichten.gemeldet().map(g -> {
            long alter = Math.max(0, java.time.Duration.between(g.gemeldetAm(), ansichten.jetzt()).toSeconds());
            return new DienstDto(g.ansicht(), g.gemeldetAm(), g.dienstZeit(), alter,
                    alter <= DienstAnsichtService.AKTUELL.toSeconds(), laeufe, zurSeite);
        }).orElse(new DienstDto(null, null, null, null, false, laeufe, zurSeite));
    }

    /**
     * „Nochmal versuchen“ (E1 A der Lauf-Seite): ein Auftrag an den Werkstatt-Dienst,
     * den angehaltenen Lauf neu anzustoßen. 201 neu, 200 schon offen; 409, wenn der
     * Dienst sich nicht meldet, der Lauf nicht mehr der letzte ist oder der Dienst
     * ihn nicht als {@code nochmal_moeglich} meldet; 422 Form. Der Dienst löscht nie
     * etwas an einer Box; er tut, was das Abziehen des Kabels täte.
     */
    @PostMapping("/dienst/nochmal")
    public ResponseEntity<AuftragDto> nochmal(@Valid @RequestBody LaufRequest req, @AuthenticationPrincipal Jwt caller) {
        LaufSeiteService.Angelegt<LaufSeiteService.Auftrag> a = laufSeite.nochmal(req.lauf(), Akteur.aus(caller));
        LaufSeiteService.Auftrag x = a.wert();
        return ResponseEntity.status(a.neu() ? HttpStatus.CREATED : HttpStatus.OK)
                .body(new AuftragDto(x.id(), x.art(), x.lauf(), x.erteiltAm()));
    }

    /**
     * „Box zur Seite legen“ (E2 A): hält die Box mit Fall, Lösung, Grund und Zeit fest.
     * 201 neu, 200 schon zur Seite; 404 Lauf unbekannt; 409 nicht angehalten; 422 Form.
     * An der Box ändert sich nichts.
     */
    @PostMapping("/zur-seite")
    public ResponseEntity<ZurSeiteDto> zurSeite(@Valid @RequestBody LaufRequest req, @AuthenticationPrincipal Jwt caller) {
        LaufSeiteService.Angelegt<LaufSeiteService.ZurSeite> z = laufSeite.zurSeiteLegen(req.lauf(), Akteur.aus(caller));
        return ResponseEntity.status(z.neu() ? HttpStatus.CREATED : HttpStatus.OK).body(ZurSeiteDto.of(z.wert()));
    }

    @GetMapping("/grundlagen")
    public GrundlagenDto grundlagen() {
        return new GrundlagenDto(WerkstattPruefungen.ALLE, LanNetz.VORSCHLAG);
    }

    // ── Register ──────────────────────────────────────────────────────────

    @GetMapping("/boxen")
    public List<BoxDto> boxen() {
        return service.boxen().stream().map(this::boxDto).toList();
    }

    @GetMapping("/boxen/{ref}")
    public BoxDto box(@PathVariable String ref) {
        return boxDto(service.box(referenz(ref)));
    }

    /** Ins Register aufnehmen: 201 neu, 200 schon da (unverändert). */
    @PostMapping("/boxen")
    public ResponseEntity<BoxDto> anlegen(@Valid @RequestBody BoxRequest req, @AuthenticationPrincipal Jwt caller) {
        String edgeRef = referenz(req.edgeRef());
        if (!EdgeRef.isGeneratedFormat(edgeRef) && !service.referenzBekannt(edgeRef)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Referenz " + edgeRef + " ist weder eine Box-Referenz mit Prüfzeichen (edge-xxxxxxx) "
                            + "noch der Plattform als Gerät bekannt.");
        }
        Angelegt a = service.anlegen(edgeRef, req.boxArt(), req.schritte(), req.notiz(), Akteur.aus(caller));
        return ResponseEntity.status(a.neu() ? HttpStatus.CREATED : HttpStatus.OK).body(boxDto(a.stand()));
    }

    /**
     * Eine Box löschen (etwa einen Fehlversuch) samt Tunnel-Schlüssel, Codes und
     * Geräteschlüssel: 204; 404 nicht im Register, 409 mit dem Grund, wenn sie
     * abgenommen oder gekoppelt ist. Die Regeln stehen an {@link WerkstattService#loeschen}.
     */
    @DeleteMapping("/boxen/{ref}")
    public ResponseEntity<Void> loeschen(@PathVariable String ref, @AuthenticationPrincipal Jwt caller) {
        service.loeschen(referenz(ref), Akteur.aus(caller));
        return ResponseEntity.noContent().build();
    }

    @PutMapping("/boxen/{ref}/schritte/{schritt}")
    public BoxDto schritt(@PathVariable String ref, @PathVariable String schritt,
            @Valid @RequestBody SchrittRequest req, @AuthenticationPrincipal Jwt caller) {
        return boxDto(service.schritt(referenz(ref), schritt, req.erledigt(), Akteur.aus(caller)));
    }

    @PutMapping("/boxen/{ref}/lan-netz")
    public BoxDto lanNetz(@PathVariable String ref, @Valid @RequestBody LanNetzRequest req,
            @AuthenticationPrincipal Jwt caller) {
        return boxDto(service.lanNetz(referenz(ref), req.lanNetz(), Akteur.aus(caller)));
    }

    // ── Abnahme ───────────────────────────────────────────────────────────

    /** Das Abnahmeprotokoll anlegen: 201. Die Regeln stehen an {@link WerkstattService#abnahme}. */
    @PostMapping("/boxen/{ref}/abnahme")
    public ResponseEntity<AbnahmeDto> abnahme(@PathVariable String ref, @Valid @RequestBody AbnahmeRequest req,
            @AuthenticationPrincipal Jwt caller) {
        Abnahme a = service.abnahme(referenz(ref), req.hostSchluessel(), req.fassung(), req.pruefungen(),
                req.probeFensterId(), req.notiz(), Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(abnahmeDto(a));
    }

    // ── Freigabe ──────────────────────────────────────────────────────────

    /** Alle Freigaben, neueste zuerst. */
    @GetMapping("/freigaben")
    public List<FreigabeDto> freigaben() {
        return freigaben.alle().stream().map(FreigabeDto::of).toList();
    }

    /** Werkstatt freigeben: 201; 409, wenn für die Box-Art schon eine läuft; 422 mit Grund. */
    @PostMapping("/freigaben")
    public ResponseEntity<FreigabeDto> freigeben(@Valid @RequestBody FreigabeRequest req,
            @AuthenticationPrincipal Jwt caller) {
        FreigabeRepository.Freigabe f = freigaben.erteilen(new FreigabeService.Antrag(req.boxArt(), req.tage(),
                req.obergrenze(), req.openwrt(), req.edgeLight(), req.notiz()), Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(FreigabeDto.of(FreigabeService.stand(f, Instant.now())));
    }

    /** Freigabe beenden: 200; 404 unbekannt, 409 schon beendet. */
    @PostMapping("/freigaben/{kennung}/ende")
    public FreigabeDto freigabeBeenden(@PathVariable String kennung, @AuthenticationPrincipal Jwt caller) {
        FreigabeRepository.Freigabe f = freigaben.beenden(kennung, Akteur.aus(caller));
        return FreigabeDto.of(FreigabeService.stand(f, Instant.now()));
    }

    // ── intern ────────────────────────────────────────────────────────────

    private BoxDto boxDto(Stand s) {
        Map<String, SchrittDto> schritte = new java.util.LinkedHashMap<>();
        s.schritte().forEach((k, v) -> schritte.put(k, SchrittDto.of(v)));
        return new BoxDto(s.box().id(), s.box().edgeRef(), s.box().boxArt(), s.box().lanNetz(), schritte,
                s.box().notiz(), s.box().angelegtAm(), name(s.box().angelegtVonName(), s.box().angelegtVon()),
                s.box().geaendertAm(), s.abnahmen().stream().map(this::abnahmeDto).toList(), s.inGebrauch(), s.loeschtMit(),
                s.kunde() == null ? null : new KundeDto(s.kunde().mandant(), s.kunde().anlage(), s.kunde().seit()));
    }

    private AbnahmeDto abnahmeDto(Abnahme a) {
        return new AbnahmeDto(a.id(), a.edgeRef(), a.hostSchluessel(), a.fassung(), a.tunnelAdresse(), a.lanNetz(),
                liste(a.pruefungenJson()), lies(a.probeJson()), a.notiz(), a.erfasstAm(),
                name(a.erfasstVonName(), a.erfasstVon()), a.quelle(),
                a.belegeJson() == null ? null : lies(a.belegeJson()), a.freigabeId(), a.einloesungId(),
                a.passwortAge());
    }

    private JsonNode lies(String text) {
        try {
            return json.readTree(text == null ? "{}" : text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            return json.createObjectNode();
        }
    }

    private List<String> liste(String text) {
        JsonNode n = lies(text);
        if (!n.isArray()) {
            return List.of();
        }
        List<String> l = new java.util.ArrayList<>();
        n.forEach(e -> l.add(e.asText()));
        return l;
    }

    private static String name(String anzeige, String sub) {
        return anzeige == null || anzeige.isBlank() ? sub : anzeige;
    }

    /** Dieselbe Schreibweise wie Kopplung und Fernwartung; falsches Prüfzeichen = Tippfehler. */
    private static String referenz(String roh) {
        if (roh == null || roh.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Die Box-Referenz fehlt.");
        }
        String ref = DeviceController.canonicalExternalRef(roh);
        if (EdgeRef.isGeneratedFormat(ref) && !EdgeRef.isValid(ref)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Das Prüfzeichen von " + ref + " stimmt nicht - bitte die Referenz an der Box prüfen.");
        }
        return ref;
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
