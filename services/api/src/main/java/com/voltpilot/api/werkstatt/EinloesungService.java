package com.voltpilot.api.werkstatt;

import com.voltpilot.api.enrollment.Csrs;
import com.voltpilot.api.enrollment.EnrollmentDeviceLookup;
import com.voltpilot.api.enrollment.EnrollmentRepository;
import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.fernwartung.FernwartungProperties;
import com.voltpilot.api.fernwartung.FernwartungRepository.Fenster;
import com.voltpilot.api.fernwartung.FernwartungRepository.Zugang;
import com.voltpilot.api.fernwartung.FernwartungService;
import com.voltpilot.api.fernwartung.Ipv4Netz;
import com.voltpilot.api.web.EdgeRef;
import com.voltpilot.api.werkstatt.EinloesenVertrag.Anfrage;
import com.voltpilot.api.werkstatt.EinloesungRepository.Code;
import com.voltpilot.api.werkstatt.EinloesungRepository.Einloesung;
import com.voltpilot.api.werkstatt.EinloesungRepository.Festgehalten;
import com.voltpilot.api.werkstatt.FreigabeRepository.Freigabe;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.bouncycastle.pkcs.PKCS10CertificationRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Einmal-Code und Einlösen (Werkstatt-Automatik V1, Konzept §7), damit D2.
 *
 * <p><b>Code ausgeben</b> (nur der Werkstatt-Dienst): in einer laufenden
 * Freigabe, für eine erzeugte Referenz mit gültigem Prüfzeichen, die nicht
 * gekoppelt ist und noch kein Zertifikat hat. Der Code gilt 30 Minuten und
 * einmal; die API behält nur seinen sha256. Ein neuer Code ersetzt den offenen.
 * Die Box kommt dabei ins Werkstatt-Register.
 *
 * <p><b>Einlösen</b> (die Box, ohne Konto): Die Anfrage ist mit dem
 * Geräteschlüssel signiert und trägt die Zertifikatsanfrage mit demselben
 * Schlüssel. Die API hält den Schlüssel fest, hinterlegt den Tunnel-Schlüssel
 * ({@link FernwartungService#schluesselHinterlegen}), öffnet 30 Minuten
 * Probe-Fenster für den Techniker-Zugang des Dienstes und speichert die
 * Zertifikatsanfrage der Box (sie ersetzt eine fremde, die vorher kam).
 * Danach nimmt die Zertifikatsanfrage nur noch diesen Schlüssel an.
 *
 * <p>Gegen Raten: Ein unbekannter, abgelaufener, ersetzter oder fremder Code
 * und eine falsche Signatur bekommen dieselbe Antwort; das Rate-Limit sitzt
 * an der Route.
 */
@Service
public class EinloesungService {

    private static final Logger log = LoggerFactory.getLogger(EinloesungService.class);

    public static final Duration CODE_DAUER = Duration.ofMinutes(30);
    public static final Duration PROBE_DAUER = Duration.ofMinutes(30);
    /** Dieselbe Antwort für jeden Code, der nicht gilt, und jede falsche Signatur. */
    public static final String UNGUELTIG = "Der Code gilt nicht.";
    public static final String FESTGEHALTEN = "schluessel_festgehalten";

    private static final String BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

    /** Was der Dienst bekommt; der Code steht nur hier und nur einmal. */
    public record Ausgabe(String code, String edgeRef, String freigabe, Instant gueltigBis, boolean tausch) {
    }

    /** Was die Box zurückbekommt; nichts davon ist geheim. */
    public record Eingeloest(Einloesung einloesung, Freigabe freigabe, FernwartungService.Ergebnis tunnel,
            Fenster fenster, FernwartungProperties server, String boxServerAdresse) {
    }

    private final EinloesungRepository repo;
    private final FreigabeRepository freigaben;
    private final FernwartungService fernwartung;
    private final WerkstattService werkstatt;
    private final EnrollmentDeviceLookup geraete;
    private final EnrollmentRepository enrollments;
    private final String technikerZugang;
    private final SecureRandom zufall = new SecureRandom();
    private Clock uhr = Clock.systemUTC();

    public EinloesungService(EinloesungRepository repo, FreigabeRepository freigaben, FernwartungService fernwartung,
            WerkstattService werkstatt, EnrollmentDeviceLookup geraete, EnrollmentRepository enrollments,
            @Value("${voltpilot.werkstatt.techniker-zugang:}") String technikerZugang) {
        this.repo = repo;
        this.freigaben = freigaben;
        this.fernwartung = fernwartung;
        this.werkstatt = werkstatt;
        this.geraete = geraete;
        this.enrollments = enrollments;
        this.technikerZugang = technikerZugang == null ? "" : technikerZugang.trim();
    }

    void setzeUhr(Clock uhr) {
        this.uhr = uhr;
    }

    // ── Code ausgeben ─────────────────────────────────────────────────────

    public Ausgabe codeAusgeben(String edgeRef, boolean tausch, Akteur dienst) {
        if (edgeRef == null || !EdgeRef.isValid(edgeRef)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
                    "Einen Code gibt es nur für eine Kennung der Box mit gültigem Prüfzeichen (edge-…).");
        }
        technikerZugang();
        Freigabe f = laufendeFreigabe();
        boxFrei(edgeRef);
        obergrenze(f, edgeRef);
        // Ins Register, bevor die Sperre genommen wird: anlegen nimmt sie selbst
        // (eigene Verbindung), verschachtelt warteten beide aufeinander.
        werkstatt.anlegen(edgeRef, WerkstattService.EDGE_LIGHT, List.of(),
                "Vom Werkstatt-Dienst aufgenommen, Freigabe " + f.kennung(), dienst);
        String code = neuerCode();
        Instant ab = uhr.instant();
        Instant bis = ab.plus(CODE_DAUER);
        repo.schreibend(() -> {
            Freigabe nochImmer = laufendeFreigabe();
            if (!nochImmer.id().equals(f.id())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Die Freigabe hat eben gewechselt.");
            }
            int ersetzt = repo.offeneErsetzen(edgeRef);
            repo.codeAnlegen(f.id(), edgeRef, EinloesenVertrag.sha256Hex(code), tausch, ab, bis, dienst.sub());
            log.info("Werkstatt: Einmal-Code für {} ausgegeben (Freigabe {}, Tausch {}, ersetzt {})", edgeRef,
                    f.kennung(), tausch, ersetzt);
            return null;
        });
        return new Ausgabe(code, edgeRef, f.kennung(), bis, tausch);
    }

    // ── Einlösen ──────────────────────────────────────────────────────────

    public Eingeloest einloesen(Anfrage a) {
        List<String> form = EinloesenVertrag.formfehler(a);
        if (!form.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Anfrage ungültig: " + String.join("; ", form));
        }
        Instant jetzt = uhr.instant();
        Code code = repo.codeMitHash(EinloesenVertrag.sha256Hex(a.code())).orElseThrow(EinloesungService::ungueltig);
        if (!code.edgeRef().equals(a.edgeRef())) {
            throw ungueltig();
        }
        if (code.eingeloestAm() != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Code ist schon eingelöst. Für einen neuen Lauf holt der Werkstatt-Dienst einen neuen.");
        }
        if (!code.offen(jetzt)) {
            throw ungueltig();
        }
        Freigabe f = freigaben.mitId(code.freigabeId()).filter(x -> x.laufend(jetzt))
                .orElseThrow(EinloesungService::ungueltig);
        if (!EinloesenVertrag.signaturGueltig(a)) {
            throw ungueltig();
        }
        PKCS10CertificationRequest csr = Csrs.parseAndValidate(a.csrPem());
        String schluessel = EinloesenVertrag.spki(EinloesenVertrag.geraeteSchluessel(a.geraeteSchluessel()));
        if (!Csrs.schluesselSpki(csr).equals(schluessel)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
                    "Die Zertifikatsanfrage trägt einen anderen Schlüssel als die Einlösung.");
        }
        if (!a.fassung().equals(f.edgeLight().fassung())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Die Box meldet die Fassung " + a.fassung()
                    + ", die Freigabe " + f.kennung() + " nennt " + f.edgeLight().fassung() + ".");
        }
        boxFrei(a.edgeRef());
        Optional<Festgehalten> fest = repo.festgehalten(a.edgeRef());
        if (fest.isPresent() && !fest.get().geraeteSchluessel().equals(schluessel) && !code.tausch()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, FESTGEHALTEN + ": Für " + a.edgeRef()
                    + " ist schon ein anderer Geräteschlüssel festgehalten. Eine neu aufgespielte Box braucht einen "
                    + "Code für einen Tausch.");
        }
        obergrenze(f, a.edgeRef());
        Zugang techniker = technikerZugang();
        Akteur werkstattAkteur = new Akteur("werkstatt-einloesung", "Werkstatt, Freigabe " + f.kennung());

        FernwartungService.Hinterlegt tunnel = fernwartung.schluesselHinterlegen(a.edgeRef(), a.wireguardSchluessel(),
                code.tausch(), "Werkstatt, Freigabe " + f.kennung(), werkstattAkteur);
        // Ein Fenster aus einem früheren Versuch an dieser Box zuerst schließen:
        // Je Paar gibt es nur eins, und die Probe gehört zu dieser Einlösung.
        for (Fenster alt : fernwartung.fenster(a.edgeRef(), techniker.id(), 20)) {
            if (alt.geschlossenAm() == null && alt.ende().isAfter(fernwartung.jetzt())) {
                fernwartung.fensterSchliessen(alt.id(), werkstattAkteur);
            }
        }
        Fenster fenster = fernwartung.fensterOeffnen(a.edgeRef(), techniker.id(),
                "Werkstatt-Probe, Freigabe " + f.kennung(), PROBE_DAUER, null, werkstattAkteur);

        Einloesung e = repo.schreibend(() -> {
            if (!repo.codeEinloesen(code.id(), uhr.instant())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Dieser Code ist schon eingelöst.");
            }
            String sha = EinloesenVertrag.sha256Hex(java.util.Base64.getDecoder().decode(schluessel));
            UUID id = repo.einloesungAnlegen(code.id(), f.id(), a.edgeRef(), a.fassung(), schluessel, sha,
                    a.wireguardSchluessel(), a.hostSchluessel(), tunnel.box().adresse(), fenster.id(), code.tausch());
            repo.festhalten(a.edgeRef(), schluessel, sha, id);
            return repo.einloesungen(a.edgeRef()).get(0);
        });
        // Die Zertifikatsanfrage der Box gilt ab jetzt (eine fremde davor ist damit ersetzt).
        if (!enrollments.upsertCsr(a.edgeRef(), a.csrPem(), "werkstatt-einloesung " + f.kennung())) {
            log.warn("Werkstatt: Für {} lag schon ein Zertifikat vor; die Zertifikatsanfrage blieb, wie sie war",
                    a.edgeRef());
        }
        log.info("Werkstatt: {} eingelöst (Freigabe {}, Geräteschlüssel {}, Adresse {}, Probe-Fenster {})",
                a.edgeRef(), f.kennung(), e.geraeteSchluesselSha256().substring(0, 16), e.tunnelAdresse(),
                fenster.id());
        FernwartungProperties p = fernwartung.konfiguration();
        return new Eingeloest(e, f, tunnel.ergebnis(), fenster, p, Ipv4Netz.text(p.boxNetzwerk().serverAdresse()));
    }

    // ── Dienst: Stand und Probe-Fenster ───────────────────────────────────

    public List<Einloesung> einloesungen(String edgeRef) {
        return repo.einloesungen(edgeRef);
    }

    public Optional<Festgehalten> festgehalten(String edgeRef) {
        return repo.festgehalten(edgeRef);
    }

    /** Schließt ein Probe-Fenster, das eine Einlösung geöffnet hat; jedes andere ist für den Dienst unbekannt. */
    public Fenster probeFensterSchliessen(UUID fensterId, Akteur dienst) {
        repo.einloesungMitFenster(fensterId).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                "Kein Probe-Fenster einer Einlösung."));
        return fernwartung.fensterSchliessen(fensterId, dienst);
    }

    // ── intern ────────────────────────────────────────────────────────────

    private Freigabe laufendeFreigabe() {
        return freigaben.laufend(FreigabeService.MANGO, uhr.instant()).stream().findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                        "Die Werkstatt ist nicht freigegeben."));
    }

    /** Nicht gekoppelt und ohne Zertifikat: nur dann gibt es einen Code und eine Einlösung. */
    private void boxFrei(String edgeRef) {
        if (geraete.findByRef(edgeRef).isPresent()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Die Box " + edgeRef + " ist schon gekoppelt; für sie gibt es keinen Code.");
        }
        if (enrollments.find(edgeRef).map(EnrollmentRepository.Enrollment::issued).orElse(false)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Für " + edgeRef + " ist schon ein Zertifikat ausgestellt; für sie gibt es keinen Code.");
        }
    }

    private void obergrenze(Freigabe f, String edgeRef) {
        if (!repo.schonUnter(f.id(), edgeRef) && repo.boxenUnter(f.id()) >= f.obergrenze()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Die Freigabe " + f.kennung()
                    + " hat ihre Obergrenze von " + f.obergrenze() + " Boxen erreicht.");
        }
    }

    /** Der Techniker-Zugang „Werkstatt-Dienst“ (WI-5): eingerichtet und aktiv, sonst kein Code. */
    private Zugang technikerZugang() {
        UUID id;
        try {
            id = UUID.fromString(technikerZugang);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Für den Werkstatt-Dienst ist kein Techniker-Zugang "
                    + "eingerichtet (voltpilot.werkstatt.techniker-zugang).");
        }
        Zugang z = fernwartung.techniker().stream().filter(t -> t.id().equals(id)).findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT,
                        "Den Techniker-Zugang des Werkstatt-Dienstes gibt es nicht."));
        if (!z.aktiv()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Der Techniker-Zugang „" + z.name() + "“ des Werkstatt-Dienstes ist gesperrt.");
        }
        return z;
    }

    private String neuerCode() {
        byte[] roh = new byte[16];
        zufall.nextBytes(roh);
        StringBuilder s = new StringBuilder("wk-");
        int puffer = 0;
        int bits = 0;
        for (byte b : roh) {
            puffer = (puffer << 8) | (b & 0xff);
            bits += 8;
            while (bits >= 5) {
                s.append(BASE32.charAt((puffer >> (bits - 5)) & 31));
                bits -= 5;
            }
        }
        if (bits > 0) {
            s.append(BASE32.charAt((puffer << (5 - bits)) & 31));
        }
        return s.toString();
    }

    private static ResponseStatusException ungueltig() {
        return new ResponseStatusException(HttpStatus.FORBIDDEN, UNGUELTIG);
    }
}
