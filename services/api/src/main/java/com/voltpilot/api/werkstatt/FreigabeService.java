package com.voltpilot.api.werkstatt;

import com.voltpilot.api.fernwartung.Akteur;
import com.voltpilot.api.werkstatt.FreigabeRepository.Abbild;
import com.voltpilot.api.werkstatt.FreigabeRepository.Freigabe;
import com.voltpilot.api.werkstatt.FreigabeRepository.Programm;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Freigabe der Werkstatt (Werkstatt-Automatik V1, Entscheide WI-4 A und
 * WI-9 A): das Okay eines VoltPilot-Admins an den Werkstatt-Dienst, Boxen
 * einzurichten - welche Fassungen und bis wann. Sie gilt für jede Box, die in
 * der Zeit eingesteckt wird, eine nach der anderen; die Obergrenze ist nur ein
 * Schutz.
 *
 * <p>Regeln wie der Zwilling im Dienst ({@code services/werkstatt-dienst/
 * internal/freigabe}): Box-Art nur {@code mango}, höchstens 92 Tage, Obergrenze
 * 1 bis 200, Prüfsummen 64 Zeichen hex, Quellen nur https, OpenWrt-Abbild ein
 * sysupgrade-Abbild seiner Fassung, Edge Light eine Fassung
 * {@code edge-light-JJJJ.MM.N}. Das LAN-Netz der Boxen gehört nicht hierher:
 * Es ist Konfiguration des Dienstes, weil die Brücke darin eine Adresse braucht.
 * Je Box-Art läuft höchstens eine Freigabe;
 * eine neue verlangt, die laufende erst zu beenden.
 */
@Service
public class FreigabeService {

    public static final String MANGO = "mango";
    public static final Duration MAX_DAUER = Duration.ofDays(92);

    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern OPENWRT = Pattern.compile("^[0-9]{2}\\.[0-9]{2}\\.[0-9]+$");
    private static final Pattern ABBILD = Pattern.compile("^[A-Za-z0-9._-]+-sysupgrade\\.bin$");
    private static final Pattern EDGE_LIGHT = Pattern.compile("^edge-light-[0-9]{4}\\.(0[1-9]|1[0-2])\\.(0|[1-9][0-9]*)$");
    private static final DateTimeFormatter MONAT = DateTimeFormatter.ofPattern("yyyy-MM").withZone(ZoneId.of("Europe/Berlin"));

    /** Was ein Admin zum Freigeben angibt. */
    public record Antrag(String boxArt, Integer tage, Integer obergrenze, Abbild openwrt, Programm edgeLight,
            String notiz) {
    }

    /** Eine Freigabe mit ihrem Stand zu einem Zeitpunkt. */
    public record Stand(Freigabe freigabe, String zustand, String grund) {
    }

    private final FreigabeRepository repo;
    private Clock uhr = Clock.systemUTC();

    public FreigabeService(FreigabeRepository repo) {
        this.repo = repo;
    }

    /** Für Tests: eine andere Uhr. */
    void setzeUhr(Clock uhr) {
        this.uhr = uhr;
    }

    // ── Lesen ─────────────────────────────────────────────────────────────

    public List<Stand> alle() {
        Instant jetzt = uhr.instant();
        return repo.alle().stream().map(f -> stand(f, jetzt)).toList();
    }

    /** Die laufende Freigabe einer Box-Art, wenn eine läuft. */
    public Optional<Freigabe> laufend(String boxArt) {
        return repo.laufend(boxArt, uhr.instant()).stream().findFirst();
    }

    /** {@code laufend}, {@code beendet} oder {@code abgelaufen}, mit Grund in Worten. */
    public static Stand stand(Freigabe f, Instant jetzt) {
        if (f.beendetAm() != null) {
            return new Stand(f, "beendet", "Freigabe " + f.kennung() + " ist beendet.");
        }
        if (!jetzt.isBefore(f.gueltigBis())) {
            return new Stand(f, "abgelaufen", "Freigabe " + f.kennung() + " ist abgelaufen.");
        }
        return new Stand(f, "laufend", null);
    }

    // ── Schreiben ─────────────────────────────────────────────────────────

