package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.StandortLesemodell.StandortAmStichtag;
import com.voltpilot.api.uems.StandortLesemodell.StandorteAmStichtag;
import com.voltpilot.api.uems.StandortLesemodellService;
import com.voltpilot.api.uems.StandortService;
import com.voltpilot.api.uems.StandortVorschlagService;
import com.voltpilot.api.uems.StandortAusfallService;
import com.voltpilot.api.uems.VersorgungService;
import com.voltpilot.api.uems.VersorgungService.Versorgung;
import com.voltpilot.api.web.dto.OrtDto;
import com.voltpilot.api.web.dto.StandortAusfallDto;
import com.voltpilot.api.web.dto.StandortDto;
import com.voltpilot.api.web.dto.StandortVorschlagDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import com.voltpilot.api.zugriff.TeilansichtDienst;
import java.net.URI;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
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
 * Die Standorte des Unternehmens (UEMS AP-02). Lesend das Standort-Lesemodell (IP-3 ★): die
 * Standorte zum Stichtag — Kurzzeichen, Name, Adresse, Zeitzone, Zustand und „es fehlt",
 * die Anlagen mit gültiger Zuordnung, Gebäude- und Bereichszahl, Fläche — und die Gruppe
 * „noch nicht zugeordnet". Schreibend der Lebenszyklus (IP-4, {@link StandortService}):
 * anlegen, bearbeiten, archivieren, wiederherstellen — jede Schreibroute antwortet mit dem
 * Standort, wie er heute im Lesemodell steht; eine Ablehnung ist {@code {code, message,
 * …Fakten}} ({@link OrtAbgelehntHandler}). Gebäude und Bereiche bringt IP-5.
 *
 * <p>Mandantengebunden wie {@code /api/v1/sites/**}: {@code authenticated()} plus RLS, keine
 * eigene Rechte-Annotation — jede Route nennt ihre Kennung aus
 * {@code docs/contracts/v2/rechte-matrix.json} im Kommentar, damit AP-03 sie findet. Ein
 * fremder Standort ist 404, nie 403 (A14). {@code stichtag} ist ein ISO-Tag
 * ({@code 2027-02-15}); ohne ihn gilt heute in der Zeitzone des Unternehmens.
 */
@RestController
@RequestMapping("/api/v1/standorte")
public class StandortController {

    private final StandortLesemodellService lesemodell;
    private final StandortService standorte;
    private final OrtAnfrage anfrage;
    private final TeilansichtDienst teilansicht;
    private final StandortVorschlagService vorschlaege;
    private final VersorgungService versorgung;
    private final StandortAusfallService ausfaelle;
    private final RechtPruefung rechte;

    public StandortController(StandortLesemodellService lesemodell, StandortService standorte,
            OrtAnfrage anfrage, TeilansichtDienst teilansicht, StandortVorschlagService vorschlaege,
            VersorgungService versorgung, StandortAusfallService ausfaelle, RechtPruefung rechte) {
        this.lesemodell = lesemodell;
        this.standorte = standorte;
        this.anfrage = anfrage;
        this.teilansicht = teilansicht;
        this.vorschlaege = vorschlaege;
        this.versorgung = versorgung;
        this.ausfaelle = ausfaelle;
        this.rechte = rechte;
    }

    // Rechte (rechte-matrix.json): heute lesend — keine eigene Kennung; die Sicht
    // „Stand am" (ein Stichtag in der Vergangenheit) ist `aenderungsprotokoll.lesen`.
    // Die Liste selbst schneidet der Standort-Zaun (AP-03 IP-5, `site_scope` auf
    // `standort`): ein Standort außerhalb des Zugriffs steht weder unter `standorte`
    // noch unter `nichtGezeigt`. `teilansicht {sichtbar, gesamt}` sagt additiv, wie
    // viele es waren und wie viele der Kundenbereich hat (AP-03 IP-10, E10).
    @GetMapping
    public StandorteAmStichtag standorte(@RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate stichtag) {
        return lesemodell.standorte(stichtag).mitTeilansicht(teilansicht.jetzt());
    }

    // Rechte: `standort.verwalten` — der Vorschlag gehört zum Anlege-Dialog.
    @GetMapping("/kurzzeichen-vorschlag")
    public StandortDto.Vorschlag vorschlag() {
        return standorte.vorschlag();
    }

    // Recht: lesend — keine eigene Kennung; die Vorschau schreibt nichts und erzeugt keinen Standort.
    @GetMapping("/vorschlag")
    public StandortVorschlagDto.Vorschau zuordnungVorschlag() {
        return vorschlaege.vorschau();
    }

    // Rechte: `standort.verwalten` — erst Bestätigen legt Standorte, Zuordnungen und Protokolle an.
    @PostMapping("/vorschlag/bestaetigen")
    @Recht(value = "standort.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public StandortVorschlagDto.Ergebnis zuordnungBestaetigen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        return vorschlaege.bestaetigen(anfrage.lies(body, StandortVorschlagDto.Bestaetigen.class, false),
                OrtAnfrage.akteur(auth));
    }

    // Rechte: wie die Liste — heute lesend, keine eigene Kennung; ein Stichtag in der
    // Vergangenheit ist `aenderungsprotokoll.lesen`.
    @GetMapping("/{standortId}")
    public StandortAmStichtag standort(@PathVariable UUID standortId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate stichtag) {
        return lesemodell.standort(standortId, stichtag).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort not found"));
    }

    // Recht: `messstelle.ansehen` — reine Sicht aus Ort und Stellung; kein @Recht an einem GET.
    @GetMapping("/{standortId}/versorgung")
    public Versorgung versorgung(@PathVariable UUID standortId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate stichtag) {
        return versorgung.versorgung(standortId, stichtag).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Standort not found"));
    }

    // Recht: `messstelle.ansehen` — reine Sicht aus festgehaltenen Lücken-Fakten; kein @Recht an einem GET.
    @GetMapping("/{standortId}/ausfall")
    public StandortAusfallDto.Ausfall ausfall(@PathVariable UUID standortId) {
        return ausfaelle.ausfall(standortId);
    }

    // Rechte: `standort.verwalten`.
    @PostMapping
    @Recht(value = "standort.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<StandortAmStichtag> anlegen(@RequestBody(required = false) JsonNode body,
            Authentication auth) {
        StandortAmStichtag neu = standorte.anlegen(anfrage.lies(body, StandortDto.Stammdaten.class, false),
                OrtAnfrage.akteur(auth));
        return ResponseEntity.created(URI.create("/api/v1/standorte/" + neu.id())).body(neu);
    }

    // Rechte: `standort.verwalten`.
    @PutMapping("/{standortId}")
    @Recht(value = "standort.verwalten", ziel = RechtZiel.STANDORT)
    public StandortAmStichtag bearbeiten(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return standorte.bearbeiten(standortId, anfrage.lies(body, StandortDto.Stammdaten.class, false),
                OrtAnfrage.akteur(auth));
    }

    // Rechte: `standort.verwalten`; mit „gültig ab" vor heute zusätzlich `aenderung.rueckwirkend`.
    @PutMapping("/{standortId}/flaeche")
    @Recht(value = "standort.verwalten", ziel = RechtZiel.STANDORT)
    public StandortAmStichtag flaeche(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        OrtDto.Flaeche f = anfrage.lies(body, OrtDto.Flaeche.class, false);
        rechte.rueckwirkend(f.gueltigAb());
        return standorte.flaecheSetzen(standortId, f, OrtAnfrage.akteur(auth));
    }

    // Rechte: `standort.verwalten`. Ohne Inhalt: es gibt nichts zu wählen — archiviert wird ab heute.
    @PostMapping("/{standortId}/archivieren")
    @Recht(value = "standort.verwalten", ziel = RechtZiel.STANDORT)
    public StandortAmStichtag archivieren(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        OrtAnfrage.leer(body);
        return standorte.archivieren(standortId, OrtAnfrage.akteur(auth));
    }

    // Rechte: `standort.verwalten`. Optional `{"name": …}` — das Umbenennen im selben Dialog.
    @PostMapping("/{standortId}/wiederherstellen")
    @Recht(value = "standort.verwalten", ziel = RechtZiel.STANDORT)
    public StandortAmStichtag wiederherstellen(@PathVariable UUID standortId,
            @RequestBody(required = false) JsonNode body, Authentication auth) {
        return standorte.wiederherstellen(standortId,
                anfrage.lies(body, StandortDto.Wiederherstellen.class, true), OrtAnfrage.akteur(auth));
    }
}
