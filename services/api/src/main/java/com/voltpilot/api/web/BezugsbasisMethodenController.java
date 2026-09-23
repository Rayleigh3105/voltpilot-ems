package com.voltpilot.api.web;

import java.io.IOException;
import java.io.InputStream;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der Methoden-Katalog der Bezugsbasis (UEMS AP-17 IP-5, §4.5, E4 = A): die vier Methoden der Bereinigung —
 * Verhältnis, Modell mit einer Einflussgröße, Modell mit zwei Einflussgrößen, Wetterbereinigung über Gradtage — mit
 * Formel, Variablen, Datenbedarf, Mindestumfang, Grenze, Kennzeichen und den Startwerten (G6).
 *
 * <p>Die Antwort ist die Ressource {@code bezugsbasis/bezugsbasis-methoden.json} Byte für Byte — dieselbe Datei wie der
 * Vertrag {@code docs/contracts/v2/bezugsbasis-methoden.json} und die Portal-Kopie {@code frontend/portal/src/bezugsbasis/}
 * ({@code BezugsbasisMethodenControllerTest}, {@code bezugsbasisMethoden.sync.test.ts}); die Form hält
 * {@code docs/contracts/v2/bezugsbasis-methoden.schema.json} fest. Gerechnet wird hier nichts.
 *
 * <p><b>Rechte:</b> der Katalog ist eine VoltPilot-Vorgabe ohne Kundendaten und ohne Mandant (Muster Kennzahl-Vorlagen,
 * AP-11 E9) — kein Kundenobjekt, kein Recht. Wer eine Bezugsbasis anlegt oder freigibt, braucht das Recht an der
 * Bezugsbasis-Route (IP-8), nicht hier.
 */
@RestController
public class BezugsbasisMethodenController {

    static final String RESSOURCE = "/bezugsbasis/bezugsbasis-methoden.json";

    private final byte[] datei;

    public BezugsbasisMethodenController() {
        try (InputStream in = BezugsbasisMethodenController.class.getResourceAsStream(RESSOURCE)) {
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
    @GetMapping(value = "/api/v1/bezugsbasis-methoden", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<byte[]> methoden() {
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(datei.clone());
    }
}
