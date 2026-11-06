package com.voltpilot.api.web;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.werkstatt.DienstAnsichtService;
import com.voltpilot.api.werkstatt.LaufSeiteService;
import com.voltpilot.api.werkstatt.EinloesungRepository;
import com.voltpilot.api.werkstatt.EinloesungService;
import com.voltpilot.api.werkstatt.FreigabeRepository.Freigabe;
import com.voltpilot.api.werkstatt.FreigabeService;
import com.voltpilot.api.werkstatt.WerkstattGehaeuseRepository;
import com.voltpilot.api.werkstatt.WerkstattRepository;
import com.voltpilot.api.werkstatt.WerkstattService;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Baum des Werkstatt-Dienstes ({@code services/werkstatt-dienst}) unter
 * {@code /api/v1/werkstatt-dienst}: nur das Dienstkonto mit der Rolle
 * {@code werkstatt-dienst} (Keycloak-Client {@code voltpilot-werkstatt-dienst},
 * nur client_credentials). Bewusst ein EIGENER Baum außerhalb von
 * {@code /api/v1/admin/**}, wie beim Tunnel-Dienst: Die Rolle erreicht dort
 * nichts, und kein Admin- oder Kunden-Token erreicht diesen Baum
 * ({@code SecurityConfig}).
 *
 * <p>Der Dienst darf hier lesen, ob und welche Freigabe läuft; in einer
 * laufenden Freigabe Einmal-Codes für ungekoppelte Boxen holen; lesen, was eine
 * Box beim Einlösen gemeldet hat; und das Probe-Fenster schließen, das eine
 * Einlösung geöffnet hat - kein anderes. Freigeben, Fenster öffnen, Kunden,
 * Kopplung und Updates erreicht er nicht.
 */
@RestController
@RequestMapping("/api/v1/werkstatt-dienst")
@PreAuthorize("hasRole('werkstatt-dienst')")
public class WerkstattDienstController {

    /** Schema der Freigabe, wie der Dienst sie liest (Go: internal/freigabe, Schema). */
    public static final String SCHEMA = "vp-werkstatt-freigabe.v1";

    /** Das OpenWrt-Abbild im Format des Dienstes. */
    public record AbbildDto(String fassung, String datei, String sha256, String quelle) {
    }

    /** Die Edge-Light-Fassung im Format des Dienstes. */
    public record ProgrammDto(String fassung, String quelle,
            @JsonProperty("programm_sha256") String programmSha256,
            @JsonProperty("skripte_sha256") String skripteSha256) {
    }

    /**
     * Die laufende Freigabe, Feld für Feld wie die Datei der Werkstatt in V1a
     * ({@code freigabe.json}, Schema {@value #SCHEMA}): {@code erteilt_am} ist
     * der Beginn der Gültigkeit.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record FreigabeDto(String schema, String kennung, @JsonProperty("box_art") String boxArt,
            @JsonProperty("erteilt_von") String erteiltVon, @JsonProperty("erteilt_am") Instant erteiltAm,
            @JsonProperty("gueltig_bis") Instant gueltigBis, @JsonProperty("beendet_am") Instant beendetAm,
            int obergrenze, AbbildDto openwrt, @JsonProperty("edge_light") ProgrammDto edgeLight) {
        static FreigabeDto of(Freigabe f) {
            String von = f.erteiltVonName() == null || f.erteiltVonName().isBlank() ? f.erteiltVon() : f.erteiltVonName();
            return new FreigabeDto(SCHEMA, f.kennung(), f.boxArt(), von, f.gueltigAb(), f.gueltigBis(), f.beendetAm(),
                    f.obergrenze(),
                    new AbbildDto(f.openwrt().fassung(), f.openwrt().datei(), f.openwrt().sha256(), f.openwrt().quelle()),
                    new ProgrammDto(f.edgeLight().fassung(), f.edgeLight().quelle(), f.edgeLight().programmSha256(),
                            f.edgeLight().skripteSha256()));
        }
    }

    /** Code holen: für genau diese Box; {@code tausch} nur für eine neu aufgespielte, ungekoppelte Box. */
    public record CodeRequest(String edgeRef, Boolean tausch) {
    }

    /** Der Code steht nur in dieser Antwort und nur einmal. */
    public record CodeDto(String code, String edgeRef, String freigabe, Instant gueltigBis, boolean tausch) {
    }

    /** Was eine Box beim Einlösen gemeldet hat und was sie bekam. */
    public record EinloesungDto(UUID id, String edgeRef, UUID freigabeId, String fassung, String geraeteSchluesselSha256,
            String wireguardSchluessel, String hostSchluessel, String tunnelAdresse, UUID fensterId, boolean tausch,
            Instant eingeloestAm) {
        static EinloesungDto of(EinloesungRepository.Einloesung e) {
            return new EinloesungDto(e.id(), e.edgeRef(), e.freigabeId(), e.fassung(), e.geraeteSchluesselSha256(),
                    e.wireguardSchluessel(), e.hostSchluessel(), e.tunnelAdresse(), e.fensterId(), e.tausch(),
                    e.eingeloestAm());
        }
    }

    /** Der festgehaltene Geräteschlüssel einer Box (D2). */
    public record FestgehaltenDto(String sha256, Instant festgehaltenAm, UUID einloesungId) {
    }

    /**
     * Der Stand einer Box beim Einlösen: festgehalten oder nicht, und die Einlösungen, neueste zuerst. Dazu, ob sie
     * abgenommen oder gekoppelt ist: Nur wenn beides nein ist, lässt der Dienst eine halb eingerichtete Box
     * zurücksetzen.
     */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record BoxStandDto(String edgeRef, FestgehaltenDto festgehalten, List<EinloesungDto> einloesungen,
            boolean abgenommen, boolean gekoppelt) {
    }

    /** Ein geschlossenes Probe-Fenster. */
    public record FensterDto(UUID id, String edgeRef, UUID technikerId, Instant beginn, Instant ende,
            Instant geschlossenAm) {
    }

    /** Die Abnahme mit Belegen: je Prüfung der Werkstatt-Regel ein Beleg, das Passwort mit age verschlüsselt. */
    public record AbnahmeRequest(String fassung, String hostSchluessel, String lanNetz, Map<String, String> belege,
            String passwortAge, String notiz) {
    }

    /** Was der Dienst zurückbekommt; das verschlüsselte Passwort nicht noch einmal. */
    public record AbnahmeDto(UUID id, String edgeRef, UUID freigabeId, UUID einloesungId, String lanNetz,
            String tunnelAdresse, Instant erfasstAm) {
    }

    private final FreigabeService freigaben;
    private final EinloesungService einloesung;
    private final WerkstattService werkstatt;
    private final DienstAnsichtService ansichten;
    private final LaufSeiteService laufSeite;
    private final WerkstattGehaeuseRepository gehaeuseDateien;

    public WerkstattDienstController(FreigabeService freigaben, EinloesungService einloesung,
            WerkstattService werkstatt, DienstAnsichtService ansichten, LaufSeiteService laufSeite,
            WerkstattGehaeuseRepository gehaeuseDateien) {
        this.freigaben = freigaben;
        this.einloesung = einloesung;
        this.werkstatt = werkstatt;
        this.ansichten = ansichten;
        this.laufSeite = laufSeite;
        this.gehaeuseDateien = gehaeuseDateien;
    }

    /** Ein Auftrag des Portals, wie der Dienst ihn abholt. */
    public record AuftragDto(UUID id, String art, String lauf) {
    }

    public record AuftraegeDto(List<AuftragDto> auftraege) {
    }

    /**
     * Die Ansicht des Dienstes melden (jeden Takt, docs/contracts/werkstatt-ansicht-v1.md):
     * 204; 422 mit Grund, wenn die Form nicht stimmt oder Schlüsselmaterial darin steht.
     * Mit {@code ?auftraege=1} (ein Dienst, der Aufträge kennt): 200 mit den offenen
     * Aufträgen des Portals, jeder genau einmal ({@link LaufSeiteService#abholen}).
     * Ohne den Parameter bleibt es 204, wie ein älterer Dienst es erwartet.
     */
    @PutMapping(value = "/ansicht", consumes = "application/json")
    public ResponseEntity<AuftraegeDto> ansicht(@RequestBody String roh,
            @RequestParam(name = "auftraege", defaultValue = "0") String auftraege, @AuthenticationPrincipal Jwt caller) {
        ansichten.melden(roh, Akteur.aus(caller));
        if (!"1".equals(auftraege)) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(new AuftraegeDto(laufSeite.abholen().stream()
                .map(a -> new AuftragDto(a.id(), a.art(), a.lauf())).toList()));
    }

    /** Die laufende Freigabe einer Box-Art (Vorgabe mango); 404, wenn keine läuft. */
    @GetMapping("/freigabe")
    public FreigabeDto freigabe(@RequestParam(name = "boxArt", defaultValue = FreigabeService.MANGO) String boxArt) {
        return freigaben.laufend(boxArt).map(FreigabeDto::of).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "Die Werkstatt ist für " + boxArt + " nicht freigegeben."));
    }

    /** Einmal-Code holen: 201; 409 ohne laufende Freigabe, gekoppelt, mit Zertifikat, Obergrenze; 422 Kennung. */
    @PostMapping("/codes")
    public ResponseEntity<CodeDto> code(@RequestBody CodeRequest req, @AuthenticationPrincipal Jwt caller) {
        EinloesungService.Ausgabe a = einloesung.codeAusgeben(req == null ? null : req.edgeRef(),
                req != null && Boolean.TRUE.equals(req.tausch()), Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).cacheControl(CacheControl.noStore())
                .body(new CodeDto(a.code(), a.edgeRef(), a.freigabe(), a.gueltigBis(), a.tausch()));
    }

    /** Was die Box beim Einlösen gemeldet hat (leer, solange sie nicht eingelöst hat). */
    @GetMapping("/einloesungen/{edgeRef}")
    public BoxStandDto einloesungen(@PathVariable String edgeRef) {
        FestgehaltenDto fest = einloesung.festgehalten(edgeRef)
                .map(f -> new FestgehaltenDto(f.geraeteSchluesselSha256(), f.festgehaltenAm(), f.einloesungId()))
                .orElse(null);
        WerkstattService.Gebrauch g = werkstatt.gebrauch(edgeRef);
        return new BoxStandDto(edgeRef, fest, einloesung.einloesungen(edgeRef).stream().map(EinloesungDto::of).toList(),
                g.abgenommen(), g.gekoppelt());
    }

    /** Das Probe-Fenster einer Einlösung schließen: 200; 404 für jedes andere Fenster; 409 schon zu. */
    @PostMapping("/fenster/{id}/schliessen")
    public FensterDto fensterSchliessen(@PathVariable UUID id, @AuthenticationPrincipal Jwt caller) {
        var f = einloesung.probeFensterSchliessen(id, Akteur.aus(caller));
        return new FensterDto(f.id(), f.edgeRef(), f.technikerId(), f.beginn(), f.ende(), f.geschlossenAm());
    }

    /**
     * Die Abnahme mit den Belegen des Dienstes (WI-7 A): 201; 400 unbekannte
     * Prüfung; 404 nicht im Register; 409 ohne Einlösung, anderer Host-Schlüssel,
     * andere Fassung, anderer Tunnel-Schlüssel, Probe-Fenster noch offen; 422
     * Beleg fehlt, Passwort nicht mit age verschlüsselt, LAN-Netz.
     */
    @PostMapping("/abnahmen/{edgeRef}")
    public ResponseEntity<AbnahmeDto> abnahme(@PathVariable String edgeRef, @RequestBody AbnahmeRequest req,
            @AuthenticationPrincipal Jwt caller) {
        if (req == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Kein Inhalt.");
        }
        WerkstattRepository.Abnahme a = werkstatt.abnahmeDesDienstes(edgeRef, new WerkstattService.AbnahmeDesDienstes(
                req.fassung(), req.hostSchluessel(), req.lanNetz(), req.belege(), req.passwortAge(), req.notiz()),
                Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(new AbnahmeDto(a.id(), a.edgeRef(), a.freigabeId(),
                a.einloesungId(), a.lanNetz(), a.tunnelAdresse(), a.erfasstAm()));
    }

    private static final Pattern DATEINAME = Pattern.compile("^[a-z0-9][a-z0-9._-]{2,119}\\.3mf$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");

    /** Was der Dienst nach dem Hochladen der Box-Druckdatei zurückbekommt. */
    public record GehaeuseDto(String edgeRef, String name, String sha256, long bytes, Instant hochgeladenAm) {
    }

    /**
     * Die Box-Druckdatei (3MF, mit Referenz und QR-Code dieser Box) hochladen (vp-mango-3mf-pro-box):
     * 201 neu, 200 überschrieben (Nachdruck, neuer Bau); 404 keine Box dieser Referenz im Register;
     * 422 Dateiname oder die mitgeschickte Prüfsumme passt nicht zu den Bytes. Ein Fehlschlag blockiert
     * den Werkstatt-Lauf nicht - der Dienst holt ihn mit dem nächsten Anlauf nach.
     */
    @PutMapping(value = "/gehaeuse/{edgeRef}", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<GehaeuseDto> gehaeuseHochladen(@PathVariable String edgeRef,
            @RequestParam String name, @RequestParam String sha256, @RequestBody(required = false) byte[] daten,
            @AuthenticationPrincipal Jwt caller) {
        if (!DATEINAME.matcher(name).matches()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Kein Dateiname einer Gehäuse-Druckdatei: " + name);
        }
        if (!SHA256.matcher(sha256).matches()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Keine SHA-256-Prüfsumme.");
        }
        if (daten == null || daten.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Die Datei ist leer.");
        }
        String ist = sha256(daten);
        if (!ist.equals(sha256)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Prüfsumme passt nicht zu den Bytes.");
        }
        UUID boxId = werkstatt.box(edgeRef).box().id();
        boolean neu = gehaeuseDateien.stand(edgeRef).isEmpty();
        gehaeuseDateien.hochladen(boxId, edgeRef, name, ist, daten.length, daten,
                caller == null ? null : caller.getSubject());
        WerkstattGehaeuseRepository.Stand stand = gehaeuseDateien.stand(edgeRef).orElseThrow();
        return ResponseEntity.status(neu ? HttpStatus.CREATED : HttpStatus.OK)
                .body(new GehaeuseDto(edgeRef, stand.name(), stand.sha256(), stand.bytes(), stand.hochgeladenAm()));
    }

    private static String sha256(byte[] daten) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(daten));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
