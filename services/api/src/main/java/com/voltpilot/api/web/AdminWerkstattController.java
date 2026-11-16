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
import com.voltpilot.api.werkstatt.WerkstattOpenWrt;
import com.voltpilot.api.werkstatt.WerkstattRegel;
import com.voltpilot.api.werkstatt.WerkstattGehaeuseRepository;
import com.voltpilot.api.werkstatt.WerkstattService;
import com.voltpilot.api.werkstatt.WerkstattService.Angelegt;
import com.voltpilot.api.werkstatt.WerkstattService.SchrittStand;
import com.voltpilot.api.werkstatt.WerkstattService.Stand;
import com.voltpilot.api.werkstatt.WerkstattZubehoerDatei;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
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
 * <p>Dazu der Stand der Werkstatt ({@link WerkstattRegel}, seit 16.11.2026 ohne
 * Formular): {@code /regel} - läuft sie, was spielt sie auf (die neueste
 * Fassung), wie viele Boxen heute; {@code /anhalten} und {@code /fortsetzen}
 * mit Protokoll; {@code /freigaben} - der Verlauf der Freigaben als Beleg. Die
 * Freigabe, die gerade gilt, liest der Werkstatt-Dienst in seinem eigenen Baum
 * ({@link WerkstattDienstController}); anhalten kann nur ein Admin.
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
     * {@code dienstFassungVorEinrichtungWlan}: true, wenn ein Werkstatt-Dienst
     * vor S1 (PR #1885) ohne den Beleg {@code einrichtung_wlan_bereit}
     * angenommen wurde (Übergangsfrist, aus {@code belege} abgeleitet, keine
     * eigene Spalte).
     */
    public record AbnahmeDto(UUID id, String edgeRef, String hostSchluessel, String fassung, String tunnelAdresse,
            String lanNetz, List<String> pruefungen, JsonNode probe, String notiz, Instant erfasstAm,
            String erfasstVon, String quelle, JsonNode belege, UUID freigabeId, UUID einloesungId,
            String passwortAge, boolean dienstFassungVorEinrichtungWlan) {
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
            List<String> inGebrauch, List<String> loeschtMit, KundeDto kunde, GehaeuseDto gehaeuse) {
    }

    /** Der Kunde einer Box: Mandant, Anlage (null = ohne Anlage) und seit wann sie zu ihm gehört. */
    public record KundeDto(String mandant, String anlage, Instant seit) {
    }

    /**
     * Die Box-Druckdatei des Gehäuses (vp-mango-3mf-pro-box): mit Referenz in Klarschrift und
     * QR-Code im Unterteil, vom Werkstatt-Dienst nach einem Auftrag ohne Fehler hochgeladen.
     * {@code null} an {@link BoxDto#gehaeuse()}: noch keine Datei abgelegt (kein Lauf, zu alt,
     * oder noch in der alten internen Ablage des Dienstes).
     */
    public record GehaeuseDto(String name, String sha256, long bytes, Instant hochgeladenAm) {
        static GehaeuseDto of(WerkstattGehaeuseRepository.Stand s) {
            return new GehaeuseDto(s.name(), s.sha256(), s.bytes(), s.hochgeladenAm());
        }
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
            Instant beendetAm, String beendetVon, String zustand, String grund, String quelle, Long edgeReleaseSeq) {
        static FreigabeDto of(FreigabeService.Stand st) {
            FreigabeRepository.Freigabe f = st.freigabe();
            return new FreigabeDto(f.id(), f.kennung(), f.boxArt(), f.gueltigAb(), f.gueltigBis(), f.obergrenze(),
                    f.openwrt(), f.edgeLight(), f.notiz(), f.erteiltAm(), name(f.erteiltVonName(), f.erteiltVon()),
                    f.beendetAm(), f.beendetVon() == null ? null : name(f.beendetVonName(), f.beendetVon()),
                    st.zustand(), st.grund(), f.quelle(), f.edgeReleaseSeq());
        }
    }

    /** Ein Eintrag im Protokoll von Anhalten und Fortsetzen. */
    public record BetriebDto(boolean angehalten, String grund, Instant am, String von) {
        static BetriebDto of(FreigabeRepository.Betrieb b) {
            return new BetriebDto(b.angehalten(), b.grund(), b.am(), name(b.vonName(), b.von()));
        }
    }

    /**
     * Der Stand der Werkstatt: {@code zustand} {@code laeuft}, {@code angehalten}
     * oder {@code wartet}; {@code grund} in Worten, wenn sie nicht nach der Regel
     * läuft. {@code openwrt} steht fest im Code; {@code edgeLight} mit
     * {@code releaseSeq} ist die neueste Fassung, wenn sie passt.
     * {@code freigabe} ist die Kennung der Zeile, die der Dienst gerade bekommt
     * ({@code vonHand}: eine Freigabe von Hand im Übergang). {@code heute}:
     * verschiedene Boxen, die heute (Berliner Tag) eingelöst haben.
     * {@code verlauf}: Anhalten und Fortsetzen, neueste zuerst.
     */
    public record RegelDto(String zustand, String grund, String neueste, Abbild openwrt, Programm edgeLight,
            Long releaseSeq, String freigabe, boolean vonHand, int heute, int tagesgrenze, BetriebDto angehalten,
            List<BetriebDto> verlauf) {
        static RegelDto of(WerkstattRegel.Stand st, List<FreigabeRepository.Betrieb> verlauf) {
            WerkstattRegel.Soll soll = st.soll();
            FreigabeRepository.Freigabe f = st.freigabe();
            return new RegelDto(st.zustand().name().toLowerCase(java.util.Locale.ROOT), st.grund(), st.neueste(),
                    soll == null ? WerkstattOpenWrt.MANGO : soll.openwrt(), soll == null ? null : soll.edgeLight(),
                    soll == null ? null : soll.releaseSeq(), f == null ? null : f.kennung(), st.vonHand(),
                    st.heute(), st.tagesgrenze(), st.angehalten() == null ? null : BetriebDto.of(st.angehalten()),
                    verlauf.stream().map(BetriebDto::of).toList());
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

    /** Werkstatt anhalten: warum, wenn du es sagen magst. */
    public record AnhaltenRequest(@Size(max = 500) String grund) {
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
    private final WerkstattRegel regel;
    private final DienstAnsichtService ansichten;
    private final LaufSeiteService laufSeite;
    private final WerkstattGehaeuseRepository gehaeuseDateien;
    private final ObjectMapper json;

    public AdminWerkstattController(WerkstattService service, FreigabeService freigaben, WerkstattRegel regel,
            DienstAnsichtService ansichten, LaufSeiteService laufSeite, WerkstattGehaeuseRepository gehaeuseDateien,
            ObjectMapper json) {
        this.service = service;
        this.freigaben = freigaben;
        this.regel = regel;
        this.ansichten = ansichten;
        this.laufSeite = laufSeite;
        this.gehaeuseDateien = gehaeuseDateien;
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
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
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

    // ── Gehäuse-Druckdatei ────────────────────────────────────────────────

    /**
     * Die Box-Druckdatei herunterladen (vp-mango-3mf-pro-box): mit Referenz in Klarschrift und
     * QR-Code dieser Box. 404, solange der Werkstatt-Dienst sie noch nicht hochgeladen hat.
     */
    @GetMapping("/boxen/{ref}/gehaeuse")
    public ResponseEntity<byte[]> gehaeuseDatei(@PathVariable String ref) {
        String edgeRef = referenz(ref);
        WerkstattGehaeuseRepository.Datei d = gehaeuseDateien.datei(edgeRef)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Für " + edgeRef + " liegt noch keine Box-Druckdatei im Portal."));
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("model/3mf"))
                .contentLength(d.bytes())
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + d.name())
                .cacheControl(CacheControl.noStore())
                .body(d.daten());
    }

    /**
     * „Erneut erstellen“ für die Box-Druckdatei (Gehäuse, P10): ein Auftrag an den Werkstatt-Dienst,
     * ihren Bau noch einmal einzureihen - auch einen schon fertigen (Nachdruck, nach einem
     * behobenen Fehler). 201 neu, 200 schon offen; 422 Referenz. Der Dienst holt ihn mit seiner
     * nächsten Meldung der Ansicht ab (wie „Nochmal versuchen“ der Lauf-Seite).
     */
    @PostMapping("/boxen/{ref}/gehaeuse/neu")
    public ResponseEntity<AuftragDto> gehaeuseErneut(@PathVariable String ref, @AuthenticationPrincipal Jwt caller) {
        LaufSeiteService.Angelegt<LaufSeiteService.Auftrag> a = laufSeite.gehaeuseErneut(referenz(ref), Akteur.aus(caller));
        LaufSeiteService.Auftrag x = a.wert();
        return ResponseEntity.status(a.neu() ? HttpStatus.CREATED : HttpStatus.OK)
                .body(new AuftragDto(x.id(), x.art(), x.lauf(), x.erteiltAm()));
    }

    // ── Zubehör-Druckdateien (vp-werkstatt-zubehoer-download) ──────────────

    /**
     * Ein Zubehörteil herunterladen (Hutschienen-Clip, Bohrlehre): ohne Kennung, für jede Box
     * gleich - genau die eingecheckte Datei aus {@code edge-light/gehaeuse/.../druck/}
     * ({@link WerkstattZubehoerDatei}). 404 für ein unbekanntes Teil.
     */
    @GetMapping("/zubehoer/{teil}")
    public ResponseEntity<byte[]> zubehoerDatei(@PathVariable String teil) {
        WerkstattZubehoerDatei.Teil t = WerkstattZubehoerDatei.Teil.vonSlug(teil)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Unbekanntes Zubehörteil: " + teil));
        WerkstattZubehoerDatei.Datei d = WerkstattZubehoerDatei.lies(t);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("model/3mf"))
                .contentLength(d.daten().length)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + d.name())
                .cacheControl(CacheControl.noStore())
                .body(d.daten());
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

    // ── Stand der Werkstatt und Freigaben ────────────────────────────────

    /** Wie viele Einträge von Anhalten und Fortsetzen die Seite zeigt. */
    private static final int VERLAUF = 10;

    /** Läuft die Werkstatt, und was spielt sie auf? Legt nichts an. */
    @GetMapping("/regel")
    public RegelDto regel() {
        return RegelDto.of(regel.stand(), regel.verlauf(VERLAUF));
    }

    /** Werkstatt anhalten (Notfall): 200 mit dem Stand; ist sie schon angehalten, ändert sich nichts. */
    @PostMapping("/anhalten")
    public RegelDto anhalten(@Valid @RequestBody(required = false) AnhaltenRequest req,
            @AuthenticationPrincipal Jwt caller) {
        return RegelDto.of(regel.anhalten(req == null ? null : req.grund(), Akteur.aus(caller)),
                regel.verlauf(VERLAUF));
    }

    /** Werkstatt fortsetzen: 200 mit dem Stand; läuft sie schon, ändert sich nichts. */
    @PostMapping("/fortsetzen")
    public RegelDto fortsetzen(@AuthenticationPrincipal Jwt caller) {
        return RegelDto.of(regel.fortsetzen(Akteur.aus(caller)), regel.verlauf(VERLAUF));
    }

    /** Alle Freigaben (Regel und von Hand), neueste zuerst: der Beleg, was wann galt. */
    @GetMapping("/freigaben")
    public List<FreigabeDto> freigaben() {
        return freigaben.alle().stream().map(FreigabeDto::of).toList();
    }

    // ── intern ────────────────────────────────────────────────────────────

    private BoxDto boxDto(Stand s) {
        Map<String, SchrittDto> schritte = new java.util.LinkedHashMap<>();
        s.schritte().forEach((k, v) -> schritte.put(k, SchrittDto.of(v)));
        return new BoxDto(s.box().id(), s.box().edgeRef(), s.box().boxArt(), s.box().lanNetz(), schritte,
                s.box().notiz(), s.box().angelegtAm(), name(s.box().angelegtVonName(), s.box().angelegtVon()),
                s.box().geaendertAm(), s.abnahmen().stream().map(this::abnahmeDto).toList(), s.inGebrauch(), s.loeschtMit(),
                s.kunde() == null ? null : new KundeDto(s.kunde().mandant(), s.kunde().anlage(), s.kunde().seit()),
                gehaeuseDateien.stand(s.box().edgeRef()).map(GehaeuseDto::of).orElse(null));
    }

    private AbnahmeDto abnahmeDto(Abnahme a) {
        JsonNode belege = a.belegeJson() == null ? null : lies(a.belegeJson());
        boolean vorEinrichtungWlan = "dienst".equals(a.quelle()) && belege != null
                && !belege.has(WerkstattPruefungen.EINRICHTUNG_WLAN_BEREIT);
        return new AbnahmeDto(a.id(), a.edgeRef(), a.hostSchluessel(), a.fassung(), a.tunnelAdresse(), a.lanNetz(),
                liste(a.pruefungenJson()), lies(a.probeJson()), a.notiz(), a.erfasstAm(),
                name(a.erfasstVonName(), a.erfasstVon()), a.quelle(),
                belege, a.freigabeId(), a.einloesungId(),
                a.passwortAge(), vorEinrichtungWlan);
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
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
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
