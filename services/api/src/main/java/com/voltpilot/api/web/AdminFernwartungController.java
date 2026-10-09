package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.fernwartung.FernwartungProperties;
import com.voltpilot.api.fernwartung.FernwartungRepository.DienstAbruf;
import com.voltpilot.api.fernwartung.FernwartungRepository.Fenster;
import com.voltpilot.api.fernwartung.FernwartungRepository.ProtokollEintrag;
import com.voltpilot.api.fernwartung.FernwartungRepository.Zugang;
import com.voltpilot.api.fernwartung.FernwartungService;
import com.voltpilot.api.fernwartung.FernwartungService.Ergebnis;
import com.voltpilot.api.fernwartung.FernwartungService.Hinterlegt;
import com.voltpilot.api.fernwartung.FernwartungService.Uebersicht;
import com.voltpilot.api.fernwartung.SshSchluessel;
import com.voltpilot.api.fernwartung.WireguardSchluessel;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Duration;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Fernwartung über das Portal (Entscheid E5 des Kapitäns, 07.10.2026):
 * Tunnel-Schlüssel je Box, Techniker-Zugänge, Fernwartungsfenster und das
 * Protokoll unter {@code /api/v1/admin/fernwartung}.
 *
 * <p><b>Nur VoltPilot-Admins.</b> Die Klasse trägt klassenweit
 * {@code hasRole('platform-admin')}; die Veröffentlichungs-Rolle
 * {@code edge-release-publisher}, die die Filterkette für den Admin-Baum auch
 * durchlässt, erreicht hier deshalb nichts. Der Kunde sieht nichts davon
 * (O3: einmalige, generelle Zustimmung über Vertrag/AGB, die einzelnen
 * Fenster bleiben intern). Die RLS-Umgehung steckt ausschließlich im
 * {@code FernwartungRepository} an der BYPASSRLS-Rolle.
 *
 * <p><b>Übergang bis D2:</b> {@code PUT /boxen/{ref}/schluessel} hinterlegt
 * den Tunnel-Schlüssel einer Box von Hand. Die Werkstatt-Registrierung soll
 * später genau diese Regel aufrufen (Adresse zuteilen, Tausch nur markiert).
 *
 * <p>Umgesetzt wird nichts von hier aus: der Tunnel-Dienst auf der
 * Wartungs-VM holt den Soll-Stand über {@link FernwartungSollController} ab.
 */
@RestController
@RequestMapping("/api/v1/admin/fernwartung")
@PreAuthorize("hasRole('platform-admin')")
public class AdminFernwartungController {

    // ── Antworten ─────────────────────────────────────────────────────────

    /** Die Server-Seite des Tunnels, wie Box und Techniker sie eintragen. */
    public record ServerDto(String endpunkt, int port, String publicKey, boolean eingerichtet,
            String boxNetz, String technikerNetz, String boxServerAdresse, String technikerServerAdresse) {
    }

    public record AbrufDto(String dienst, Instant zuletztAm, int peers, int fenster) {
        static AbrufDto of(DienstAbruf a) {
            return new AbrufDto(a.dienst(), a.zuletztAm(), a.peers(), a.fenster());
        }
    }

    public record UebersichtDto(ServerDto server, long maxFensterMinuten, List<AbrufDto> abrufe,
            long boxenAktiv, long boxenGesperrt, long technikerAktiv, long technikerGesperrt,
            long fensterOffen, long fensterGeplant, Instant stand) {
    }

    /**
     * Ein Fenster mit seinem Zustand zur Antwortzeit:
     * {@code offen | geplant | geschlossen | abgesagt | abgelaufen}.
     */
    public record FensterDto(UUID id, String edgeRef, UUID technikerId, String technikerName, String grund,
            Instant beginn, Instant ende, Instant wirksamesEnde, String zustand, Instant geoeffnetAm,
            String geoeffnetVon, Instant geschlossenAm, String geschlossenVon) {
        static FensterDto of(Fenster f, Instant jetzt) {
            return new FensterDto(f.id(), f.edgeRef(), f.technikerId(), f.technikerName(), f.grund(),
                    f.beginn(), f.ende(), f.wirksamesEnde(), zustand(f, jetzt), f.geoeffnetAm(),
                    name(f.geoeffnetVonName(), f.geoeffnetVon()), f.geschlossenAm(),
                    f.geschlossenAm() == null ? null : name(f.geschlossenVonName(), f.geschlossenVon()));
        }

        static String zustand(Fenster f, Instant jetzt) {
            if (f.geschlossenAm() != null) {
                return f.geschlossenAm().isAfter(f.beginn()) ? "geschlossen" : "abgesagt";
            }
            if (!f.ende().isAfter(jetzt)) {
                return "abgelaufen";
            }
            return f.beginn().isAfter(jetzt) ? "geplant" : "offen";
        }
    }

