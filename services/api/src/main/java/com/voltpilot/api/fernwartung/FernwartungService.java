package com.voltpilot.api.fernwartung;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.fernwartung.FernwartungRepository.DienstAbruf;
import com.voltpilot.api.fernwartung.FernwartungRepository.Fenster;
import com.voltpilot.api.fernwartung.FernwartungRepository.ProtokollEintrag;
import com.voltpilot.api.fernwartung.FernwartungRepository.Zugang;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Regeln der Fernwartung (Entscheid E5 und O3 des Kapitäns, 07.10.2026).
 *
 * <p><b>Das Portal führt den Soll-Zustand, es setzt ihn nicht um.</b> Welche
 * Box welchen Schlüssel und welche Adresse hat, welcher Techniker-Zugang
 * besteht und wann ein Fenster offen ist - das steht hier. Umgesetzt wird es
 * vom Tunnel-Dienst auf der Wartungs-VM, der {@link #soll} abholt. Die
 * Plattform bekommt damit keinen Schreibzugang auf den Server.
 *
 * <p><b>Jede Änderung wird protokolliert</b>, in derselben Transaktion wie die
 * Änderung selbst. Der Kunde sieht davon nichts (O3: einmalige, generelle
 * Zustimmung über Vertrag/AGB); intern steht je Fenster Grund, Techniker, Zeit
 * und wer es geöffnet bzw. geschlossen hat.
 *
 * <p><b>Was dieser Dienst bewusst nicht behauptet:</b> dass ein Fenster auf dem
 * Server wirkt. Das Portal kennt nur den Soll-Stand und den Zeitpunkt, zu dem
 * der Tunnel-Dienst ihn zuletzt abgeholt hat ({@link #uebersicht}); eine
 * Rückmeldung des Dienstes gibt es nicht (nur Leserecht).
 */
@Service
public class FernwartungService {

    public static final String ART_BOX = "box";
    public static final String ART_TECHNIKER = "techniker";
    public static final String AKTIV = "aktiv";
    public static final String GESPERRT = "gesperrt";
    /** Endgültig: aus keiner Liste mehr lesbar, Adresse und Schlüssel bleiben vergeben. */
    public static final String GELOESCHT = "geloescht";

    /** Wie weit ein Fenster im Voraus geplant werden darf. */
    static final Duration MAX_VORLAUF = Duration.ofDays(30);
    /** Uhrabweichung, die ein „Beginn jetzt" aus dem Browser haben darf. */
    static final Duration TOLERANZ = Duration.ofMinutes(2);

    private static final DateTimeFormatter ZEIT =
            DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm").withZone(ZoneId.of("Europe/Berlin"));

    /** Ergebnis einer Schlüssel-Hinterlegung. */
    public enum Ergebnis { ANGELEGT, UNVERAENDERT, GETAUSCHT }

    public record Hinterlegt(Ergebnis ergebnis, Zugang box) {
    }

    /** Ein Peer im Soll-Stand des Tunnel-Dienstes. */
    public record SollPeer(String art, UUID id, String kennung, String publicKey, String adresse) {
    }

    /** Ein offenes Fenster im Soll-Stand: verweist auf Peers über ihre {@code id}. */
    public record SollFenster(UUID id, UUID boxId, UUID technikerId, Instant beginn, Instant ende) {
    }

    /**
     * Der Soll-Stand, Version 1 (Vertrag:
     * {@code docs/contracts/fernwartung-soll-v1.example.json}).
     */
    public record Soll(int version, Instant erzeugtAm, String boxNetz, String technikerNetz,
            List<SollPeer> peers, List<SollFenster> fenster) {
    }

    public record Uebersicht(FernwartungProperties konfiguration, List<DienstAbruf> abrufe, long boxenAktiv,
            long boxenGesperrt, long technikerAktiv, long technikerGesperrt, long fensterOffen,
            long fensterGeplant) {
    }

    private final FernwartungRepository repo;
    private final FernwartungProperties props;
    private final ObjectMapper json;
    private final Clock clock;

    @Autowired
    public FernwartungService(FernwartungRepository repo, FernwartungProperties props, ObjectMapper json) {
        this(repo, props, json, Clock.systemUTC());
    }

    FernwartungService(FernwartungRepository repo, FernwartungProperties props, ObjectMapper json, Clock clock) {
        this.repo = repo;
        this.props = props;
        this.json = json;
        this.clock = clock;
    }

    public Instant jetzt() {
        return clock.instant();
    }

    public FernwartungProperties konfiguration() {
        return props;
    }

    // ── Lesen ─────────────────────────────────────────────────────────────

    public Uebersicht uebersicht() {
        Instant jetzt = jetzt();
        List<Zugang> boxen = repo.zugaenge(ART_BOX);
        List<Zugang> techniker = repo.zugaenge(ART_TECHNIKER);
        List<Fenster> fenster = repo.offeneUndGeplanteFenster(jetzt);
        return new Uebersicht(props, repo.abrufe(),
                boxen.stream().filter(Zugang::aktiv).count(),
                boxen.stream().filter(z -> !z.aktiv()).count(),
                techniker.stream().filter(Zugang::aktiv).count(),
                techniker.stream().filter(z -> !z.aktiv()).count(),
                fenster.stream().filter(f -> f.offen(jetzt)).count(),
                fenster.stream().filter(f -> f.geplant(jetzt)).count());
    }

    public List<Zugang> boxen() {
        return repo.zugaenge(ART_BOX);
    }

    public Optional<Zugang> box(String edgeRef) {
        return repo.box(edgeRef);
    }

    public boolean referenzBekannt(String externalRef) {
        return repo.referenzBekannt(externalRef);
    }

    public List<Zugang> techniker() {
        return repo.zugaenge(ART_TECHNIKER);
    }

    /** Offene und geplante Fenster, nach Box gruppiert (für die Liste). */
    public Map<UUID, List<Fenster>> laufendeFensterJeBox() {
        return repo.offeneUndGeplanteFenster(jetzt()).stream()
                .collect(Collectors.groupingBy(Fenster::boxId, LinkedHashMap::new, Collectors.toList()));
    }

    public List<Fenster> fenster(String edgeRef, UUID technikerId, int limit) {
        UUID boxId = edgeRef == null ? null : boxOder404(edgeRef).id();
        return repo.fensterListe(boxId, technikerId, begrenze(limit));
    }

    public List<ProtokollEintrag> protokoll(String edgeRef, UUID technikerId, int limit) {
        UUID boxId = edgeRef == null ? null : boxOder404(edgeRef).id();
        return repo.protokoll(boxId, technikerId, begrenze(limit));
    }

    // ── Boxen ─────────────────────────────────────────────────────────────

    /**
     * Den öffentlichen Tunnel-Schlüssel einer Box hinterlegen (Übergang bis zur
     * Werkstatt-Registrierung D2, die darauf aufbauen soll).
     *
     * <p>Neu: Adresse aus dem Box-Netz zuteilen. Derselbe Schlüssel noch einmal:
     * nichts ändert sich (ein wiederholter Werkstatt-Lauf ist kein Fehler). Ein
     * ANDERER Schlüssel: nur mit {@code tausch=true} - WireGuard verschiebt die
     * Adresse dann zum neuen Peer, und ohne ausdrückliche Markierung landete
     * ein Techniker womöglich bei einem fremden Gerät.
     */
    public Hinterlegt schluesselHinterlegen(String edgeRef, String publicKey, boolean tausch, String notiz,
            Akteur akteur) {
        String schluessel = schluesselOder400(publicKey);
        String bemerkung = leerZuNull(notiz);
        return repo.schreibend(() -> {
            Optional<Zugang> vorhanden = repo.box(edgeRef);
            Optional<Zugang> traeger = repo.zugangMitSchluessel(schluessel);
            if (traeger.isPresent()
                    && (vorhanden.isEmpty() || !traeger.get().id().equals(vorhanden.get().id()))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, schluesselVergeben(traeger.get()));
            }
            if (vorhanden.isEmpty()) {
                String adresse = freieAdresse(props.boxNetzwerk(), "Box-Netz");
                UUID id = repo.zugangAnlegen(ART_BOX, edgeRef, null, schluessel, adresse, bemerkung,
                        akteur.sub());
                repo.protokollieren(akteur.sub(), akteur.name(), "box_schluessel_hinterlegt", id, null, null,
                        details("edgeRef", edgeRef, "publicKey", WireguardSchluessel.kurz(schluessel),
                                "adresse", adresse));
                return new Hinterlegt(Ergebnis.ANGELEGT, repo.zugang(id).orElseThrow());
            }
            Zugang box = vorhanden.get();
            if (box.publicKey().equals(schluessel)) {
                return new Hinterlegt(Ergebnis.UNVERAENDERT, box);
            }
            if (!tausch) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Für " + edgeRef + " ist bereits ein anderer Schlüssel hinterlegt ("
                                + WireguardSchluessel.kurz(box.publicKey()) + "). Ein Tausch muss ausdrücklich "
                                + "als Schlüsseltausch markiert werden.");
            }
            repo.schluesselSetzen(box.id(), schluessel, bemerkung, akteur.sub());
            repo.protokollieren(akteur.sub(), akteur.name(), "box_schluessel_getauscht", box.id(), null, null,
                    details("edgeRef", edgeRef, "alt", WireguardSchluessel.kurz(box.publicKey()),
                            "neu", WireguardSchluessel.kurz(schluessel), "adresse", box.adresse()));
            return new Hinterlegt(Ergebnis.GETAUSCHT, repo.zugang(box.id()).orElseThrow());
        });
    }

    /** Box sperren: der Tunnel-Dienst entfernt ihren Peer; offene Fenster werden geschlossen. */
    public Zugang boxSperren(String edgeRef, String grund, Akteur akteur) {
        return sperren(boxOder404(edgeRef), grund, akteur, "box_gesperrt");
    }

    public Zugang boxEntsperren(String edgeRef, Akteur akteur) {
        return entsperren(boxOder404(edgeRef), akteur, "box_entsperrt");
    }

    // ── Techniker ─────────────────────────────────────────────────────────

    /**
     * Einen Techniker-Zugang anlegen: der Techniker erzeugt sein Schlüsselpaar
     * auf seinem Gerät, hier landet nur der öffentliche Teil.
     */
    public Zugang technikerAnlegen(String name, String publicKey, String notiz, Akteur akteur) {
        String anzeigename = name == null ? "" : name.trim();
        if (anzeigename.isEmpty() || anzeigename.length() > 80) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der Name des Zugangs muss 1 bis 80 Zeichen haben.");
        }
        String schluessel = schluesselOder400(publicKey);
        return repo.schreibend(() -> {
            repo.zugangMitSchluessel(schluessel).ifPresent(z -> {
                throw new ResponseStatusException(HttpStatus.CONFLICT, schluesselVergeben(z));
            });
            String adresse = freieAdresse(props.technikerNetzwerk(), "Techniker-Netz");
            UUID id = repo.zugangAnlegen(ART_TECHNIKER, null, anzeigename, schluessel, adresse,
                    leerZuNull(notiz), akteur.sub());
            repo.protokollieren(akteur.sub(), akteur.name(), "techniker_angelegt", null, id, null,
                    details("name", anzeigename, "publicKey", WireguardSchluessel.kurz(schluessel),
                            "adresse", adresse));
            return repo.zugang(id).orElseThrow();
        });
    }

    public Zugang technikerSperren(UUID id, String grund, Akteur akteur) {
        return sperren(technikerOder404(id), grund, akteur, "techniker_gesperrt");
    }

    public Zugang technikerEntsperren(UUID id, Akteur akteur) {
        return entsperren(technikerOder404(id), akteur, "techniker_entsperrt");
    }

    /**
     * Einen GESPERRTEN Techniker-Zugang löschen. Er verschwindet aus jeder
     * Liste und Auswahl und lässt sich nicht mehr entsperren; die Zeile bleibt
     * als Zustand {@code geloescht} stehen, damit Adresse und Schlüssel nie
     * wieder vergeben werden und Fenster wie Protokoll ihn weiter beim Namen
     * nennen.
     *
     * <p>Ein aktiver Zugang muss erst gesperrt werden: das Sperren schließt
     * seine Fenster und nimmt den Peer aus dem Soll-Stand, das Löschen selbst
     * ändert für den Tunnel-Dienst nichts mehr.
     */
    public void technikerLoeschen(UUID id, Akteur akteur) {
        repo.<Void>schreibend(() -> {
            Zugang zugang = technikerOder404(id);
            if (zugang.aktiv()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Der Zugang „" + zugang.name() + "\" ist aktiv. Erst sperren, dann löschen.");
            }
            repo.statusSetzen(zugang.id(), GELOESCHT, akteur.sub());
            repo.protokollieren(akteur.sub(), akteur.name(), "techniker_geloescht", null, zugang.id(), null,
                    details("name", zugang.name(), "publicKey", WireguardSchluessel.kurz(zugang.publicKey()),
                            "adresse", zugang.adresse()));
            return null;
        });
    }

    // ── Fenster ───────────────────────────────────────────────────────────

    /**
     * Ein Fernwartungsfenster öffnen: Box, Techniker, Grund und Dauer sind
     * Pflicht, {@code beginn} leer heißt jetzt. Begrenzt auf
     * {@code max-fenster-dauer}; ein zweites, überlappendes Fenster für
     * dasselbe Paar wird abgelehnt statt still zusammengelegt.
     */
    public Fenster fensterOeffnen(String edgeRef, UUID technikerId, String grund, Duration dauer,
            Instant beginn, Akteur akteur) {
        String text = grund == null ? "" : grund.trim();
        if (text.length() < 3 || text.length() > 500) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Ein Grund ist Pflicht (3 bis 500 Zeichen).");
        }
        if (dauer == null || dauer.compareTo(Duration.ofMinutes(1)) < 0
                || dauer.compareTo(props.maxFensterDauer()) > 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Die Dauer muss zwischen 1 Minute und " + dauerText(props.maxFensterDauer()) + " liegen.");
        }
        Instant jetzt = jetzt();
        Instant start = beginn == null ? jetzt : beginn;
        if (start.isBefore(jetzt.minus(TOLERANZ)) || start.isAfter(jetzt.plus(MAX_VORLAUF))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der Beginn muss zwischen jetzt und 30 Tagen in der Zukunft liegen.");
        }
        if (start.isBefore(jetzt)) {
            start = jetzt;
        }
        Instant ende = start.plus(dauer);
        Instant anfang = start;
        return repo.schreibend(() -> {
            Zugang box = boxOder404(edgeRef);
            Zugang techniker = technikerOder404(technikerId);
            if (!box.aktiv()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Die Box " + edgeRef + " ist für die Fernwartung gesperrt.");
            }
            if (!techniker.aktiv()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Der Zugang „" + techniker.name() + "\" ist gesperrt.");
            }
            repo.ueberschneidung(box.id(), techniker.id(), anfang, ende).ifPresent(f -> {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Für " + edgeRef + " und „" + techniker.name() + "\" gibt es schon ein Fenster ("
                                + ZEIT.format(f.beginn()) + " bis " + ZEIT.format(f.ende())
                                + "). Erst schließen, dann neu öffnen.");
            });
            UUID id = repo.fensterAnlegen(box.id(), techniker.id(), text, anfang, ende, akteur.sub(),
                    akteur.name());
            repo.protokollieren(akteur.sub(), akteur.name(), "fenster_geoeffnet", box.id(), techniker.id(), id,
                    details("edgeRef", edgeRef, "techniker", techniker.name(), "grund", text,
                            "beginn", anfang.toString(), "ende", ende.toString(),
                            "dauerMinuten", String.valueOf(dauer.toMinutes())));
            return repo.fenster(id).orElseThrow();
        });
    }

    /** Ein offenes oder geplantes Fenster vorzeitig schließen bzw. absagen. */
    public Fenster fensterSchliessen(UUID id, Akteur akteur) {
        return repo.schreibend(() -> {
            Fenster f = repo.fenster(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Dieses Fenster gibt es nicht."));
            Instant jetzt = jetzt();
            if (f.geschlossenAm() != null || !f.ende().isAfter(jetzt)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Das Fenster ist nicht mehr offen.");
            }
            schliesse(f, jetzt, akteur, f.beginn().isAfter(jetzt) ? "abgesagt" : "vorzeitig");
            return repo.fenster(id).orElseThrow();
        });
    }

    // ── Soll-Stand für den Tunnel-Dienst ──────────────────────────────────

    /**
     * Der Soll-Stand: alle aktiven Peers und die JETZT offenen Fenster, deren
     * Box und Techniker beide aktiv sind. Geplante Fenster stehen bewusst
     * nicht darin - der Dienst öffnet nur, was ein frisch abgeholter Stand
     * jetzt verlangt, und nie etwas aus einem Zwischenspeicher.
     *
     * <p>Merkt sich den Abruf je Dienst-Kennung: das Portal zeigt so, ob der
     * Dienst überhaupt abholt. Das ist keine Aussage über die Wirkung.
     */
    public Soll soll(String dienst) {
        Instant jetzt = jetzt();
        List<SollPeer> peers = repo.aktiveZugaenge().stream()
                .map(z -> new SollPeer(z.art(), z.id(),
                        ART_BOX.equals(z.art()) ? z.edgeRef() : z.name(), z.publicKey(), z.adresse()))
                .toList();
        List<SollFenster> fenster = repo.offeneUndGeplanteFenster(jetzt).stream()
                .filter(f -> f.offen(jetzt))
                .filter(f -> AKTIV.equals(f.boxStatus()) && AKTIV.equals(f.technikerStatus()))
                .map(f -> new SollFenster(f.id(), f.boxId(), f.technikerId(), f.beginn(), f.ende()))
                .toList();
        repo.abrufMerken(dienst == null || dienst.isBlank() ? "unbekannt" : dienst, jetzt, peers.size(),
                fenster.size());
        return new Soll(1, jetzt, props.boxNetz(), props.technikerNetz(), peers, fenster);
    }

    // ── intern ────────────────────────────────────────────────────────────

    private Zugang sperren(Zugang zugang, String grund, Akteur akteur, String aktion) {
        return repo.schreibend(() -> {
            Zugang aktuell = vorhandenOder404(zugang.id());
            if (!aktuell.aktiv()) {
                return aktuell;
            }
            repo.statusSetzen(aktuell.id(), GESPERRT, akteur.sub());
            Instant jetzt = jetzt();
            boolean istBox = ART_BOX.equals(aktuell.art());
            for (Fenster f : repo.offeneUndGeplanteFenster(jetzt)) {
                if (istBox ? f.boxId().equals(aktuell.id()) : f.technikerId().equals(aktuell.id())) {
                    schliesse(f, jetzt, akteur, istBox ? "box_gesperrt" : "techniker_gesperrt");
                }
            }
            repo.protokollieren(akteur.sub(), akteur.name(), aktion, istBox ? aktuell.id() : null,
                    istBox ? null : aktuell.id(), null,
                    details("kennung", istBox ? aktuell.edgeRef() : aktuell.name(), "grund",
                            leerZuNull(grund)));
            return repo.zugang(aktuell.id()).orElseThrow();
        });
    }

    private Zugang entsperren(Zugang zugang, Akteur akteur, String aktion) {
        return repo.schreibend(() -> {
            Zugang aktuell = vorhandenOder404(zugang.id());
            if (aktuell.aktiv()) {
                return aktuell;
            }
            repo.statusSetzen(aktuell.id(), AKTIV, akteur.sub());
            boolean istBox = ART_BOX.equals(aktuell.art());
            repo.protokollieren(akteur.sub(), akteur.name(), aktion, istBox ? aktuell.id() : null,
                    istBox ? null : aktuell.id(), null,
                    details("kennung", istBox ? aktuell.edgeRef() : aktuell.name()));
            return repo.zugang(aktuell.id()).orElseThrow();
        });
    }

    private void schliesse(Fenster f, Instant jetzt, Akteur akteur, String anlass) {
        repo.fensterSchliessen(f.id(), jetzt, akteur.sub(), akteur.name());
        repo.protokollieren(akteur.sub(), akteur.name(), "fenster_geschlossen", f.boxId(), f.technikerId(),
                f.id(), details("edgeRef", f.edgeRef(), "techniker", f.technikerName(), "anlass", anlass,
                        "planmaessigesEnde", f.ende().toString()));
    }

    private Zugang boxOder404(String edgeRef) {
        return repo.box(edgeRef).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                "Für " + edgeRef + " ist kein Tunnel-Schlüssel hinterlegt."));
    }

    /** Ein gelöschter Zugang ist für jede Regel weg: 404 wie ein unbekannter. */
    private Zugang technikerOder404(UUID id) {
        return repo.zugang(id).filter(z -> ART_TECHNIKER.equals(z.art()) && !z.geloescht())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Diesen Techniker-Zugang gibt es nicht."));
    }

    /**
     * Der Stand eines Zugangs INNERHALB der Schreib-Transaktion. Wurde er
     * zwischen der Prüfung und der Sperre gelöscht, endet die Änderung mit
     * 404 statt einen gelöschten Zugang zurückzugeben oder wieder zuzulassen.
     */
    private Zugang vorhandenOder404(UUID id) {
        return repo.zugang(id).filter(z -> !z.geloescht())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Diesen Zugang gibt es nicht mehr."));
    }

    private String freieAdresse(Ipv4Netz netz, String bezeichnung) {
        return netz.freieAdresse(repo.belegteAdressen(netz)).map(Ipv4Netz::text)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                        "Im " + bezeichnung + " " + netz + " ist keine Adresse mehr frei."));
    }

    private static String schluesselOder400(String publicKey) {
        String schluessel = publicKey == null ? "" : publicKey.trim();
        if (!WireguardSchluessel.gueltig(schluessel)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Das ist kein öffentlicher WireGuard-Schlüssel (44 Zeichen Base64, endet auf „=\").");
        }
        return schluessel;
    }

    /**
     * Warum ein Schlüssel nicht (noch einmal) vergeben wird. Der Schlüssel
     * eines gelöschten Zugangs bleibt dauerhaft vergeben: das sagt der Satz,
     * statt auf einen Zugang zu zeigen, den das Portal nicht mehr listet.
     */
    private static String schluesselVergeben(Zugang z) {
        if (z.geloescht()) {
            return "Dieser Schlüssel gehörte dem gelöschten Zugang „" + z.name() + "\" und wird nicht wieder "
                    + "vergeben. Bitte auf dem Gerät ein neues Schlüsselpaar erzeugen.";
        }
        return "Dieser Schlüssel ist schon " + beschreibe(z)
                + " zugeordnet. Jedes Gerät braucht seinen eigenen Schlüssel.";
    }

    private static String beschreibe(Zugang z) {
        return ART_BOX.equals(z.art()) ? "der Box " + z.edgeRef() : "dem Zugang „" + z.name() + "\"";
    }

    private String details(String... paare) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < paare.length; i += 2) {
            if (paare[i + 1] != null) {
                m.put(paare[i], paare[i + 1]);
            }
        }
        try {
            return json.writeValueAsString(m);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String leerZuNull(String text) {
        return text == null || text.isBlank() ? null : text.trim();
    }

    private static int begrenze(int limit) {
        return Math.max(1, Math.min(limit, 500));
    }

    static String dauerText(Duration d) {
        long minuten = d.toMinutes();
        if (minuten % 60 == 0) {
            long stunden = minuten / 60;
            return stunden == 1 ? "1 Stunde" : stunden + " Stunden";
        }
        return minuten + " Minuten";
    }
}
