package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.EnergieeinsatzAbgelehnt;
import com.voltpilot.api.uems.EnergieeinsatzService;
import com.voltpilot.api.uems.EnergieeinsatzEinstufungService;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.EnergieeinsatzDto.*;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.net.URI;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

/** UEMS AP-16 IP-4: Energieeinsatz-Routen; Standort-Zaun im Dienst, Zuständigkeit ohne Sonderrechte. */
@RestController
@RequestMapping("/api/v1/unternehmen/energieeinsaetze")
public class EnergieeinsatzController {
    private final EnergieeinsatzService dienst;
    private final EnergieeinsatzEinstufungService einstufungen;
    private final ObjectMapper json;
    public EnergieeinsatzController(EnergieeinsatzService dienst, EnergieeinsatzEinstufungService einstufungen,
            ObjectMapper json) {
        this.dienst = dienst;
        this.einstufungen = einstufungen;
        this.json = json.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(com.fasterxml.jackson.databind.MapperFeature.ALLOW_COERCION_OF_SCALARS);
    }

    /** Recht: {@code energieeinsatz.ansehen}; sichtbar über die Messstellen des Prozesses. */
    @GetMapping
    public Liste liste(@RequestParam(required = false) UUID prozess) { return dienst.liste(prozess); }

    /** Recht: {@code energieeinsatz.ansehen}; Prozesse ohne laufenden Stromeinsatz. */
    @GetMapping("/vorschlaege")
    public Vorschlaege vorschlaege() { return dienst.vorschlaege(); }

    /** Recht: {@code energieeinsatz.ansehen}; außerhalb dieselbe 404 wie unbekannt. */
    @GetMapping("/{id}")
    public Einsatz einer(@PathVariable UUID id) { return dienst.einer(id); }

    /** Recht: {@code energieeinsatz.verwalten}. */
    @PostMapping
    @Recht(value = "energieeinsatz.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public ResponseEntity<Einsatz> anlegen(@RequestBody JsonNode body, Authentication auth) {
        UUID id = dienst.anlegen(lies(body, Anlegen.class), wer(auth));
        return ResponseEntity.created(URI.create("/api/v1/unternehmen/energieeinsaetze/" + id)).body(dienst.einer(id));
    }

    /** Recht: {@code energieeinsatz.verwalten}; Name und Wortlaut. */
    @PutMapping("/{id}")
    @Recht(value = "energieeinsatz.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public Einsatz bearbeiten(@PathVariable UUID id, @RequestBody JsonNode body, Authentication auth) {
        dienst.bearbeiten(id, lies(body, Bearbeiten.class), wer(auth));
        return dienst.einer(id);
    }

    /** Recht: {@code energieeinsatz.verwalten}; mit Grund, letzter Tag einschließlich. */
    @PostMapping("/{id}/beenden")
    @Recht(value = "energieeinsatz.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public Einsatz beenden(@PathVariable UUID id, @RequestBody JsonNode body, Authentication auth) {
        dienst.beenden(id, lies(body, Beenden.class), wer(auth));
        return dienst.einer(id);
    }

    /** Recht: {@code energieeinsatz.verwalten}; Schnappschuss aus dem Benutzerspiegel. */
    @PutMapping("/{id}/verantwortlicher")
    @Recht(value = "energieeinsatz.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public Einsatz verantwortlicher(@PathVariable UUID id, @RequestBody JsonNode body, Authentication auth) {
        dienst.verantwortlicher(id, lies(body, VerantwortlicherSetzen.class), wer(auth));
        return dienst.einer(id);
    }

    /** Recht: {@code energieeinsatz.verwalten}; ersetzt die Liste, erhält die Geschichte. */
    @PutMapping("/{id}/einflussgroessen")
    @Recht(value = "energieeinsatz.verwalten", ziel = RechtZiel.UNTERNEHMEN)
    public Einsatz einflussgroessen(@PathVariable UUID id, @RequestBody JsonNode body, Authentication auth) {
        dienst.einflussgroessen(id, lies(body, EinfluesseSetzen.class), wer(auth));
        return dienst.einer(id);
    }

    /** Recht: {@code energieeinsatz.ansehen}; derselbe Standort-Zaun wie am Einsatz. */
    @GetMapping("/{id}/protokoll")
    public Protokoll protokoll(@PathVariable UUID id) { return dienst.protokoll(id); }

    /** Recht: {@code energieeinsatz.einstufen}; eine Person, Pflichtbegründung und vollständige Herkunft. */
    @PutMapping("/{id}/einstufung")
    @Recht(value = "energieeinsatz.einstufen", ziel = RechtZiel.UNTERNEHMEN)
    public com.voltpilot.api.web.dto.EnergieeinsatzEinstufungDto.Fassung einstufen(@PathVariable UUID id,
            @RequestBody JsonNode body, Authentication auth) {
        return einstufungen.speichern(id,
                lies(body, com.voltpilot.api.web.dto.EnergieeinsatzEinstufungDto.Speichern.class), wer(auth));
    }

    /** Recht: {@code energieeinsatz.einstufen}; bei Vier-Augen nur durch eine zweite Person. */
    @PostMapping("/{id}/einstufung/bestaetigen")
    @Recht(value = "energieeinsatz.einstufen", ziel = RechtZiel.UNTERNEHMEN)
    public com.voltpilot.api.web.dto.EnergieeinsatzEinstufungDto.Fassung bestaetigen(@PathVariable UUID id,
            Authentication auth) {
        return einstufungen.bestaetigen(id, wer(auth));
    }

    /** Recht: {@code energieeinsatz.ansehen}; alle Fassungen bleiben lesbar. */
    @GetMapping("/{id}/einstufungen")
    public com.voltpilot.api.web.dto.EnergieeinsatzEinstufungDto.Historie einstufungen(@PathVariable UUID id) {
        return einstufungen.historie(id);
    }

    private <T> T lies(JsonNode body, Class<T> typ) {
        if (body == null || !body.isObject()) throw anfrage();
        try { return json.treeToValue(body, typ); }
        catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) { throw anfrage(); }
    }
    static EnergieeinsatzAbgelehnt anfrage() {
        return new EnergieeinsatzAbgelehnt(400, "anfrage_ungueltig", "Bitte prüfen Sie die Angaben Ihrer Anfrage.");
    }
    private static ProtokollAkteur wer(Authentication auth) {
        return ProtokollAkteur.aus(auth).orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.UNAUTHORIZED, "Bitte melden Sie sich an."));
    }
}