    public record BoxDto(UUID id, String edgeRef, String publicKey, String publicKeyKurz, String adresse,
            String status, String notiz, Instant angelegtAm, Instant geaendertAm, UUID siteId, String siteName,
            UUID tenantId, String tenantName, List<FensterDto> laufendeFenster) {
        static BoxDto of(Zugang z, List<Fenster> laufend, Instant jetzt) {
            return new BoxDto(z.id(), z.edgeRef(), z.publicKey(), WireguardSchluessel.kurz(z.publicKey()),
                    z.adresse(), z.status(), z.notiz(), z.angelegtAm(), z.geaendertAm(), z.siteId(),
                    z.siteName(), z.tenantId(), z.tenantName(),
                    laufend.stream().map(f -> FensterDto.of(f, jetzt)).toList());
        }
    }

    /**
     * {@code sshPublicKey}, {@code sshFingerabdruck} und {@code sshBits} sind
     * alle drei gesetzt oder alle drei null: der öffentliche SSH-Schlüssel des
     * Technikers in Normalform, sein Fingerabdruck wie bei
     * {@code ssh-keygen -lf} und die Schlüssellänge.
     */
    public record TechnikerDto(UUID id, String name, String publicKey, String publicKeyKurz, String adresse,
            String status, String notiz, Instant angelegtAm, Instant geaendertAm, String sshPublicKey,
            String sshFingerabdruck, Integer sshBits) {
        static TechnikerDto of(Zugang z) {
            SshSchluessel.Geprueft ssh = z.ssh().orElse(null);
            return new TechnikerDto(z.id(), z.name(), z.publicKey(), WireguardSchluessel.kurz(z.publicKey()),
                    z.adresse(), z.status(), z.notiz(), z.angelegtAm(), z.geaendertAm(),
                    ssh == null ? null : ssh.zeile(), ssh == null ? null : ssh.fingerabdruck(),
                    ssh == null ? null : ssh.bits());
        }
    }

    /** {@code ergebnis}: {@code angelegt | unveraendert | getauscht}. */
    public record SchluesselAntwortDto(String ergebnis, BoxDto box, ServerDto server) {
    }

    public record TechnikerAntwortDto(TechnikerDto techniker, ServerDto server) {
    }

    public record ProtokollDto(UUID id, Instant zeit, String akteur, String aktion, String edgeRef,
            UUID technikerId, String technikerName, UUID fensterId, JsonNode details) {
    }

    // ── Anfragen ──────────────────────────────────────────────────────────

    /**
     * {@code schluesselTausch} muss gesetzt sein, wenn für die Box schon ein
     * ANDERER Schlüssel hinterlegt ist.
     */
    public record SchluesselRequest(@NotBlank String publicKey, Boolean schluesselTausch,
            @Size(max = 500) String notiz) {
    }

    /** {@code sshPublicKey} ist freiwillig: der öffentliche SSH-Schlüssel für die Anmeldung an der Box. */
    public record TechnikerRequest(@NotBlank @Size(max = 80) String name, @NotBlank String publicKey,
            @Size(max = 500) String notiz, String sshPublicKey) {
    }

    /** Die eine Zeile aus der {@code .pub}-Datei; die Regeln prüft {@link SshSchluessel}. */
    public record SshSchluesselRequest(String sshPublicKey) {
    }

    public record SperrenRequest(@Size(max = 500) String grund) {
    }

    /** {@code beginn} leer = jetzt. */
    public record FensterRequest(@NotBlank String edgeRef, @NotNull UUID technikerId,
            @NotBlank @Size(max = 500) String grund, @NotNull Integer dauerMinuten, Instant beginn) {
    }

    private final FernwartungService service;
    private final ObjectMapper json;

    public AdminFernwartungController(FernwartungService service, ObjectMapper json) {
        this.service = service;
        this.json = json;
    }

    // ── Übersicht ─────────────────────────────────────────────────────────

    @GetMapping
    public UebersichtDto uebersicht() {
        Uebersicht u = service.uebersicht();
        return new UebersichtDto(server(), u.konfiguration().maxFensterDauer().toMinutes(),
                u.abrufe().stream().map(AbrufDto::of).toList(), u.boxenAktiv(), u.boxenGesperrt(),
                u.technikerAktiv(), u.technikerGesperrt(), u.fensterOffen(), u.fensterGeplant(), service.jetzt());
    }

    // ── Boxen ─────────────────────────────────────────────────────────────

