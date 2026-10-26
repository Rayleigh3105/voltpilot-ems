package com.voltpilot.api.werkstatt;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.fernwartung.FernwartungProperties;
import com.voltpilot.api.fernwartung.FernwartungRepository.Fenster;
import com.voltpilot.api.fernwartung.FernwartungRepository.Zugang;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldungRepository.FensterStand;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldungService;
import com.voltpilot.api.fernwartung.FernwartungService;
import com.voltpilot.api.werkstatt.WerkstattRepository.Abnahme;
import com.voltpilot.api.werkstatt.WerkstattRepository.Box;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Regeln der Werkstatt (Bericht voltpilot-box-einrichtung-portal,
 * Abschnitt 3.5): das Register der Boxen, die Schritte des Ablaufs, das
 * LAN-Netz nach Entscheid 6a und die Abnahme nach der Werkstatt-Regel.
 *
 * <p>Die Seite ruft für Tunnel-Schlüssel und Fenster die Routen der
 * Fernwartung auf; hier entsteht nichts davon. Die Abnahme liest nur, was die
 * Fernwartung über das Fenster der Werkstatt-Probe weiß, und hält es fest.
 * Was der Tunnel-Dienst gemeldet hatte, steht im Protokoll als Anzeige und
 * entscheidet nichts - wie überall in der Fernwartung.
 *
 * <p>Die Abnahme beruht auf den Haken des Technikers: Ob ein Passwort gesetzt
 * ist und welcher Schlüssel auf der Box liegt, kann das Portal nicht prüfen.
 */
@Service
public class WerkstattService {

    public static final String EDGE_LIGHT = "edge-light";
    public static final String EDGE_APP = "edge-app";
    private static final List<String> BOX_ARTEN = List.of(EDGE_LIGHT, EDGE_APP);

    private static final Pattern SCHRITT = Pattern.compile("^[a-z][a-z0-9_]{1,39}$");
    private static final int MAX_SCHRITTE = 40;
    private static final Pattern HOST_SCHLUESSEL = Pattern.compile("^SHA256:[A-Za-z0-9+/]{43}$");
    private static final Pattern FASSUNG = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$");
    /** So viele Fenster der Box liest die Abnahme, um das der Probe zu finden. */
    private static final int FENSTER_SUCHE = 200;

    /** Wann ein Schritt abgehakt wurde und von wem. */
    public record SchrittStand(String am, String von) {
    }

    /** Eine Box des Registers mit ihren Schritten und Abnahmen (neueste zuerst). */
    public record Stand(Box box, Map<String, SchrittStand> schritte, List<Abnahme> abnahmen) {
    }

    public record Angelegt(boolean neu, Stand stand) {
    }

    private final WerkstattRepository repo;
    private final FernwartungService fernwartung;
    private final FernwartungRueckmeldungService rueckmeldung;
    private final FernwartungProperties fernwartungProps;
    private final ObjectMapper json;

    public WerkstattService(WerkstattRepository repo, FernwartungService fernwartung,
            FernwartungRueckmeldungService rueckmeldung, FernwartungProperties fernwartungProps,
            ObjectMapper json) {
        this.repo = repo;
        this.fernwartung = fernwartung;
        this.rueckmeldung = rueckmeldung;
        this.fernwartungProps = fernwartungProps;
        this.json = json;
    }

    // ── Lesen ─────────────────────────────────────────────────────────────

    public List<Stand> boxen() {
        Map<UUID, List<Abnahme>> jeBox = new LinkedHashMap<>();
        for (Abnahme a : repo.abnahmen(null)) {
            jeBox.computeIfAbsent(a.boxId(), k -> new ArrayList<>()).add(a);
        }
        return repo.boxen().stream()
                .map(b -> new Stand(b, schritte(b), jeBox.getOrDefault(b.id(), List.of())))
                .toList();
    }

    public Stand box(String edgeRef) {
        Box b = repo.box(edgeRef).orElseThrow(() -> nichtImRegister(edgeRef));
        return stand(b);
    }

    /** Für Referenzen ohne Prüfzeichen: kennt die Plattform sie schon? */
    public boolean referenzBekannt(String edgeRef) {
        return fernwartung.referenzBekannt(edgeRef) || fernwartung.box(edgeRef).isPresent();
    }

    // ── Register ──────────────────────────────────────────────────────────

