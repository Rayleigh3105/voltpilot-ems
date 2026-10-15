package com.voltpilot.api.web;

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
import org.springframework.http.ResponseEntity;
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

    public MeldungenController(UeberwachungRepository repo, UeberwachungsService dienst,
            UeberwachungAnlegenService anlegen) {
        this.repo = repo;
        this.dienst = dienst;
        this.anlegen = anlegen;
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

    /** Reiter "Überwachungen" (§6.8): alle aktiven Regeln, ab Werk und eigene gemeinsam. */
    @GetMapping("/regeln")
    public UeberwachungDto.Liste regeln() {
        List<UeberwachungDto> liste = repo.aktive().stream()
                .map(r -> new UeberwachungDto(r.id().toString(), r.name(), r.wertart(), r.schwere(), r.herkunft(),
                        true))
                .toList();
        return new UeberwachungDto.Liste(liste);
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