    @GetMapping("/boxen")
    public List<BoxDto> boxen() {
        Instant jetzt = service.jetzt();
        Map<UUID, List<Fenster>> laufend = service.laufendeFensterJeBox();
        return service.boxen().stream()
                .map(b -> BoxDto.of(b, laufend.getOrDefault(b.id(), List.of()), jetzt))
                .toList();
    }

    @GetMapping("/boxen/{ref}")
    public BoxDto box(@PathVariable String ref) {
        String edgeRef = referenz(ref);
        Zugang box = service.box(edgeRef).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                "Für " + edgeRef + " ist kein Tunnel-Schlüssel hinterlegt."));
        return boxDto(box);
    }

    /**
     * Den öffentlichen Tunnel-Schlüssel einer Box hinterlegen. 201 = neu
     * angelegt (mit zugeteilter Adresse), 200 = unverändert oder getauscht.
     * Die Antwort trägt alles, was die Box für {@code service-tunnel.sh}
     * braucht.
     */
    @PutMapping("/boxen/{ref}/schluessel")
    public ResponseEntity<SchluesselAntwortDto> schluesselHinterlegen(@PathVariable String ref,
            @Valid @RequestBody SchluesselRequest req, @AuthenticationPrincipal Jwt caller) {
        String edgeRef = referenz(ref);
        if (!EdgeRef.isGeneratedFormat(edgeRef) && !service.referenzBekannt(edgeRef)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Referenz " + edgeRef + " ist weder eine Box-Referenz mit Prüfzeichen (edge-xxxxxxx) "
                            + "noch der Plattform als Gerät bekannt.");
        }
        Hinterlegt h = service.schluesselHinterlegen(edgeRef, req.publicKey(),
                Boolean.TRUE.equals(req.schluesselTausch()), req.notiz(), Akteur.aus(caller));
        SchluesselAntwortDto body = new SchluesselAntwortDto(h.ergebnis().name().toLowerCase(),
                boxDto(h.box()), server());
        return ResponseEntity.status(h.ergebnis() == Ergebnis.ANGELEGT ? HttpStatus.CREATED : HttpStatus.OK)
                .body(body);
    }

    @PostMapping("/boxen/{ref}/sperren")
    public BoxDto boxSperren(@PathVariable String ref, @Valid @RequestBody(required = false) SperrenRequest req,
            @AuthenticationPrincipal Jwt caller) {
        return boxDto(service.boxSperren(referenz(ref), req == null ? null : req.grund(), Akteur.aus(caller)));
    }

    @PostMapping("/boxen/{ref}/entsperren")
    public BoxDto boxEntsperren(@PathVariable String ref, @AuthenticationPrincipal Jwt caller) {
        return boxDto(service.boxEntsperren(referenz(ref), Akteur.aus(caller)));
    }

    // ── Techniker ─────────────────────────────────────────────────────────

    @GetMapping("/techniker")
    public List<TechnikerDto> techniker() {
        return service.techniker().stream().map(TechnikerDto::of).toList();
    }

    @PostMapping("/techniker")
    public ResponseEntity<TechnikerAntwortDto> technikerAnlegen(@Valid @RequestBody TechnikerRequest req,
            @AuthenticationPrincipal Jwt caller) {
        Zugang z = service.technikerAnlegen(req.name(), req.publicKey(), req.sshPublicKey(), req.notiz(),
                Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(new TechnikerAntwortDto(TechnikerDto.of(z), server()));
    }

    @PostMapping("/techniker/{id}/sperren")
    public TechnikerDto technikerSperren(@PathVariable UUID id,
            @Valid @RequestBody(required = false) SperrenRequest req, @AuthenticationPrincipal Jwt caller) {
        return TechnikerDto.of(service.technikerSperren(id, req == null ? null : req.grund(), Akteur.aus(caller)));
    }

    @PostMapping("/techniker/{id}/entsperren")
    public TechnikerDto technikerEntsperren(@PathVariable UUID id, @AuthenticationPrincipal Jwt caller) {
        return TechnikerDto.of(service.technikerEntsperren(id, Akteur.aus(caller)));
    }

    /**
     * Den öffentlichen SSH-Schlüssel eines Techniker-Zugangs setzen oder
     * ersetzen. 400 = kein annehmbarer Schlüssel (nur {@code ssh-rsa}, 2048 bis
     * 4096 Bit); die Meldung nennt bei falschem Typ den Befehl, der einen
     * passenden erzeugt. Kommentar und Schreibweise werden verworfen, die
     * Antwort trägt die Normalform und den Fingerabdruck.
     */
    @PutMapping("/techniker/{id}/ssh-schluessel")
    public TechnikerDto technikerSshSchluesselSetzen(@PathVariable UUID id,
            @RequestBody SshSchluesselRequest req, @AuthenticationPrincipal Jwt caller) {
        return TechnikerDto.of(service.technikerSshSchluesselSetzen(id, req.sshPublicKey(), Akteur.aus(caller)));
    }

    /** Den SSH-Schlüssel entfernen (idempotent): Fenster öffnen danach nur noch den Netzweg. */
    @DeleteMapping("/techniker/{id}/ssh-schluessel")
    public TechnikerDto technikerSshSchluesselEntfernen(@PathVariable UUID id,
            @AuthenticationPrincipal Jwt caller) {
        return TechnikerDto.of(service.technikerSshSchluesselEntfernen(id, Akteur.aus(caller)));
    }

    /**
     * Einen gesperrten Techniker-Zugang löschen: 204. Er fehlt danach in jeder
     * Liste; Adresse und Schlüssel bleiben vergeben, Fenster und Protokoll
     * nennen ihn weiter. 409 = der Zugang ist noch aktiv, 404 = unbekannt oder
     * schon gelöscht.
     */
    @DeleteMapping("/techniker/{id}")
    public ResponseEntity<Void> technikerLoeschen(@PathVariable UUID id, @AuthenticationPrincipal Jwt caller) {
        service.technikerLoeschen(id, Akteur.aus(caller));
        return ResponseEntity.noContent().build();
    }

    // ── Fenster ───────────────────────────────────────────────────────────

    @GetMapping("/fenster")
    public List<FensterDto> fenster(@RequestParam(required = false) String box,
            @RequestParam(required = false) UUID techniker, @RequestParam(defaultValue = "100") int limit) {
        Instant jetzt = service.jetzt();
        return service.fenster(box == null ? null : referenz(box), techniker, limit).stream()
                .map(f -> FensterDto.of(f, jetzt)).toList();
    }

    @PostMapping("/fenster")
    public ResponseEntity<FensterDto> fensterOeffnen(@Valid @RequestBody FensterRequest req,
            @AuthenticationPrincipal Jwt caller) {
        Fenster f = service.fensterOeffnen(referenz(req.edgeRef()), req.technikerId(), req.grund(),
                Duration.ofMinutes(req.dauerMinuten()), req.beginn(), Akteur.aus(caller));
        return ResponseEntity.status(HttpStatus.CREATED).body(FensterDto.of(f, service.jetzt()));
    }

    @PostMapping("/fenster/{id}/schliessen")
    public FensterDto fensterSchliessen(@PathVariable UUID id, @AuthenticationPrincipal Jwt caller) {
        return FensterDto.of(service.fensterSchliessen(id, Akteur.aus(caller)), service.jetzt());
    }

    // ── Protokoll ─────────────────────────────────────────────────────────

    @GetMapping("/protokoll")
    public List<ProtokollDto> protokoll(@RequestParam(required = false) String box,
            @RequestParam(required = false) UUID techniker, @RequestParam(defaultValue = "200") int limit) {
        return service.protokoll(box == null ? null : referenz(box), techniker, limit).stream()
                .map(this::protokollDto).toList();
    }

    // ── intern ────────────────────────────────────────────────────────────

    private BoxDto boxDto(Zugang box) {
        return BoxDto.of(box, service.laufendeFensterJeBox().getOrDefault(box.id(), List.of()), service.jetzt());
    }

    private ServerDto server() {
        FernwartungProperties p = service.konfiguration();
        return new ServerDto(p.serverEndpunkt(), p.serverPort(), p.serverPublicKey(), p.serverPublicKey() != null,
                p.boxNetz(), p.technikerNetz(),
                com.voltpilot.api.fernwartung.Ipv4Netz.text(p.boxNetzwerk().serverAdresse()),
                com.voltpilot.api.fernwartung.Ipv4Netz.text(p.technikerNetzwerk().serverAdresse()));
    }

    private ProtokollDto protokollDto(ProtokollEintrag e) {
        JsonNode details;
        try {
            details = json.readTree(e.details() == null ? "{}" : e.details());
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            details = json.createObjectNode();
        }
        return new ProtokollDto(e.id(), e.zeit(), name(e.akteurName(), e.akteur()), e.aktion(), e.edgeRef(),
                e.technikerId(), e.technikerName(), e.fensterId(), details);
    }

    private static String name(String anzeige, String sub) {
        return anzeige == null || anzeige.isBlank() ? sub : anzeige;
    }

    /**
     * Dieselbe Schreibweise wie bei der Kopplung ({@code edge-} klein); eine
     * Box-Referenz mit falschem Prüfzeichen ist ein Tippfehler, kein
     * unbekanntes Gerät.
     */
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