    /**
     * Eine Box ins Register aufnehmen. Gibt es sie schon, bleibt alles, wie es
     * ist ({@code neu = false}): Ein zweiter Klick legt keine zweite Zeile an
     * und setzt keinen Haken zurück. {@code schritte}: was vor dem Aufnehmen
     * schon erledigt war (die Referenz entsteht erst mit dem ersten Start).
     */
    public Angelegt anlegen(String edgeRef, String boxArt, Collection<String> schritte, String notiz,
            Akteur akteur) {
        String art = boxArt == null || boxArt.isBlank() ? EDGE_LIGHT : boxArt.trim();
        if (!BOX_ARTEN.contains(art)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannte Box-Art „" + art + "“; erlaubt sind " + String.join(", ", BOX_ARTEN) + ".");
        }
        List<String> erledigt = schritte == null ? List.of() : List.copyOf(new LinkedHashSet<>(schritte));
        erledigt.forEach(WerkstattService::schrittPruefen);
        if (erledigt.size() > MAX_SCHRITTE) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Zu viele Schritte.");
        }
        String text = notiz(notiz);
        return repo.schreibend(() -> {
            Optional<Box> da = repo.box(edgeRef);
            if (da.isPresent()) {
                return new Angelegt(false, stand(da.get()));
            }
            Map<String, SchrittStand> anfang = new LinkedHashMap<>();
            String jetzt = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString();
            for (String s : erledigt) {
                anfang.put(s, new SchrittStand(jetzt, name(akteur)));
            }
            repo.boxAnlegen(edgeRef, art, schreibe(anfang), text, akteur.sub(), akteur.name());
            return new Angelegt(true, stand(repo.box(edgeRef).orElseThrow()));
        });
    }

    /** Einen Schritt abhaken oder den Haken wieder entfernen (idempotent). */
    public Stand schritt(String edgeRef, String schritt, boolean erledigt, Akteur akteur) {
        schrittPruefen(schritt);
        return repo.schreibend(() -> {
            Box b = repo.box(edgeRef).orElseThrow(() -> nichtImRegister(edgeRef));
            Map<String, SchrittStand> da = schritte(b);
            if (erledigt && !da.containsKey(schritt)) {
                if (da.size() >= MAX_SCHRITTE) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Zu viele Schritte.");
                }
                repo.schrittSetzen(b.id(), schritt, name(akteur), akteur.sub());
            } else if (!erledigt && da.containsKey(schritt)) {
                repo.schrittEntfernen(b.id(), schritt, akteur.sub());
            }
            return stand(repo.box(edgeRef).orElseThrow());
        });
    }

    /** Das LAN-Netz der Box festhalten (Entscheid 6a); geprüft wie in {@link LanNetz}. */
    public Stand lanNetz(String edgeRef, String text, Akteur akteur) {
        LanNetz lan;
        try {
            lan = LanNetz.parse(text, List.of(fernwartungProps.boxNetzwerk(), fernwartungProps.technikerNetzwerk()));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, e.getMessage());
        }
        return repo.schreibend(() -> {
            Box b = repo.box(edgeRef).orElseThrow(() -> nichtImRegister(edgeRef));
            repo.lanNetzSetzen(b.id(), lan.text(), akteur.sub());
            return stand(repo.box(edgeRef).orElseThrow());
        });
    }

    // ── Abnahme ───────────────────────────────────────────────────────────

    /**
     * Das Abnahmeprotokoll anlegen. Verlangt: die Box im Register, als Edge
     * Light; jede Prüfung der Regel abgehakt; Host-Schlüssel und Fassung in
     * ihrer Form; ein LAN-Netz; einen Tunnel; und das Fenster der
     * Werkstatt-Probe an dieser Box, das offen war und jetzt zu ist
     * (Werkstatt-Regel 6: erst schließen, dann der abgewiesene Versuch).
     */
    public Abnahme abnahme(String edgeRef, String hostSchluessel, String fassung, Collection<String> pruefungen,
            UUID probeFensterId, String notiz, Akteur akteur) {
        List<String> abgehakt = pruefungen == null ? List.of() : List.copyOf(new LinkedHashSet<>(pruefungen));
        List<String> unbekannt = WerkstattPruefungen.unbekannt(abgehakt);
        if (!unbekannt.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannte Prüfung: " + String.join(", ", unbekannt) + ".");
        }
        List<String> fehlend = WerkstattPruefungen.fehlend(abgehakt);
        if (!fehlend.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Abnahme braucht jede Prüfung der Werkstatt-Regel. Es fehlt: " + String.join(", ", fehlend)
                            + ".");
        }
        String host = hostSchluessel == null ? "" : hostSchluessel.trim();
        if (!HOST_SCHLUESSEL.matcher(host).matches()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Der Host-Schlüssel ist ein Fingerabdruck wie ssh-keygen -lf ihn zeigt: SHA256: und 43 Zeichen.");
        }
        String stand = fassung == null ? "" : fassung.trim();
        if (!FASSUNG.matcher(stand).matches()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Fassung ist der Name des Programms auf der Box, etwa edge-light-g9c3368e3a.");
        }
        if (probeFensterId == null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Die Abnahme braucht das Fenster der Werkstatt-Probe.");
        }
        String text = notiz(notiz);
        Box b = repo.box(edgeRef).orElseThrow(() -> nichtImRegister(edgeRef));
        if (!EDGE_LIGHT.equals(b.boxArt())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Eine Abnahme gibt es bisher nur für das Edge Light. Für die Docker-Box fehlt der Wartungstunnel "
                            + "für Linux und damit die Anmeldeprobe.");
        }
        if (b.lanNetz() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Für " + edgeRef + " ist noch kein LAN-Netz festgehalten (Entscheid 6a).");
        }
        Zugang tunnel = fernwartung.box(edgeRef).orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                "Für " + edgeRef + " ist kein Tunnel-Schlüssel hinterlegt."));
        Fenster probe = fernwartung.fenster(edgeRef, null, FENSTER_SUCHE).stream()
                .filter(f -> f.id().equals(probeFensterId))
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Dieses Fenster gehört nicht zu " + edgeRef + "."));
        Instant jetzt = fernwartung.jetzt();
        if (probe.geschlossenAm() == null && probe.ende().isAfter(jetzt)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Das Fenster der Probe ist noch offen. Erst schließen und den Versuch wiederholen "
                            + "(Werkstatt-Regel 6).");
        }
        if (probe.geschlossenAm() != null && !probe.geschlossenAm().isAfter(probe.beginn())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Dieses Fenster wurde abgesagt, bevor es begann; es war nie offen.");
        }
        String probeJson = schreibe(probeBeleg(probe));
        String pruefungenJson = schreibe(WerkstattPruefungen.ALLE);
        return repo.schreibend(() -> {
            UUID id = repo.abnahmeAnlegen(b.id(), edgeRef, host, stand, tunnel.adresse(), b.lanNetz(),
                    pruefungenJson, probeJson, text, akteur.sub(), akteur.name());
            return repo.abnahme(id).orElseThrow();
        });
    }

    /**
     * Was das Portal über das Fenster der Probe weiß: wann es offen war, für
     * wen, wer es geschlossen hat, und was der Tunnel-Dienst dazu zuletzt
     * gemeldet hatte (null = keine Meldung nannte es).
     */
    private Map<String, Object> probeBeleg(Fenster f) {
        FensterStand gemeldet = rueckmeldung.fenster(List.of(f.id())).get(f.id());
        Map<String, Object> beleg = new LinkedHashMap<>();
        beleg.put("fensterId", f.id().toString());
        beleg.put("technikerName", f.technikerName());
        beleg.put("grund", f.grund());
        beleg.put("beginn", f.beginn().toString());
        beleg.put("ende", f.wirksamesEnde().toString());
        beleg.put("geschlossenAm", f.geschlossenAm() == null ? null : f.geschlossenAm().toString());
        beleg.put("geschlossenVon", f.geschlossenAm() == null ? null
                : f.geschlossenVonName() == null ? f.geschlossenVon() : f.geschlossenVonName());
        beleg.put("schluesselAbgeholtUm", gemeldet == null || gemeldet.schluesselAbgeholtUm() == null ? null
                : gemeldet.schluesselAbgeholtUm().toString());
        beleg.put("gemeldetAm", gemeldet == null ? null : gemeldet.angenommenAm().toString());
        return beleg;
    }

    // ── intern ────────────────────────────────────────────────────────────

    private Stand stand(Box b) {
        return new Stand(b, schritte(b), repo.abnahmen(b.id()));
    }

    private Map<String, SchrittStand> schritte(Box b) {
        try {
            Map<String, SchrittStand> m = json.readValue(b.schritteJson() == null ? "{}" : b.schritteJson(),
                    new TypeReference<LinkedHashMap<String, SchrittStand>>() { });
            return m == null ? Map.of() : m;
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("schritte von " + b.edgeRef() + " ist kein JSON-Objekt", e);
        }
    }

    private String schreibe(Object wert) {
        try {
            return json.writeValueAsString(wert);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void schrittPruefen(String schritt) {
        if (schritt == null || !SCHRITT.matcher(schritt).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Ein Schritt heißt aus Kleinbuchstaben, Ziffern und _ (2 bis 40 Zeichen).");
        }
    }

    private static String notiz(String notiz) {
        if (notiz == null || notiz.isBlank()) {
            return null;
        }
        String t = notiz.trim();
        if (t.length() > 500) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Die Notiz hat höchstens 500 Zeichen.");
        }
        return t;
    }

    private static String name(Akteur a) {
        return a.name() == null || a.name().isBlank() ? a.sub() : a.name();
    }

    private static ResponseStatusException nichtImRegister(String edgeRef) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, edgeRef + " steht nicht im Werkstatt-Register.");
    }
}
