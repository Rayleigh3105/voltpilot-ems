package com.voltpilot.api.werkstatt;

import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.ota.BoxArt;
import com.voltpilot.api.ota.ReleaseManifest;
import com.voltpilot.api.ota.RolloutService;
import com.voltpilot.api.web.dto.EdgeReleaseDto;
import com.voltpilot.api.werkstatt.FreigabeRepository.Abbild;
import com.voltpilot.api.werkstatt.FreigabeRepository.Betrieb;
import com.voltpilot.api.werkstatt.FreigabeRepository.Freigabe;
import com.voltpilot.api.werkstatt.FreigabeRepository.Programm;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Werkstatt nimmt immer die neueste Fassung (Auftrag
 * vp-werkstatt-immer-neueste, Entscheid des Captains 16.11.2026: A). Kein
 * Formular: Die Werkstatt läuft, bis jemand sie anhält.
 *
 * <ul>
 *   <li><b>Edge Light</b> ist die neueste zuweisbare signierte Fassung der
 *       Linie Edge Light - dieselbe Regel wie beim ersten Verbinden
 *       ({@link RolloutService#neuesteFassung}). Programm-Prüfsumme (Mango,
 *       {@value #MANGO_ARCH}) und Skriptstand kommen aus dem SIGNIERTEN
 *       Manifest, die Quelle ist das Forgejo-Release der Fassung - nie aus
 *       unsigniertem Text. Trägt die neueste Fassung ihren Skriptstand nicht im
 *       Manifest, wartet die Werkstatt; sie weicht nicht auf eine ältere aus.</li>
 *   <li><b>OpenWrt</b> steht fest im Code ({@link WerkstattOpenWrt}).</li>
 *   <li><b>Anhalten</b> und <b>Fortsetzen</b> (nur Plattform) stehen mit wer,
 *       wann und warum im Protokoll {@code werkstatt_betrieb}.</li>
 *   <li>Die <b>Tagesgrenze</b> (Berliner Tag) zählt verschiedene Boxen, die
 *       eingelöst haben, über alle Freigaben.</li>
 * </ul>
 *
 * <p><b>Der Beleg bleibt eine Zeile:</b> Für den Dienst legt die Regel je
 * Berliner Tag und Inhalt eine Zeile in {@code werkstatt_freigabe} an
 * ({@code quelle = regel}, Kennung {@code JJJJ-MM-mango-N} wie bisher, gültig
 * bis Mitternacht und {@link #NACHLAUF}, Obergrenze = was von der Tagesgrenze
 * übrig ist). Code, Einlösung und Abnahme hängen an ihr wie an einer Freigabe
 * von Hand, und der Dienst liest sie in derselben Form wie bisher. Wechselt die
 * neueste Fassung, entsteht eine neue Zeile; die alte bleibt gültig, damit ein
 * laufender Lauf bei seiner Fassung bleibt.
 *
 * <p><b>Übergang:</b> Solange die neueste Fassung ihren Skriptstand nicht im
 * Manifest trägt (Fassungen vor diesem Auftrag), gilt eine noch laufende
 * Freigabe von Hand weiter, bis sie abläuft.
 */
@Service
public class WerkstattRegel {

    private static final Logger log = LoggerFactory.getLogger(WerkstattRegel.class);

    /** Die Mango (Edge Light). */
    public static final String MANGO = FreigabeService.MANGO;
    /** Der WAGO PFC200 (Edge Industrie): das zweite Gerät der Werkstatt, mit eigener Regel-Zeile. */
    public static final String PFC200 = "pfc200";
    /** Die Geräte, die die Werkstatt einrichtet. */
    public static final List<String> GERAETE = List.of(MANGO, PFC200);
    /** Die Bauart der Mango im Manifest. */
    public static final String MANGO_ARCH = "linux/mipsle";
    /** Die Bauart des PFC200 im Manifest (ARMv7). */
    public static final String PFC200_ARCH = "linux/arm";
    /** Wer eine Zeile der Regel „erteilt“ hat. */
    public static final String AKTEUR = "werkstatt-regel";
    public static final String AKTEUR_NAME = "Regel: neueste Fassung";
    /** So lange gilt die Zeile eines Tages nach Mitternacht weiter (ein Lauf, der kurz davor begann). */
    public static final Duration NACHLAUF = Duration.ofHours(1);
    /** Die Quelle der Edge-Light-Fassungen: das Forgejo-Release, an dem der Release-Lauf sie anhängt. */
    public static final String QUELLE_VORGABE = "https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/";

    static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final DateTimeFormatter MONAT = DateTimeFormatter.ofPattern("yyyy-MM").withZone(BERLIN);
    private static final Pattern EDGE_LIGHT = Pattern.compile(
            "^edge-light-[0-9]{4}\\.(0[1-9]|1[0-2])\\.(0|[1-9][0-9]*)$");
    private static final Pattern EDGE_INDUSTRIE = Pattern.compile(
            "^edge-industrie-[0-9]{4}\\.(0[1-9]|1[0-2])\\.(0|[1-9][0-9]*)$");
    private static final Pattern QUELLE = Pattern.compile("^https://[^/@\\s]+/[^\\s]*/$");

    /** Läuft, ist angehalten, oder wartet (keine passende Fassung, Tagesgrenze). */
    public enum Zustand {
        LAEUFT, ANGEHALTEN, WARTET
    }

    /**
     * Was die Regel aufspielt: OpenWrt, Edge Light und das Release, aus dem
     * Edge Light kommt. Beim PFC200 ist {@code openwrt} {@code null} (die
     * Firmware des Geräts fasst die Werkstatt nicht an) und {@code edgeLight}
     * die Edge-Industrie-Fassung mit dem Tunnel-Programm.
     */
    public record Soll(Abbild openwrt, Programm edgeLight, long releaseSeq) {
    }

    /** Das Gerät aus einer Anfrage: leer heißt Mango; ein unbekanntes ist ein Fehler der Anfrage. */
    public static String geraet(String boxArt) {
        if (boxArt == null || boxArt.isBlank()) {
            return MANGO;
        }
        String g = boxArt.trim();
        if (!GERAETE.contains(g)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekanntes Gerät „" + g + "“; die Werkstatt richtet ein: " + String.join(", ", GERAETE) + ".");
        }
        return g;
    }

    /** Das Gerät in Worten. */
    static String name(String geraet) {
        return PFC200.equals(geraet) ? "PFC200" : "Mango";
    }

    /**
     * Der Stand der Werkstatt.
     *
     * @param grund       warum sie nicht läuft oder warum eine Freigabe von Hand gilt ({@code null}: läuft nach Regel)
     * @param neueste     die neueste signierte Edge-Light-Fassung, auch wenn sie (noch) nicht passt
     * @param soll        was die Regel aufspielt; {@code null}, wenn die neueste Fassung nicht passt
     * @param freigabe    die Zeile, die der Dienst bekommt (Regel oder von Hand); {@code null}, wenn keine gilt
     *                    oder die Zeile von heute noch nicht angelegt ist
     * @param angehalten  der Eintrag, mit dem sie angehalten wurde; {@code null}, wenn sie nicht angehalten ist
     * @param heute       verschiedene Boxen, die heute eingelöst haben
     */
    public record Stand(Zustand zustand, String grund, String neueste, Soll soll, Freigabe freigabe,
            Betrieb angehalten, int heute, int tagesgrenze, String geraet) {

        /** Der Stand für den PFC200 (sonst: die Mango). */
        public boolean pfc200() {
            return PFC200.equals(geraet);
        }

        /** Es gilt noch eine Freigabe von Hand (Übergang). */
        public boolean vonHand() {
            return freigabe != null && !freigabe.vonDerRegel();
        }
    }

    private final FreigabeRepository repo;
    private final EinloesungRepository einloesungen;
    private final RolloutService rollouts;
    private final int tagesgrenze;
    private final String quelle;
    private Clock uhr = Clock.systemUTC();

    public WerkstattRegel(FreigabeRepository repo, EinloesungRepository einloesungen, RolloutService rollouts,
            @Value("${voltpilot.werkstatt.tagesgrenze:40}") int tagesgrenze,
            @Value("${voltpilot.werkstatt.edge-light-quelle:" + QUELLE_VORGABE + "}") String quelle) {
        if (tagesgrenze < 1 || tagesgrenze > 200) {
            throw new IllegalArgumentException("voltpilot.werkstatt.tagesgrenze: 1 bis 200, nicht " + tagesgrenze);
        }
        String q = quelle == null || quelle.isBlank() ? QUELLE_VORGABE : quelle.trim();
        if (!q.endsWith("/")) {
            q = q + "/";
        }
        if (!QUELLE.matcher(q).matches()) {
            throw new IllegalArgumentException("voltpilot.werkstatt.edge-light-quelle: eine https-Adresse, nicht " + q);
        }
        this.repo = repo;
        this.einloesungen = einloesungen;
        this.rollouts = rollouts;
        this.tagesgrenze = tagesgrenze;
        this.quelle = q;
    }

    /** Für Tests: eine andere Uhr. */
    void setzeUhr(Clock uhr) {
        this.uhr = uhr;
    }

    public Instant jetzt() {
        return uhr.instant();
    }

    // ── Lesen ─────────────────────────────────────────────────────────────

    /** Der Stand für die Werkstatt-Seite (Mango); legt nichts an. */
    public Stand stand() {
        return stand(MANGO);
    }

    /** Der Stand für ein Gerät; legt nichts an. */
    public Stand stand(String geraet) {
        return berechne(uhr.instant(), false, geraet);
    }

    /**
     * Die neueste passende Fassung ohne Betrieb und Tagesgrenze: was die Werkstatt aufspielen würde, und genau das
     * spielt auch der Fernlauf durch den Tunnel auf (Konzept vp-update-vor-zuordnung, E2 = A).
     *
     * @param name  die neueste signierte Edge-Light-Fassung, auch wenn sie nicht passt ({@code null}: keine)
     * @param soll  was aufgespielt würde; {@code null}, wenn die neueste nicht passt
     * @param grund warum nicht, wenn {@code soll} fehlt
     */
    public record Neueste(String name, Soll soll, String grund) {
    }

    public Neueste neueste() {
        return neueste(MANGO);
    }

    public Neueste neueste(String geraet) {
        Ergebnis e = soll(geraet);
        return new Neueste(e.neueste(), e.soll(), e.grund());
    }

    /**
     * Die Freigabe, die der Dienst bekommt: die Zeile der Regel für heute (wird
     * beim ersten Mal angelegt) oder im Übergang eine laufende von Hand; leer,
     * wenn die Werkstatt angehalten ist oder wartet.
     */
    public Optional<Freigabe> fuerDenDienst() {
        return fuerDenDienst(MANGO);
    }

    /** Die Freigabe für ein Gerät, wie {@link #fuerDenDienst()}. */
    public Optional<Freigabe> fuerDenDienst(String geraet) {
        return Optional.ofNullable(berechne(uhr.instant(), true, geraet).freigabe());
    }

    /** Wie {@link #fuerDenDienst}, aber mit dem Grund als 409, wenn keine gilt. */
    public Freigabe laufendOderGrund() {
        return laufendOderGrund(MANGO);
    }

    public Freigabe laufendOderGrund(String geraet) {
        Stand st = berechne(uhr.instant(), true, geraet);
        if (st.freigabe() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, st.grund());
        }
        return st.freigabe();
    }

    /**
     * Gilt {@code f} gerade noch für neue Codes? Legt nichts an und nimmt keine
     * Sperre - aufrufbar unter der Sperre der Werkstatt.
     */
    public boolean giltNoch(Freigabe f) {
        Stand st = berechne(uhr.instant(), false, f.boxArt());
        return st.freigabe() != null && st.freigabe().id().equals(f.id());
    }

    /**
     * Angehalten? Dann gibt es keinen Code und keine Einlösung. Anhalten und
     * Fortsetzen ist EIN Schalter für die ganze Werkstatt (Mango und PFC200),
     * geführt unter {@link #MANGO}.
     */
    public Optional<Betrieb> angehalten() {
        return repo.betrieb(MANGO, 1).stream().filter(Betrieb::angehalten).findFirst();
    }

    /** Das Protokoll von Anhalten und Fortsetzen, neueste zuerst. */
    public List<Betrieb> verlauf(int anzahl) {
        return repo.betrieb(MANGO, anzahl);
    }

    /**
     * Eine laufende Zeile der Regel mit der Edge-Light-Fassung {@code fassung}:
     * die Zeile, unter der ein Lauf begann, wenn inzwischen eine neuere Fassung
     * gilt („ein laufender Lauf bleibt bei seiner Fassung“).
     */
    public Optional<Freigabe> regelZeileMitFassung(String fassung) {
        Instant jetzt = uhr.instant();
        // Die Linie der Fassung nennt das Gerät.
        String geraet = fassung != null && EDGE_INDUSTRIE.matcher(fassung).matches() ? PFC200 : MANGO;
        return repo.regelSeit(geraet, jetzt.minus(Duration.ofDays(2))).stream()
                .filter(f -> f.laufend(jetzt) && f.edgeLight().fassung().equals(fassung))
                .findFirst();
    }

    /**
     * Die Tagesgrenze: 409, wenn heute schon {@code tagesgrenze} verschiedene
     * Boxen eingelöst haben und {@code edgeRef} nicht darunter ist.
     */
    public void tagesgrenze(String edgeRef) {
        Instant beginn = tagesbeginn(uhr.instant());
        if (!einloesungen.schonSeit(beginn, edgeRef) && einloesungen.boxenSeit(beginn) >= tagesgrenze) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, grenzeErreicht());
        }
    }

    // ── Anhalten und Fortsetzen ───────────────────────────────────────────

    /** Werkstatt anhalten: ab jetzt kein neuer Lauf, kein Code, keine Einlösung. Nur bei Änderung ein Eintrag. */
    public Stand anhalten(String grund, Akteur akteur) {
        return schalten(true, grund, akteur);
    }

    /** Werkstatt fortsetzen. Nur bei Änderung ein Eintrag. */
    public Stand fortsetzen(Akteur akteur) {
        return schalten(false, null, akteur);
    }

    private Stand schalten(boolean anhalten, String grund, Akteur akteur) {
        String g = grund == null || grund.isBlank() ? null : grund.trim();
        if (g != null && g.length() > 500) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT, "grund: höchstens 500 Zeichen");
        }
        repo.schreibend(() -> {
            boolean ist = repo.betrieb(MANGO, 1).stream().findFirst().map(Betrieb::angehalten).orElse(false);
            if (ist != anhalten) {
                repo.betriebEintragen(MANGO, anhalten, g, uhr.instant(), akteur.sub(), akteur.name());
                log.info("Werkstatt {} von {} ({})", anhalten ? "angehalten" : "fortgesetzt", akteur.sub(),
                        g == null ? "ohne Grund" : g);
            }
            return null;
        });
        return stand();
    }

    // ── Die Regel ─────────────────────────────────────────────────────────

    /** Der Beginn des Berliner Tages von {@code t}. */
    static Instant tagesbeginn(Instant t) {
        return LocalDate.ofInstant(t, BERLIN).atStartOfDay(BERLIN).toInstant();
    }

    private Stand berechne(Instant jetzt, boolean anlegen, String geraet) {
        // Der Schalter und die Tagesgrenze gelten für die ganze Werkstatt.
        Betrieb letzter = repo.betrieb(MANGO, 1).stream().findFirst().orElse(null);
        Betrieb halt = letzter != null && letzter.angehalten() ? letzter : null;
        int heute = einloesungen.boxenSeit(tagesbeginn(jetzt));
        Ergebnis e = soll(geraet);
        if (halt != null) {
            return new Stand(Zustand.ANGEHALTEN, "Die Werkstatt ist angehalten.", e.neueste(), e.soll(), null, halt,
                    heute, tagesgrenze, geraet);
        }
        if (e.soll() == null) {
            Optional<Freigabe> vonHand = repo.laufend(geraet, jetzt).stream().filter(f -> !f.vonDerRegel())
                    .findFirst();
            if (vonHand.isPresent()) {
                return new Stand(Zustand.LAEUFT, e.grund(), e.neueste(), null, vonHand.get(), null, heute,
                        tagesgrenze, geraet);
            }
            return new Stand(Zustand.WARTET, e.grund(), e.neueste(), null, null, null, heute, tagesgrenze, geraet);
        }
        if (heute >= tagesgrenze) {
            return new Stand(Zustand.WARTET, grenzeErreicht(), e.neueste(), e.soll(), null, null, heute,
                    tagesgrenze, geraet);
        }
        Freigabe f = zeile(geraet, e.soll(), jetzt).orElse(null);
        if (f == null && anlegen) {
            f = anlegen(geraet, e.soll(), jetzt);
        }
        return new Stand(Zustand.LAEUFT, null, e.neueste(), e.soll(), f, null, heute, tagesgrenze, geraet);
    }

    private String grenzeErreicht() {
        return "Heute haben schon " + tagesgrenze + " Boxen eingerichtet (Tagesgrenze). Ab Mitternacht geht es weiter.";
    }

    /** Die laufende Zeile von heute mit genau diesem Inhalt. */
    private Optional<Freigabe> zeile(String geraet, Soll soll, Instant jetzt) {
        return repo.regelSeit(geraet, tagesbeginn(jetzt)).stream()
                .filter(f -> f.laufend(jetzt) && gleich(f, soll))
                .findFirst();
    }

    private Freigabe anlegen(String geraet, Soll soll, Instant jetzt) {
        return repo.schreibend(() -> {
            Optional<Freigabe> da = zeile(geraet, soll, jetzt);
            if (da.isPresent()) {
                return da.get();
            }
            Instant beginn = tagesbeginn(jetzt);
            Instant bis = LocalDate.ofInstant(jetzt, BERLIN).plusDays(1).atStartOfDay(BERLIN).toInstant()
                    .plus(NACHLAUF);
            int obergrenze = Math.max(1, tagesgrenze - einloesungen.boxenSeit(beginn));
            String kennung = naechsteKennung(geraet, jetzt);
            if (PFC200.equals(geraet)) {
                repo.anlegen(kennung, PFC200, jetzt, bis, obergrenze, null, soll.edgeLight(), soll.releaseSeq(),
                        "Die Werkstatt nimmt die neueste Fassung (Regel); die Firmware des PFC200 bleibt, wie sie ist.",
                        AKTEUR, AKTEUR_NAME);
                log.info("Werkstatt: Regel-Freigabe {} angelegt (Edge Industrie {}, Obergrenze {})", kennung,
                        soll.edgeLight().fassung(), obergrenze);
                return repo.mitKennung(kennung).orElseThrow();
            }
            repo.anlegen(kennung, MANGO, jetzt, bis, obergrenze, soll.openwrt(), soll.edgeLight(), soll.releaseSeq(),
                    "Die Werkstatt nimmt die neueste Fassung (Regel); OpenWrt fest im Code.", AKTEUR, AKTEUR_NAME);
            log.info("Werkstatt: Regel-Freigabe {} angelegt (Edge Light {}, OpenWrt {}, Obergrenze {})", kennung,
                    soll.edgeLight().fassung(), soll.openwrt().fassung(), obergrenze);
            return repo.mitKennung(kennung).orElseThrow();
        });
    }

    /**
     * {@code JJJJ-MM-mango-N} bzw. {@code JJJJ-MM-pfc200-N}, n laufend je Monat
     * und Gerät (Berliner Uhr) - für die Mango dieselbe Reihe wie die Freigaben von Hand.
     */
    private String naechsteKennung(String geraet, Instant jetzt) {
        String praefix = MONAT.format(jetzt) + "-" + geraet + "-";
        int max = 0;
        for (String k : repo.kennungenMit(praefix)) {
            String rest = k.substring(praefix.length());
            if (rest.matches("[1-9][0-9]*")) {
                max = Math.max(max, Integer.parseInt(rest));
            }
        }
        return praefix + (max + 1);
    }

    private static boolean gleich(Freigabe f, Soll soll) {
        return Objects.equals(f.edgeReleaseSeq(), soll.releaseSeq())
                && Objects.equals(f.openwrt(), soll.openwrt())
                && f.edgeLight().equals(soll.edgeLight());
    }

    /** Was die Regel heute aufspielen würde, oder warum nichts. */
    private record Ergebnis(String neueste, Soll soll, String grund) {
    }

    private Ergebnis soll(String geraet) {
        return PFC200.equals(geraet) ? sollPfc200() : sollMango();
    }

    /**
     * Der PFC200: die neueste zuweisbare Edge-Industrie-Fassung, deren
     * signiertes Manifest das Programm für {@value #PFC200_ARCH}, den
     * Skriptstand und das Tunnel-Programm nennt. Fehlt eines davon, wartet die
     * Werkstatt für dieses Gerät; die Mango läuft weiter.
     */
    private Ergebnis sollPfc200() {
        Optional<RolloutService.NeuesteFassung> n = rollouts.neuesteFassung(BoxArt.INDUSTRIE);
        if (n.isEmpty()) {
            return new Ergebnis(null, null, "Im Register liegt keine signierte Edge-Industrie-Fassung.");
        }
        EdgeReleaseDto r = n.get().release();
        String name = r.version();
        if (!n.get().zuweisbar()) {
            return new Ergebnis(name, null, "Die neueste Fassung " + name + " ist noch nicht zuweisbar: "
                    + n.get().nichtZuweisbar());
        }
        if (!EDGE_INDUSTRIE.matcher(name).matches()) {
            return new Ergebnis(name, null, "Die neueste Fassung " + name + " folgt nicht dem Schema "
                    + "edge-industrie-JJJJ.MM.N.");
        }
        ReleaseManifest m;
        try {
            m = ReleaseManifest.read(r.manifest());
        } catch (ReleaseManifest.InvalidManifestException ex) {
            return new Ergebnis(name, null, "Das Manifest der Fassung " + name + " ist nicht lesbar: "
                    + ex.getMessage());
        }
        Optional<ReleaseManifest.Program> programm = m.programs().stream()
                .filter(p -> PFC200_ARCH.equals(p.arch())).findFirst();
        if (programm.isEmpty()) {
            return new Ergebnis(name, null, "Die Fassung " + name + " trägt kein Programm für den PFC200 ("
                    + PFC200_ARCH + ").");
        }
        Optional<ReleaseManifest.Skripte> skripte = m.skripte();
        Optional<ReleaseManifest.Wartung> wartung = m.wartung();
        if (skripte.isEmpty() || wartung.isEmpty()) {
            return new Ergebnis(name, null, "Die Fassung " + name + " trägt Skriptstand und Tunnel-Programm nicht "
                    + "im signierten Manifest. Die Werkstatt nimmt erst eine Fassung, die damit gebaut ist.");
        }
        Programm edge = new Programm(name, quelle + name + "/", programm.get().sha256(), skripte.get().sha256(),
                wartung.get().sha256());
        return new Ergebnis(name, new Soll(null, edge, r.releaseSeq()), null);
    }

    private Ergebnis sollMango() {
        Optional<RolloutService.NeuesteFassung> n = rollouts.neuesteFassung(BoxArt.LIGHT);
        if (n.isEmpty()) {
            return new Ergebnis(null, null, "Im Register liegt keine signierte Edge-Light-Fassung.");
        }
        EdgeReleaseDto r = n.get().release();
        String name = r.version();
        if (!n.get().zuweisbar()) {
            return new Ergebnis(name, null, "Die neueste Fassung " + name + " ist noch nicht zuweisbar: "
                    + n.get().nichtZuweisbar());
        }
        if (!EDGE_LIGHT.matcher(name).matches()) {
            return new Ergebnis(name, null, "Die neueste Fassung " + name + " folgt nicht dem Schema "
                    + "edge-light-JJJJ.MM.N.");
        }
        ReleaseManifest m;
        try {
            m = ReleaseManifest.read(r.manifest());
        } catch (ReleaseManifest.InvalidManifestException ex) {
            return new Ergebnis(name, null, "Das Manifest der Fassung " + name + " ist nicht lesbar: "
                    + ex.getMessage());
        }
        Optional<ReleaseManifest.Program> programm = m.programs().stream()
                .filter(p -> MANGO_ARCH.equals(p.arch())).findFirst();
        if (programm.isEmpty()) {
            return new Ergebnis(name, null, "Die Fassung " + name + " trägt kein Programm für die Mango ("
                    + MANGO_ARCH + ").");
        }
        Optional<ReleaseManifest.Skripte> skripte = m.skripte();
        if (skripte.isEmpty()) {
            return new Ergebnis(name, null, "Die Fassung " + name + " trägt ihren Skriptstand nicht im signierten "
                    + "Manifest. Die Werkstatt nimmt erst eine Fassung, die damit gebaut ist.");
        }
        Programm edge = new Programm(name, quelle + name + "/", programm.get().sha256(), skripte.get().sha256());
        return new Ergebnis(name, new Soll(WerkstattOpenWrt.MANGO, edge, r.releaseSeq()), null);
    }
}
