package com.voltpilot.api.web;

import java.io.IOException;
import java.io.InputStream;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Berichtsvorlagen (UEMS AP-12 IP-5, E9 = A, V2): vier VoltPilot-Vorlagen mit Fassungsnummer und festen Abschnitten.
 *
 * <p>Die Antwort ist die Ressource {@code berichte/bericht-vorlagen.json} Byte für Byte — dieselbe Datei wie der Vertrag
 * {@code docs/contracts/v2/bericht-vorlagen.json} und die Portal-Kopie {@code frontend/portal/src/berichte/}
 * ({@code BerichtVorlagenControllerTest}, {@code berichtVorlagen.sync.test.ts}). Die Regeln lesen die Vorlagen aus
 * {@code BerichtRegeln.VORLAGEN}; {@code BerichtVectorsTest} hält beide gleich.
 *
 * <p><b>Rechte:</b> die Route selbst hat keine eigene Kennung. Eine Vorlage wählt, wer einen Bericht anlegt — an einem
 * Standort mit {@code bericht.standort_freigeben}, am Unternehmen mit {@code bericht.unternehmen} (G1,
 * {@code BerichtRegeln.kennung}); durchgesetzt wird das an der Berichts-Route (IP-7), nicht hier.
 */
@RestController
public class BerichtVorlagenController {

    static final String RESSOURCE = "/berichte/bericht-vorlagen.json";

    private final byte[] datei;

    public BerichtVorlagenController() {
        try (InputStream in = BerichtVorlagenController.class.getResourceAsStream(RESSOURCE)) {
            if (in == null) {
                throw new IllegalStateException(RESSOURCE + " fehlt im Klassenpfad");
            }
            this.datei = in.readAllBytes();
        } catch (IOException e) {
            throw new IllegalStateException(RESSOURCE + " ist nicht lesbar", e);
        }
    }

    /**
     * Recht: keine eigene Kennung — der Katalog ist für jede angemeldete Person derselbe und nennt keine Daten eines
     * Kundenbereichs.
     */
    @GetMapping(value = "/api/v1/bericht-vorlagen", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<byte[]> vorlagen() {
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(datei.clone());
    }
}
