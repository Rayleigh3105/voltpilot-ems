package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundRepository.VerbundZeile;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Der Vorbehalt der Bezugsseite aus Messwerten (UEMS AP-15 IP-13, B4, W10, A20, R23): prüfen, selbsttätig erhöhen,
 * zum Senken vorschlagen, freigeben. Nur eine Anlage MIT Gemeinsamer Steuerung und wirksamen Mitgliedern — der Bestand
 * bleibt ohne Zeile (I6, R22).
 *
 * <p><b>Erhöhen</b> verengt nur und geschieht ohne Freigabe: {@link SteuerungsverbundAnteilRepository#vorbehaltSetzen}
 * (Einspeiseseite unverändert), Protokoll {@code vorbehalt}, Zeile {@code erhoeht} und danach
 * {@link SteuerungsverbundAnteilDienst#anteileAendern} — der Zweischritt verengt die Box, deren Anteil fällt, schon im
 * Übergang (R23: 77 → 55 kW). Passt die Auslegung mit dem höheren Vorbehalt nicht mehr ({@code auslegung_passt_nicht}),
 * wird NICHTS erweitert: die Boxen halten das letzte Dokument, der Vorbehalt steht erhöht, die Zeile trägt den Grund,
 * der Zähler {@code voltpilot_uems_vorbehalt_erhoeht_total} zählt die Erhöhung — das ist der Alarm (E2 = A: erst der
 * Termin am Gerät). Läuft beim Erhöhen noch ein Zweischritt, holt der nächste Lauf den Zweischritt nach.
 *
 * <p><b>Senken</b> erweitert und bleibt ein Vorschlag mit Zahl, Herkunft und Zeitraum; wirksam erst über
 * {@link #freigeben} (Plattform-Rolle, danach Zweischritt). Ein Kundenkonto hat keinen Weg dorthin.
 */
@Service
public class VorbehaltDienst {

    private static final Logger log = LoggerFactory.getLogger(VorbehaltDienst.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Protokoll-Art und Gründe. */
    static final String ART = "vorbehalt";
    public static final String GRUND_ERHOEHT = "vorbehalt_aus_messwerten_erhoeht";
    public static final String GRUND_FREIGEGEBEN = "vorbehalt_vorschlag_freigegeben";

    /** Was ein Lauf für eine Anlage getan hat. */
    public record Lauf(VorbehaltRegel.Urteil urteil, UUID zeile, String anteile) {}

    private final SteuerungsverbundRepository verbuende;
    private final SteuerungsverbundAnteilRepository vorbehalte;
    private final SteuerungsverbundAnteilDienst anteile;
    private final VorbehaltRepository repo;
    private Clock uhr = Clock.systemUTC();

    public VorbehaltDienst(SteuerungsverbundRepository verbuende, SteuerungsverbundAnteilRepository vorbehalte,
            SteuerungsverbundAnteilDienst anteile, VorbehaltRepository repo) {
        this.verbuende = verbuende;
        this.vorbehalte = vorbehalte;
        this.anteile = anteile;
        this.repo = repo;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    /** Die Anlagen des Kundenbereichs (RLS) mit Gemeinsamer Steuerung — nur sie prüft der Lauf. */
    public java.util.List<UUID> anlagen() {
        return repo.anlagenMitVerbund();
    }

    /**
     * Prüft die Anlage am Tag {@code heute} (Europe/Berlin; gezählt wird bis gestern). Leer ohne Gemeinsame Steuerung
     * oder ohne wirksame Mitglieder (aufgelöst) — dann geschieht nichts.
     */
    @Transactional
    public Optional<Lauf> pruefen(UUID siteId, LocalDate heute) {
        Optional<VerbundZeile> gefunden = verbuende.derAnlage(siteId);
        if (gefunden.isEmpty() || verbuende.mitglieder(gefunden.get().id(), uhr.instant()).isEmpty()) {
            return Optional.empty();
        }
        VerbundZeile v = gefunden.get();
        ProtokollAkteur wer = ProtokollAkteur.vorbehaltAusMesswerten();
        SteuerungsverbundAnteilRepository.Vorbehalt vb = vorbehalte.vorbehalt(v.id());
        BigDecimal alt = vb.kw().get(Grenzart.BEZUG);
        VorbehaltRegel.Urteil u = VorbehaltRegel.pruefen(alt,
                repo.tage(v.id(), VorbehaltRegel.zeitraumVon(heute), heute.minusDays(1)), heute);
        Optional<VorbehaltRepository.Zeile> offen = repo.offenerVorschlag(v.id());
        switch (u.aktion()) {
            case ERHOEHEN -> {
                vorbehalte.vorbehaltSetzen(v.id(), vb.kw().get(Grenzart.EINSPEISUNG), u.neuKw(), wer.name());
                verbuende.protokoll(TenantContext.get(), v.id(), siteId, ART, zahl(alt), herkunft(u),
                        uhr.instant(), false, GRUND_ERHOEHT, wer);
                offen.ifPresent(z -> repo.entscheiden(z.id(), VorbehaltRepository.HINFAELLIG, wer.name()));
                UUID id = repo.anlegen(TenantContext.get(), v.id(), VorbehaltRepository.ERHOEHT,
                        VorbehaltRepository.WIRKSAM, u, wer.name());
                String ergebnis = zweischritt(siteId, id, wer);
                if (SteuerungsverbundAnteilDienst.Grund.AUSLEGUNG_PASST_NICHT.name().toLowerCase(Locale.ROOT)
                        .equals(ergebnis)) {
                    log.warn("Vorbehalt der Anlage {} selbsttätig auf {} kW erhöht — die Auslegung passt nicht mehr, "
                            + "die Boxen halten ihr letztes Dokument", siteId, u.neuKw());
                }
                return Optional.of(new Lauf(u, id, ergebnis));
            }
            case VORSCHLAGEN -> {
                if (offen.isPresent() && offen.get().neuKw().compareTo(u.neuKw()) == 0
                        && gleich(offen.get().altKw(), alt)) {
                    return Optional.of(new Lauf(u, offen.get().id(), null));
                }
                offen.ifPresent(z -> repo.entscheiden(z.id(), VorbehaltRepository.ERSETZT, wer.name()));
                UUID id = repo.anlegen(TenantContext.get(), v.id(), VorbehaltRepository.VORSCHLAG,
                        VorbehaltRepository.OFFEN, u, wer.name());
                return Optional.of(new Lauf(u, id, nachholen(siteId, v, alt, wer)));
            }
            default -> {
                if (u.grund() == VorbehaltRegel.Grund.UNVERAENDERT) {
                    // die Messung verlangt nicht mehr weniger — ein offener Vorschlag ist erledigt
                    offen.ifPresent(z -> repo.entscheiden(z.id(), VorbehaltRepository.HINFAELLIG, wer.name()));
                }
                return Optional.of(new Lauf(u, null, nachholen(siteId, v, alt, wer)));
            }
        }
    }

    /**
     * Die Freigabe des offenen Vorschlags durch die Plattform-Rolle (G5): der Vorbehalt sinkt, Protokoll, danach
     * Zweischritt. Leer ohne offenen Vorschlag — oder wenn er nicht mehr zum geltenden Vorbehalt passt (dann ist er
     * hinfällig). Der Aufrufer prüft Sichtbarkeit und Verbund.
     */
    @Transactional
    public Optional<Lauf> freigeben(VerbundZeile v, ProtokollAkteur wer) {
        Optional<VorbehaltRepository.Zeile> offen = repo.offenerVorschlag(v.id());
        if (offen.isEmpty()) {
            return Optional.empty();
        }
        VorbehaltRepository.Zeile z = offen.get();
        SteuerungsverbundAnteilRepository.Vorbehalt vb = vorbehalte.vorbehalt(v.id());
        BigDecimal alt = vb.kw().get(Grenzart.BEZUG);
        if (!gleich(z.altKw(), alt)) {
            repo.entscheiden(z.id(), VorbehaltRepository.HINFAELLIG, wer.name());
            return Optional.empty();
        }
        vorbehalte.vorbehaltSetzen(v.id(), vb.kw().get(Grenzart.EINSPEISUNG), z.neuKw(), wer.name());
        repo.entscheiden(z.id(), VorbehaltRepository.FREIGEGEBEN, wer.name());
        VorbehaltRegel.Urteil u = new VorbehaltRegel.Urteil(VorbehaltRegel.Aktion.VORSCHLAGEN, null, alt, z.neuKw(),
                z.hoechstwertKw(), z.hoechstwertVon(), z.zeitraumVon(), z.zeitraumBis(), z.messtage());
        verbuende.protokoll(TenantContext.get(), v.id(), v.siteId(), ART, zahl(alt), herkunft(u), uhr.instant(),
                false, GRUND_FREIGEGEBEN, wer);
        return Optional.of(new Lauf(u, z.id(), zweischritt(v.siteId(), z.id(), wer)));
    }

    /** Der Zweischritt nach einer Änderung des Vorbehalts; das Ergebnis steht an der Zeile. */
    private String zweischritt(UUID siteId, UUID zeile, ProtokollAkteur wer) {
        SteuerungsverbundAnteilDienst.Ergebnis e = anteile.anteileAendern(siteId, wer);
        String code = e.veroeffentlicht() ? "veroeffentlicht" : e.grund().name().toLowerCase(Locale.ROOT);
        repo.anteileNachtragen(zeile, code);
        return code;
    }

    /**
     * Lief beim Erhöhen noch ein Zweischritt, ist die Verengung noch nicht ausgerollt: der nächste Lauf holt sie nach,
     * solange die jüngste Erhöhung den geltenden Vorbehalt gesetzt hat.
     */
    private String nachholen(UUID siteId, VerbundZeile v, BigDecimal alt, ProtokollAkteur wer) {
        Optional<VorbehaltRepository.Zeile> j = repo.juengsteErhoehung(v.id());
        if (j.isEmpty() || !"zweischritt_laeuft".equals(j.get().anteile()) || !gleich(j.get().neuKw(), alt)) {
            return null;
        }
        return zweischritt(siteId, j.get().id(), wer);
    }

    private static boolean gleich(BigDecimal a, BigDecimal b) {
        return a == null ? b == null : b != null && a.compareTo(b) == 0;
    }

    private static String zahl(BigDecimal kw) {
        ObjectNode o = JSON.createObjectNode().put("richtung", "bezug");
        if (kw == null) {
            o.putNull("kw");
        } else {
            o.put("kw", kw);
        }
        return o.toString();
    }

    private static String herkunft(VorbehaltRegel.Urteil u) {
        ObjectNode o = JSON.createObjectNode().put("richtung", "bezug").put("kw", u.neuKw())
                .put("herkunft", "gemessen").put("hoechstwert_kw", u.hoechstwertKw())
                .put("zeitraum_von", u.zeitraumVon().toString()).put("zeitraum_bis", u.zeitraumBis().toString())
                .put("messtage", u.messtage()).put("fassung", VorbehaltRegel.FASSUNG);
        Instant q = u.hoechstwertVon();
        o.put("hoechstwert_von", q == null ? null : q.toString());
        return o.toString();
    }
}