    /** Werkstatt freigeben: legt eine neue Freigabe an, gültig ab jetzt. */
    public Freigabe erteilen(Antrag a, Akteur akteur) {
        String boxArt = a.boxArt() == null || a.boxArt().isBlank() ? MANGO : a.boxArt().trim();
        List<String> fehler = pruefe(boxArt, a);
        if (!fehler.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
                    "Freigabe ungültig: " + String.join("; ", fehler));
        }
        String notiz = a.notiz() == null || a.notiz().isBlank() ? null : a.notiz().trim();
        return repo.schreibend(() -> {
            Instant jetzt = uhr.instant();
            List<Freigabe> laufende = repo.laufend(boxArt, jetzt);
            if (!laufende.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Für " + boxArt + " läuft schon die Freigabe "
                        + laufende.get(0).kennung() + ". Erst sie beenden, dann neu freigeben.");
            }
            String kennung = naechsteKennung(boxArt, jetzt);
            repo.anlegen(kennung, boxArt, jetzt, jetzt.plus(Duration.ofDays(a.tage())), a.obergrenze(),
                    a.openwrt(), a.edgeLight(), notiz, akteur.sub(), akteur.name());
            return repo.mitKennung(kennung).orElseThrow();
        });
    }

    /** Freigabe beenden: ab jetzt richtet der Dienst unter ihr keine Box mehr ein. */
    public Freigabe beenden(String kennung, Akteur akteur) {
        return repo.schreibend(() -> {
            Freigabe f = repo.mitKennung(kennung).orElseThrow(() -> new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "Keine Freigabe " + kennung + "."));
            if (f.beendetAm() != null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Freigabe " + kennung + " ist schon beendet.");
            }
            repo.beenden(f.id(), akteur.sub(), akteur.name());
            return repo.mitKennung(kennung).orElseThrow();
        });
    }

    /** {@code JJJJ-MM-<box-art>-<n>}, n laufend je Monat (Berliner Uhr) und Box-Art. */
    private String naechsteKennung(String boxArt, Instant jetzt) {
        String praefix = MONAT.format(jetzt) + "-" + boxArt + "-";
        int max = 0;
        for (String k : repo.kennungenMit(praefix)) {
            String rest = k.substring(praefix.length());
            if (rest.matches("[1-9][0-9]*")) {
                max = Math.max(max, Integer.parseInt(rest));
            }
        }
        return praefix + (max + 1);
    }

    static List<String> pruefe(String boxArt, Antrag a) {
        List<String> f = new ArrayList<>();
        if (!MANGO.equals(boxArt)) {
            f.add("boxArt " + boxArt + ": V1 kennt nur mango (der Raspberry Pi kommt mit V2)");
        }
        if (a.tage() == null || a.tage() < 1 || a.tage() > MAX_DAUER.toDays()) {
            f.add("tage: 1 bis " + MAX_DAUER.toDays());
        }
        if (a.obergrenze() == null || a.obergrenze() < 1 || a.obergrenze() > 200) {
            f.add("obergrenze: 1 bis 200");
        }
        Abbild o = a.openwrt();
        if (o == null) {
            f.add("openwrt fehlt");
        } else {
            if (o.fassung() == null || !OPENWRT.matcher(o.fassung()).matches()) {
                f.add("openwrt.fassung: Form 25.12.5");
            }
            if (o.datei() == null || !ABBILD.matcher(o.datei()).matches()) {
                f.add("openwrt.datei: ein sysupgrade-Abbild (…-sysupgrade.bin)");
            } else if (o.fassung() != null && !o.datei().contains("-" + o.fassung() + "-")) {
                f.add("openwrt.datei passt nicht zur Fassung " + o.fassung());
            }
            if (o.sha256() == null || !SHA256.matcher(o.sha256()).matches()) {
                f.add("openwrt.sha256: 64 Zeichen 0-9a-f");
            }
            if (!https(o.quelle())) {
                f.add("openwrt.quelle: eine https-Adresse");
            }
        }
        Programm e = a.edgeLight();
        if (e == null) {
            f.add("edgeLight fehlt");
        } else {
            if (e.fassung() == null || !EDGE_LIGHT.matcher(e.fassung()).matches()) {
                f.add("edgeLight.fassung: Form edge-light-JJJJ.MM.N");
            }
            if (!https(e.quelle())) {
                f.add("edgeLight.quelle: eine https-Adresse");
            }
            if (e.programmSha256() == null || !SHA256.matcher(e.programmSha256()).matches()) {
                f.add("edgeLight.programmSha256: 64 Zeichen 0-9a-f");
            }
            if (e.skripteSha256() == null || !SHA256.matcher(e.skripteSha256()).matches()) {
                f.add("edgeLight.skripteSha256: 64 Zeichen 0-9a-f");
            }
        }
        if (a.notiz() != null && a.notiz().length() > 500) {
            f.add("notiz: höchstens 500 Zeichen");
        }
        return f;
    }

    private static boolean https(String s) {
        if (s == null || s.isBlank() || s.chars().anyMatch(Character::isWhitespace)) {
            return false;
        }
        try {
            URI u = new URI(s);
            return "https".equals(u.getScheme()) && u.getHost() != null && u.getUserInfo() == null;
        } catch (java.net.URISyntaxException e) {
            return false;
        }
    }
}
