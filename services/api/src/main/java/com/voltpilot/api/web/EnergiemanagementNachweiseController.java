package com.voltpilot.api.web;

import com.voltpilot.api.uems.EnergiemanagementAbgelehnt;
import com.voltpilot.api.uems.EnergiemanagementNachweise;
import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * UEMS AP-19 IP-14: betriebliche Nachweise — der Abschnitt „Nachweise“ am Energieeinsatz, die Nachweise an einer Person
 * und die Bekanntmachungen als Liste der Kommunikationsnachweise (DK1, DK6, KS1). Nur Leserouten; festgehalten wird
 * über {@code POST …/dokumente} mit dem Bezug Energieeinsatz, Person oder Aufgabe. Die Arbeit macht
 * {@link EnergiemanagementNachweise}.
 *
 * <p><b>Rechte:</b> Lesen {@code energiemanagement.ansehen} als Kennung im Kommentar. Der Zaun folgt dem Standort des
 * Bezugs: am Einsatz sein abgeleiteter Standort, an Person und Aufgabe das Unternehmen (nur unternehmensweit sichtbar);
 * ein Einsatz außerhalb des Zauns ist 404.
 */
@RestController
@RequestMapping("/api/v1/energiemanagement")
public class EnergiemanagementNachweiseController {

    private final EnergiemanagementNachweise nachweise;

    public EnergiemanagementNachweiseController(EnergiemanagementNachweise nachweise) {
        this.nachweise = nachweise;
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Die Dokumente am Energieeinsatz (Betrieb und Instandhaltung, Auslegung,
     * Beschaffung …) je mit Ort der gültigen Fassung, Überprüfung beim Abruf und Bekanntmachungen; Einsatz außerhalb 404.
     */
    @GetMapping("/energieeinsaetze/{id}/nachweise")
    public EnergiemanagementDokumentDto.NachweiseAmEinsatz amEinsatz(@PathVariable UUID id) {
        return nachweise.amEinsatz(id);
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Die Dokumente an der Person und an ihren Aufgaben (Kompetenz als Verweis,
     * ohne Überprüfung); unbekannte Person 404.
     */
    @GetMapping("/personen/{id}/nachweise")
    public EnergiemanagementDokumentDto.NachweiseDerPerson derPerson(@PathVariable UUID id) {
        return nachweise.derPerson(id);
    }

    /**
     * Recht: {@code energiemanagement.ansehen}. Jede Bekanntmachung eines Dokuments im Zaun — eine Mitteilung über
     * mehrere Wege ist ein Kommunikationsnachweis; VoltPilot hat nichts verschickt.
     */
    @GetMapping("/bekanntmachungen")
    public EnergiemanagementDokumentDto.Kommunikationsnachweise bekanntmachungen() {
        return nachweise.bekanntmachungen();
    }

    /** {@code {code, message, …Fakten}} — wie jede Ablehnung der UEMS-Routen. */
    @ExceptionHandler(EnergiemanagementAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> abgelehnt(EnergiemanagementAbgelehnt e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.putAll(e.fakten());
        return ResponseEntity.status(e.status()).body(body);
    }

    /** Eine ID im Pfad, die keine ist: dieselbe Antwort wie eine, die es nicht gibt. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> keineId(MethodArgumentTypeMismatchException e) {
        return abgelehnt(new EnergiemanagementAbgelehnt(404, "nicht_gefunden", "Das gibt es nicht.", null));
    }
}
