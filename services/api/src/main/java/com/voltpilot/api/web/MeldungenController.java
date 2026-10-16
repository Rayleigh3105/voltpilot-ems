package com.voltpilot.api.web;

import com.voltpilot.api.ueberwachung.ExterneEmpfaengerRepository;
import com.voltpilot.api.ueberwachung.ExterneEmpfaengerService;
import com.voltpilot.api.ueberwachung.ProbelaufService;
import com.voltpilot.api.ueberwachung.UeberwachungAnlegenService;
import com.voltpilot.api.ueberwachung.UeberwachungRepository;
import com.voltpilot.api.ueberwachung.UeberwachungRepository.AlarmZeile;
import com.voltpilot.api.ueberwachung.UeberwachungsService;
import com.voltpilot.api.web.dto.MeldungDto;
import com.voltpilot.api.web.dto.UeberwachungDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Meldungs-Center (Alerting Scheibe 1, Konzept §6.8, Entscheid 4A): {@code #/meldungen} mit den
 * Reitern Jetzt/Verlauf. Keine eigene Rechte-Prüfung je Zeile - der Standort-Zaun ({@code site_scope}
 * auf {@code alarm}) entscheidet bereits, welche Meldungen die Verbindung überhaupt sieht, wie bei
 * jeder anderen reinen Leseroute dieser Ebene (§6.6 "zweifach gesichert").
 *
 * <p>"Gesehen" (Entscheid 3B) ist keine Quittierungspflicht - wer eine Meldung sieht, darf sie als
 * gesehen markieren; das ändert nur den Verlauf, hält aber den Zustandsübergang nicht auf.
 */
@RestController
@RequestMapping("/api/v1/meldungen")
public class MeldungenController {

    private static final int LIMIT = 200;

    private final UeberwachungRepository repo;
    private final UeberwachungsService dienst;
    private final UeberwachungAnlegenService anlegen;
    private final ProbelaufService probelauf;
    private final ExterneEmpfaengerService externeEmpfaenger;

    public MeldungenController(UeberwachungRepository repo, UeberwachungsService dienst,
            UeberwachungAnlegenService anlegen, ProbelaufService probelauf,
            ExterneEmpfaengerService externeEmpfaenger) {
        this.repo = repo;
        this.dienst = dienst;
        this.anlegen = anlegen;
        this.probelauf = probelauf;
        this.externeEmpfaenger = externeEmpfaenger;
    }

    @GetMapping
    public MeldungDto.Liste liste(@RequestParam(required = false) String status,
            @RequestParam(required = false) String anlage) {
        boolean verlauf = "verlauf".equals(status);
        List<AlarmZeile> alarme = repo.liste(verlauf, LIMIT);
        List<MeldungDto> meldungen = alarme.stream()
                .filter(a -> anlage == null || anlage.equals(anlageId(a)))
                .map(this::dto)
                .toList();
        return new MeldungDto.Liste(meldungen);
    }

    @GetMapping("/zahl")
    public MeldungDto.Zahl zahl() {
        return new MeldungDto.Zahl(repo.ungeseheneZahl(), repo.hatUngeseheneDringende());
    }

    /**
     * Verlauf je Periode als CSV (Entscheid 14A, §6.4 Nr. 8): {@code von}/{@code bis} als ISO-Zeitpunkt
     * (halboffenes Fenster {@code [von, bis)}, dieselbe Form wie {@link com.voltpilot.api.ueberwachung.PeriodenFenster}).
     * Keine eigene Rechte-Prüfung über die Matrix - wie jede andere reine Leseroute dieser Ebene liest
     * sie nur, was der Standort-Zaun ({@code site_scope}) ohnehin zulässt (§6.6 "zweifach gesichert").
     * MX4: dieser Export behauptet nirgends, eine Norm zu erfüllen.
     */
    @GetMapping(value = "/verlauf.csv", produces = "text/csv")
    public ResponseEntity<byte[]> verlaufCsv(@RequestParam String von, @RequestParam String bis) {
        Instant vonZeit;
        Instant bisZeit;
        try {
            vonZeit = Instant.parse(von);
            bisZeit = Instant.parse(bis);
        } catch (java.time.format.DateTimeParseException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "von/bis brauchen einen ISO-Zeitpunkt");
        }
        byte[] datei = com.voltpilot.api.ueberwachung.MeldungenCsv.datei(repo.verlaufJePeriode(vonZeit, bisZeit));
        return ResponseEntity.ok()
                .header("Content-Disposition", "attachment; filename=\"meldungen-verlauf.csv\"")
                .contentType(org.springframework.http.MediaType.parseMediaType("text/csv;charset=UTF-8"))
                .body(datei);
    }

    /** Reiter "Überwachungen" (§6.8): alle aktiven Regeln, ab Werk und eigene gemeinsam. */
    @GetMapping("/regeln")
    public UeberwachungDto.Liste regeln() {
        List<UeberwachungDto> liste = repo.aktive().stream()
                .map(r -> new UeberwachungDto(r.id().toString(), r.name(), r.wertart(), r.schwere(), r.herkunft(),
                        true, r.probelaufBis(), r.bezug().toString()))
                .toList();
        return new UeberwachungDto.Liste(liste);
    }

    /**
     * "Jetzt scharf schalten" (§6.8 Entwurf 1, per Tipper statt nach 30 Tagen) - beendet den
     * Probelauf einer eigenen Regel. Recht wie beim Anlegen: {@code ueberwachung.eigene}, wenn die
     * Regel nur die anlegende Person selbst benachrichtigt, sonst {@code ueberwachung.verwalten}.
     */
    @PostMapping("/regeln/{id}/scharf")
    @Recht(value = {"ueberwachung.eigene", "ueberwachung.verwalten"}, ziel = RechtZiel.DIENST)
    public UeberwachungDto scharfSchalten(@PathVariable UUID id) {
        var aufrufer = RechtPruefung.aufrufer()
                .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.FORBIDDEN));
        return anlegen.scharfSchalten(id, aufrufer, Instant.now());
    }

    /**
     * "Was diese Regel in den letzten 30 Tagen gemeldet hätte" (§6.4, §6.8 Entwurf 1) - die
     * Vorschau im Blatt, BEVOR eine Person "Überwachung starten" tippt. Keine eigene Rechte-Prüfung
     * über die Matrix (wie jede andere reine Leseroute dieser Ebene) - {@link ProbelaufService}
     * prüft den Standort-Zaun selbst (Geltungsbereich.requireSite), bevor sie überhaupt liest.
     */
    @PostMapping("/regeln/probelauf")
    public com.voltpilot.api.web.dto.ProbelaufDto probelauf(@RequestBody UeberwachungDto.Anlegen entwurf) {
        return probelauf.vorschau(entwurf, Instant.now());
    }

    /**
     * "Vom Wert zur fertigen Regel: drei Taps" (Alerting Scheibe 2, §6.8): eine eigene Überwachung
     * anlegen. Recht: {@code ueberwachung.eigene} (nur sich selbst benachrichtigen) oder
     * {@code ueberwachung.verwalten} (andere Personen oder Rollen) an der Geltung der Anlage - die
     * genaue Prüfung steht in {@link UeberwachungAnlegenService} ({@code RechtRoutenArchitekturTest.DIENST}).
     */
    @PostMapping("/regeln")
    @Recht(value = {"ueberwachung.eigene", "ueberwachung.verwalten"}, ziel = RechtZiel.DIENST)
    public ResponseEntity<UeberwachungDto> anlegen(@RequestBody UeberwachungDto.Anlegen anfrage) {
        var aufrufer = RechtPruefung.aufrufer()
                .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.FORBIDDEN));
        UeberwachungDto neu = anlegen.anlegen(anfrage, aufrufer, Instant.now());
        return ResponseEntity.created(URI.create("/api/v1/meldungen/regeln/" + neu.id())).body(neu);
    }

    // --------------------------------------------------------------------- Externe Empfänger (Alerting Scheibe 6, Entscheid 11B)

    public record ExterneEmpfaengerAnfrage(String email) {}

    public record ExterneEmpfaengerDto(String id, String email, boolean bestaetigt, boolean aktiv,
            java.time.Instant erstelltAm) {
        static ExterneEmpfaengerDto aus(ExterneEmpfaengerRepository.ExternerEmpfaenger e) {
            return new ExterneEmpfaengerDto(e.id().toString(), e.email(), e.bestaetigt(), e.aktiv(), e.erstelltAm());
        }
    }

    @GetMapping("/regeln/{id}/externe-empfaenger")
    public List<ExterneEmpfaengerDto> externeEmpfaenger(@PathVariable UUID id) {
        var aufrufer = aufruferOderVerboten();
        return externeEmpfaenger.eigene(id, aufrufer, Instant.now()).stream().map(ExterneEmpfaengerDto::aus).toList();
    }

    /**
     * Entscheid 11B: freie externe E-Mail-Empfänger NUR mit Bestätigung - der Aufruf reiht nur die
     * Anfrage ein. Recht: IMMER {@code ueberwachung.verwalten} (ein externer Empfänger ist nie "nur
     * ich selbst") - die genaue Prüfung steht in {@link ExterneEmpfaengerService}
     * ({@code RechtRoutenArchitekturTest.DIENST}).
     */
    @PostMapping("/regeln/{id}/externe-empfaenger")
    @Recht(value = "ueberwachung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<ExterneEmpfaengerDto> externenEmpfaengerHinzufuegen(@PathVariable UUID id,
            @RequestBody ExterneEmpfaengerAnfrage anfrage) {
        if (anfrage.email() == null || anfrage.email().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "email ist ein Pflichtfeld.");
        }
        var aufrufer = aufruferOderVerboten();
        var neu = externeEmpfaenger.hinzufuegen(id, anfrage.email(), aufrufer, Instant.now());
        return ResponseEntity.status(HttpStatus.CREATED).body(ExterneEmpfaengerDto.aus(neu));
    }

    @DeleteMapping("/regeln/{id}/externe-empfaenger/{empfaengerId}")
    @Recht(value = "ueberwachung.verwalten", ziel = RechtZiel.DIENST)
    public ResponseEntity<Void> externenEmpfaengerEntfernen(@PathVariable UUID id, @PathVariable UUID empfaengerId) {
        var aufrufer = aufruferOderVerboten();
        boolean geaendert = externeEmpfaenger.entfernen(id, empfaengerId, aufrufer, Instant.now());
        if (!geaendert) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        }
        return ResponseEntity.noContent().build();
    }

    /** Öffentlich, ohne Anmeldung - der Link aus der Bestätigungs-Mail (derselbe Vertrag wie {@code ZustellwegController#bestaetigen}). */
    @GetMapping("/externe-empfaenger/bestaetigen")
    public ResponseEntity<Void> externenEmpfaengerBestaetigen(@RequestParam String token) {
        return externeEmpfaenger.bestaetigen(token) ? ResponseEntity.ok().build() : ResponseEntity.status(410).build();
    }

    /** Öffentlich, ohne Anmeldung - der Abbestellen-Link in jeder externen Mail (Entscheid 11B), immer idempotent. */
    @GetMapping("/externe-empfaenger/abbestellen")
    public ResponseEntity<Void> externenEmpfaengerAbbestellen(@RequestParam String token) {
        externeEmpfaenger.abbestellen(token);
        return ResponseEntity.ok().build();
    }

    private static com.voltpilot.api.uems.RechteAbleitung.Benutzer aufruferOderVerboten() {
        return RechtPruefung.aufrufer()
                .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.FORBIDDEN));
    }

    /** "Gesehen" (Entscheid 3B): freiwillig, speist nur den Verlauf - keine Quittierungspflicht. */
    @PostMapping("/{id}/gesehen")
    public MeldungDto gesehen(@PathVariable UUID id) {
        String wer = RechtPruefung.aufrufer().map(b -> b.name() != null ? b.name() : b.kennung()).orElse("unbekannt");
        dienst.gesehen(id, wer, Instant.now());
        return repo.alarm(id).map(this::dto)
                .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND));
    }

    private MeldungDto dto(AlarmZeile a) {
        String anlageId = anlageId(a);
        String anlageName = anlageId == null ? null : repo.anlageName(UUID.fromString(anlageId));
        return new MeldungDto(a.id().toString(), a.kennzeichen(), a.wertart(), a.schwere(), anlageId, anlageName,
                a.standortId() == null ? null : a.standortId().toString(), a.ausgeloestAm(), a.zustand(),
                a.wiederNormalAm(), a.gesehenVon(), a.gesehenAm(), a.erledigtAm());
    }

    private static String anlageId(AlarmZeile a) {
        String[] teile = a.bezugKennung().split(":", 2);
        return teile.length == 2 && "anlage".equals(teile[0]) ? teile[1] : null;
    }
}
