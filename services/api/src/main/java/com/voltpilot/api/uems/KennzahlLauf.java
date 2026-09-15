package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.KennzahlEingangLeser.Gelesen;
import com.voltpilot.api.uems.KennzahlEingangLeser.Paar;
import com.voltpilot.api.uems.KennzahlRepository.EingangZeile;
import com.voltpilot.api.uems.KennzahlRepository.FassungZeile;
import com.voltpilot.api.uems.KennzahlRepository.Gespeichert;
import com.voltpilot.api.uems.KennzahlRepository.Zeile;
import com.voltpilot.api.uems.KennzahlService.Aufgeloest;
import com.voltpilot.api.uems.KennzahlService.Katalog;
import com.voltpilot.api.uems.KennzahlService.Urteil;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.Date;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/**
 * Der RECHENLAUF der Kennzahlen (UEMS AP-11 IP-6, E3/E4/E5): ein Schritt im Stundentakt ({@link EndgueltigkeitLaeufer})
 * NACH den gemessenen Stufen und den berechneten Messstellen. Er liest, was dort gerade gebildet wurde, und hängt
 * Kennzahl-Werte an {@code kennzahl_wert} und {@code kennzahl_wert_eingang} an.
 *
 * <ul>
 *   <li><b>Ordnung</b> — eine Kennzahl rechnet NACH den Kennzahlen, die sie liest: {@link BerechnetePeriode#reihenfolge}
 *       aufgerufen, nicht nachgebaut. Ein Kreis wird benannt ({@code formel_kreis} mit Kette, {@code haengt_an_kreis})
 *       und nie gerechnet (Q10).</li>
 *   <li><b>Lesen</b> — jeder Eingang über {@link KennzahlEingangLeser}, dieselben Wege wie die Vorschau.</li>
 *   <li><b>Rechnen</b> — NUR {@link KennzahlRegeln#wert}. Die Grundperiode aus den Eingängen, eine Zusammenfassung
 *       Summe durch Summe über ihre Paare derselben Periode. Eine gröbere Periode liefert eine Messstelle, ein
 *       Stammdatum (am Stichtag) und eine Kennzahl selbst; wo ein Eingang das nicht kann (eine Monats-Bezugsgröße im
 *       Jahr) und für jede Zusammenfassung ist sie Summe durch Summe über die eigenen Teilperioden (P2, Q5, K14). Ein
 *       gröberer Eingang wird nie auf feinere Perioden verteilt (E3). Ein Mittel von Quotienten gibt es hier nicht.</li>
 *   <li><b>Zeile oder keine</b> — ohne jeden Periodenwert-Eingang keine Zeile (P4: vor dem Bestehen). Die laufende
 *       Periode erst, wenn alle Eingänge einen Wert tragen; mit Periodenwert-Nenner „keine Werte“ mit Grund
 *       {@code periode_nicht_zu_ende} (P6, K21). Ohne Zahl immer MIT Grund (Q2).</li>
 *   <li><b>Fassung und Version</b> — gerechnet wird mit der Fassung am LETZTEN Tag der Periode (V2). Ein vorläufiger Wert
 *       zieht als neue Zeile derselben Version nach, ein unveränderter schreibt nichts (V3). Ein endgültiger bleibt
 *       stehen: Version n + 1 bildet die Korrektur-Kaskade über {@link #nachKorrektur} (IP-8) mit ihrem Anlass — mit
 *       denselben Wegen und derselben Regel, in IHRER Transaktion —, nie der Regellauf.</li>
 * </ul>
 *
 * <p>Geschrieben wird als Verwaltungsrolle (die einzige mit INSERT auf die Werte) in EINER Transaktion je Periode, je
 * Kennzahl serialisiert; die Tabellen sind append-only für jede Rolle. Er wirft nie für einen Kundenbereich oder eine
 * Kennzahl. Ein Kundenbereich ohne Kennzahl wird nicht einmal gelesen.
 */
@Component
public class KennzahlLauf {

    private static final Logger log = LoggerFactory.getLogger(KennzahlLauf.class);

    /** Wie weit ein Lauf zurückreicht: zwei Jahre — 731 Tagesperioden bleiben unter der Zeilenbremse des Lesemodells. */
    static final int RUECKSCHAU_MONATE = 24;

    /** Eine Kennzahl, deren Rechnung mit einem Fehler abbrach — benannt; die übrigen rechnen weiter. */
    static final String NICHT_GERECHNET = "nicht_gerechnet";

    /** Wie eine Periode entsteht: aus den Eingängen, über die Paare (Ebene) oder über die eigenen Teilperioden (Zeit). */
    static final String DIREKT = "direkt";
    static final String EBENE = "ebene";
    static final String ZEIT = "zeit";

    /** „x von y …“ über die Zeit — die Wörter der Regel {@code x_von_y}. */
    static final Map<String, String> WORT_ZEIT = Map.of("tag", "Tagen", "woche", "Wochen", "monat", "Monaten", "jahr",
            "Jahren");

    /** Der Anlass einer Korrektur an einem Eingang — {@code kennzahl_wert.anlass_art} {@code eingang}. */
    private static final KennzahlRegeln.Anlass EINGANG = new KennzahlRegeln.Anlass("eingang", null);

    private static final Pattern AB = Pattern.compile("^ab (\\d{2}\\.\\d{2}\\.\\d{4})$");
    private static final DateTimeFormatter TAG_TEXT = DateTimeFormatter.ofPattern("dd.MM.uuuu");

    public record Abgelehnt(String kennzahl, String grund, List<String> kette) {}

    public record Lauf(int kennzahlen, int geschrieben, int unveraendert, int endgueltigUnberuehrt,
            List<Abgelehnt> abgelehnt) {}

    /** Ein Eingang der Herkunft, wie er in {@code kennzahl_wert_eingang} steht. */
    record HerkunftEingang(int position, String rolle, String art, String objekt, UUID messstelleId,
            UUID bezugsgroesseId, UUID kennzahlId, BigDecimal wert, BigDecimal zaehler, BigDecimal nenner, String einheit,
            String mengeZustand, BigDecimal abdeckungProzent, Integer version, Integer fassung, List<String> kennzeichen) {

        String text() {
            return eingangText(position, rolle, art, objekt, wert, zaehler, nenner, einheit, mengeZustand,
                    abdeckungProzent, version, fassung, kennzeichen);
        }
    }

    /** Was eine Periode ergibt: das Ergebnis der Regel, was sie las, und wann ihr spätester Eingang endgültig wurde. */
    record Bildung(KennzahlRegeln.Ergebnis ergebnis, List<HerkunftEingang> eingaenge, Instant endgueltigAb) {}

    /** Was die Kaskade neu bildete: eine Kennzahl-Periode, deren endgültiger Wert Version n + 1 wurde. */
    public record Neu(UUID kennzahl, String kennzeichen, String periodeArt, LocalDate von, LocalDate bis, ZoneId zone,
            int version) {}

    /** Was eine Neubildung der Kaskade tat (IP-8). */
    public record Neubildung(int kennzahlen, int geschrieben, int unveraendert, List<Neu> neu,
            List<Abgelehnt> abgelehnt) {}

    /**
     * Der Rahmen der Kaskade: ihre Transaktion, ihr Anlass, ihre Tage — {@code null} im Regellauf. Gelesen und geschrieben
     * wird dann über {@code con}, ein endgültiger Wert wird Version n + 1, und jeder Fehler wirft.
     */
    private record Kaskade(Connection con, String anlass, LocalDate ersterTag, LocalDate letzterTag, List<Neu> neu) {}

    private record Kontext(UUID tenant, Katalog kat, Instant jetzt, Zaehler z, KennzahlEingangLeser leser,
            KennzahlRepository repo, Kaskade kaskade) {}

    /** Eine Kennzahl im Lauf: die Zeitzone ihres Geltungsbereichs, heute dort, die geprüften Fassungen. */
    private record Rahmen(Kontext kx, Zeile k, ZoneId zone, LocalDate heute, Map<UUID, Optional<Urteil>> urteile) {}

    private final JdbcTemplate adminJdbc;
    private final KennzahlService kennzahlen;
    private final KennzahlRepository repo;
    private final KennzahlEingangLeser leser;
    private final ObjectMapper json;
    private final boolean enabled;

    public KennzahlLauf(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, KennzahlService kennzahlen,
            KennzahlRepository repo, KennzahlEingangLeser leser, ObjectMapper json,
            @Value("${voltpilot.uems.kennzahlen.enabled:true}") boolean enabled) {
        this.adminJdbc = adminJdbc;
        this.kennzahlen = kennzahlen;
        this.repo = repo;
        this.leser = leser;
        this.json = json;
        this.enabled = enabled;
    }

    /** Ein ganzer Lauf über alle Kundenbereiche mit Kennzahlen. Wirft nie für einen einzelnen. */
    public Lauf lauf(Instant jetzt) {
        if (!enabled) {
            return new Lauf(0, 0, 0, 0, List.of());
        }
        Zaehler z = new Zaehler();
        for (UUID tenant : adminJdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM kennzahl WHERE archiviert_am IS NULL ORDER BY tenant_id", UUID.class)) {
            UUID vorher = TenantContext.get();
            TenantContext.set(tenant);
            try {
                mandant(new Kontext(tenant, kennzahlen.katalog(), jetzt, z, leser, repo, null));
            } catch (RuntimeException e) {
                log.warn("UEMS Kennzahlen für Kundenbereich {} übersprungen: {}", tenant, e.toString());
            } finally {
                if (vorher == null) {
                    TenantContext.clear();
                } else {
                    TenantContext.set(vorher);
                }
            }
        }
        if (z.geschrieben > 0 || !z.abgelehnt.isEmpty()) {
            log.info("UEMS Kennzahlen: {} Kennzahlen, {} Werte geschrieben, {} unverändert, {} endgültig unberührt, "
                    + "{} abgelehnt", z.kennzahlen, z.geschrieben, z.unveraendert, z.endgueltig, z.abgelehnt.size());
        }
        return new Lauf(z.kennzahlen, z.geschrieben, z.unveraendert, z.endgueltig, List.copyOf(z.abgelehnt));
    }

    private static final class Zaehler {
        int kennzahlen;
        int geschrieben;
        int unveraendert;
        int endgueltig;
        final List<Abgelehnt> abgelehnt = new ArrayList<>();
    }

    // ------------------------------------------------------------------------------ ein Kundenbereich

    private void mandant(Kontext kx) {
        BerechnetePeriode.Reihenfolge r = BerechnetePeriode.reihenfolge(kanten(kx.kat()));
        for (BerechnetePeriode.Abgelehnt a : r.abgelehnt()) {
            log.warn("UEMS Kennzahlen: {} abgelehnt ({}): {}", a.messstelle(), a.grund(), String.join(" → ", a.kette()));
            kx.z().abgelehnt.add(new Abgelehnt(a.messstelle(), a.grund(), a.kette()));
        }
        for (String kz : r.ordnung()) {
            Zeile k = kx.kat().nachKennzeichen(kz).orElseThrow();
            kx.z().kennzahlen++;
            try {
                kennzahl(kx, k);
            } catch (RuntimeException e) {
                log.warn("UEMS Kennzahl {} übersprungen: {}", kz, e.toString());
                kx.z().abgelehnt.add(new Abgelehnt(kz, NICHT_GERECHNET, List.of()));
            }
        }
    }

    /**
     * Die Kanten der Ordnung: jede Kennzahl, die eine wirksame Fassung als Eingang nennt. Eine archivierte ist kein
     * Schlüssel — sie rechnet nicht mehr, ihre Werte werden gelesen (V5).
     */
    private static Map<String, List<String>> kanten(Katalog kat) {
        Map<String, List<String>> lesen = new LinkedHashMap<>();
        for (Zeile k : kat.kennzahlen()) {
            if (k.archiviertAm() != null) {
                continue;
            }
            Set<String> kanten = new LinkedHashSet<>();
            for (FassungZeile f : kat.fassungen(k.id())) {
                if (f.wirksam()) {
                    kat.eingaenge(f.id()).stream().filter(e -> KennzahlRegeln.KENNZAHL.equals(e.art()))
                            .map(EingangZeile::kennzeichen).forEach(kanten::add);
                }
            }
            lesen.put(k.kennzeichen(), List.copyOf(kanten));
        }
        return lesen;
    }

    // ------------------------------------------------------------------------------ die Korrektur-Kaskade (IP-8)

    /**
     * Die Neubildung nach einer Korrektur (AP-11 IP-8, E8 = A) — in der Transaktion {@code con} der Korrektur-Kaskade.
     * Betroffen ist jede Kennzahl, die eine der {@code messstellen} in einer wirksamen Fassung liest, und rekursiv jede, die
     * eine betroffene Kennzahl liest; gerechnet in der Ordnung ihrer Eingänge (dieselbe
     * {@link BerechnetePeriode#reihenfolge} wie im Regellauf, ein Kreis bleibt benannt und ungerechnet). Neu gebildet wird
     * jede Periode, die {@code ersterTag…letzterTag} berührt — mit denselben Wegen und derselben Regel wie im Regellauf:
     * ein endgültiger Wert, der sich ändert, wird Version n + 1 mit {@code beleg} als Anlass („korrigiert (Version n + 1)“),
     * ein vorläufiger zieht nach, ein unveränderter schreibt nichts. Eine nicht betroffene Kennzahl wird nicht gelesen.
     *
     * <p>Gelesen wird, was die Kaskade in dieser Transaktion eben schrieb ({@link KennzahlEingangLeser#mit}). Wirft bei
     * jedem Fehler — die Kaskade rollt dann ALLES zurück. Der Schalter des Regellaufs gilt hier nicht: der Not-Aus nimmt
     * den Stundenschritt, nie die Kaskade.
     */
    public Neubildung nachKorrektur(Connection con, KorrekturKaskade.Betroffen betroffen, Set<UUID> messstellen,
            String beleg) throws SQLException {
        Instant jetzt = Objects.requireNonNull(betroffen.jetzt(), "die Kaskade nennt den Zeitpunkt ihres Laufs");
        UUID vorher = TenantContext.get();
        TenantContext.set(betroffen.tenant());
        try {
            Katalog kat = kennzahlen.katalog();
            Map<String, List<String>> kanten = kanten(kat);
            Set<String> betroffene = betroffene(kat, kanten, messstellen);
            if (betroffene.isEmpty()) {
                return new Neubildung(0, 0, 0, List.of(), List.of());
            }
            JdbcTemplate transaktion = new JdbcTemplate(new SingleConnectionDataSource(con, true));
            KennzahlRepository gespeichert = new KennzahlRepository(transaktion);
            List<Neu> neu = new ArrayList<>();
            Zaehler z = new Zaehler();
            Kontext kx = new Kontext(betroffen.tenant(), kat, jetzt, z,
                    leser.mit(gespeichert, new WertVersionenLeser(transaktion)), gespeichert,
                    new Kaskade(con, beleg, betroffen.ersterTag(), betroffen.letzterTag(), neu));
            BerechnetePeriode.Reihenfolge r = BerechnetePeriode.reihenfolge(kanten);
            for (BerechnetePeriode.Abgelehnt a : r.abgelehnt()) {
                if (betroffene.contains(a.messstelle())) {
                    log.warn("UEMS Kennzahl-Kaskade {}: {} abgelehnt ({}): {}", betroffen.anlass(), a.messstelle(),
                            a.grund(), String.join(" → ", a.kette()));
                    z.abgelehnt.add(new Abgelehnt(a.messstelle(), a.grund(), a.kette()));
                }
            }
            for (String kz : r.ordnung()) {
                if (!betroffene.contains(kz)) {
                    continue;
                }
                Zeile k = kat.nachKennzeichen(kz).orElseThrow();
                z.kennzahlen++;
                // Vor dem ersten Lesen: bis zum Ende der Kaskade schreibt kein Regellauf diese Kennzahl dazwischen.
                sperren(con, betroffen.tenant(), k.id());
                kennzahl(kx, k);
            }
            return new Neubildung(z.kennzahlen, z.geschrieben, z.unveraendert, List.copyOf(neu),
                    List.copyOf(z.abgelehnt));
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    /**
     * Wer von den Messstellen lebt: jede nicht archivierte Kennzahl mit einer davon als Eingang einer wirksamen Fassung,
     * und rekursiv jede, die eine solche Kennzahl liest (über die Kanten der Ordnung).
     */
    static Set<String> betroffene(Katalog kat, Map<String, List<String>> kanten, Set<UUID> messstellen) {
        Set<String> aus = new LinkedHashSet<>();
        for (Zeile k : kat.kennzahlen()) {
            if (k.archiviertAm() == null && kat.fassungen(k.id()).stream().filter(FassungZeile::wirksam)
                    .flatMap(f -> kat.eingaenge(f.id()).stream())
                    .anyMatch(e -> KennzahlRegeln.MESSSTELLE.equals(e.art()) && messstellen.contains(e.objektId()))) {
                aus.add(k.kennzeichen());
            }
        }
        boolean mehr = !aus.isEmpty();
        while (mehr) {
            mehr = false;
            for (Map.Entry<String, List<String>> e : kanten.entrySet()) {
                if (!aus.contains(e.getKey()) && e.getValue().stream().anyMatch(aus::contains)) {
                    aus.add(e.getKey());
                    mehr = true;
                }
            }
        }
        return aus;
    }

    // ------------------------------------------------------------------------------ eine Kennzahl

    private void kennzahl(Kontext kx, Zeile k) {
        ZoneId zone = kennzahlen.geltungVon(k, kx.jetzt()).zone();
        Rahmen r = new Rahmen(kx, k, zone, LocalDate.ofInstant(kx.jetzt(), zone), new HashMap<>());
        List<FassungZeile> wirksam = kx.kat().fassungen(k.id()).stream().filter(FassungZeile::wirksam).toList();
        if (wirksam.isEmpty()) {
            return;
        }
        Set<String> arten = new LinkedHashSet<>();
        for (FassungZeile f : wirksam) {
            urteil(r, f).ifPresent(u -> arten.addAll(u.perioden()));
        }
        LocalDate beginn = r.heute().minusMonths(RUECKSCHAU_MONATE);
        LocalDate erster = wirksam.get(0).gueltigAb();
        if (erster != null && erster.isAfter(beginn)) {
            beginn = erster;
        }
        // Fein vor grob: eine Periode aus Teilperioden liest, was dieser Lauf eben geschrieben hat.
        for (String art : KennzahlRegeln.PERIODEN) {
            // Wochen-Perioden sind IP-12: das Messstellen-Lesemodell kennt kein Wochen-Raster.
            if (arten.contains(art) && !"woche".equals(art)) {
                art(r, art, beginn);
            }
        }
    }

    /** Die geprüfte Berechnung einer gespeicherten Fassung — einmal je Lauf; eine, die nicht trägt, ist benannt. */
    private Optional<Urteil> urteil(Rahmen r, FassungZeile f) {
        Optional<Urteil> schon = r.urteile().get(f.id());
        if (schon != null) {
            return schon;
        }
        Optional<Urteil> u;
        try {
            u = Optional.of(rechnung(r, f));
        } catch (KennzahlAbgelehnt x) {
            log.warn("UEMS Kennzahl {} Fassung {} nicht gerechnet ({}): {}", r.k().kennzeichen(), f.nummer(), x.code(),
                    x.getMessage());
            r.kx().z().abgelehnt.add(new Abgelehnt(r.k().kennzeichen(), x.code(), List.of("Fassung " + f.nummer())));
            u = Optional.empty();
        }
        r.urteile().put(f.id(), u);
        return u;
    }

    /** Die Berechnung einer gespeicherten Fassung, geprüft wie beim Anlegen — wirft {@link KennzahlAbgelehnt}. */
    private Urteil rechnung(Rahmen r, FassungZeile f) {
        List<KennzahlDto.Eingang> eingaenge = r.kx().kat().eingaenge(f.id()).stream()
                .map(e -> new KennzahlDto.Eingang(e.rolle(), e.art(), e.kennzeichen())).toList();
        LocalDate tag = f.gueltigBis() != null && f.gueltigBis().isBefore(r.heute()) ? f.gueltigBis()
                : f.gueltigAb() != null && f.gueltigAb().isAfter(r.heute()) ? f.gueltigAb() : r.heute();
        return kennzahlen.rechnung(f.rechenform(), eingaenge, f.komplement(), null, tag, r.kx().kat());
    }

    /** Alle offenen Perioden EINER Art, je Fassung am letzten Tag gruppiert (V2). */
    private void art(Rahmen r, String art, LocalDate beginn) {
        Zeile k = r.k();
        Kaskade kaskade = r.kx().kaskade();
        // Der Regellauf: vom Beginn bis heute. Die Kaskade: jede Periode, die ihre Tage berührt — auch eine endgültige.
        LocalDate von = BezugsPeriode.spanneUm(kaskade == null ? beginn : kaskade.ersterTag(), art)[0];
        LocalDate bis = BezugsPeriode.spanneUm(kaskade == null ? r.heute() : kaskade.letzterTag(), art)[1];
        Map<LocalDate, Gespeichert> gespeichert = r.kx().repo().werte(k.id(), art, von, bis);
        Map<FassungZeile, List<LocalDate[]>> jeFassung = new LinkedHashMap<>();
        for (LocalDate[] p : KennzahlEingangLeser.perioden(art, von, bis)) {
            Gespeichert g = gespeichert.get(p[0]);
            if (g != null && g.endgueltig() && kaskade == null) {
                r.kx().z().endgueltig++;
                continue;
            }
            r.kx().kat().fassungAm(k.id(), p[1]).ifPresent(f -> jeFassung.computeIfAbsent(f, x -> new ArrayList<>()).add(p));
        }
        for (Map.Entry<FassungZeile, List<LocalDate[]>> e : jeFassung.entrySet()) {
            FassungZeile f = e.getKey();
            Optional<Urteil> ou = urteil(r, f);
            if (ou.isEmpty() || !ou.get().perioden().contains(art)) {
                continue;
            }
            Urteil u = ou.get();
            List<LocalDate[]> perioden = e.getValue();
            LocalDate a = perioden.get(0)[0];
            LocalDate b = perioden.get(perioden.size() - 1)[1];
            switch (weg(u, art)) {
                case DIREKT -> {
                    Aufgeloest zx = rolle(u, "zaehler");
                    Aufgeloest nx = rolle(u, "nenner");
                    Map<String, Gelesen> zg = r.kx().leser().lies(zx, art, a, b);
                    Map<String, Gelesen> ng = r.kx().leser().lies(nx, art, a, b);
                    for (LocalDate[] p : perioden) {
                        String s = BezugsPeriode.schluesselVon(p[0], art);
                        Gespeichert g = gespeichert.get(p[0]);
                        schreiben(r, f, art, p, g, direkt(r, u, new KennzahlRegeln.Periode(art, s), zx, nx, zg.get(s),
                                ng.get(s), g));
                    }
                }
                case EBENE -> {
                    List<Map<String, Paar>> paare = paare(r, u, art, a, b);
                    for (LocalDate[] p : perioden) {
                        String s = BezugsPeriode.schluesselVon(p[0], art);
                        Gespeichert g = gespeichert.get(p[0]);
                        schreiben(r, f, art, p, g, ebene(r, u, new KennzahlRegeln.Periode(art, s), p, paare, g));
                    }
                }
                default -> {
                    String feiner = feinere(u.perioden(), art);
                    Map<LocalDate, Gespeichert> eigene = r.kx().repo().werte(k.id(), feiner, a, b);
                    List<Map<String, Paar>> paare = paare(r, u, art, a, b);
                    for (LocalDate[] p : perioden) {
                        String s = BezugsPeriode.schluesselVon(p[0], art);
                        Gespeichert g = gespeichert.get(p[0]);
                        schreiben(r, f, art, p, g, zeit(r, u, new KennzahlRegeln.Periode(art, s), p, feiner, eigene, paare,
                                g));
                    }
                }
            }
        }
    }

    /**
     * Wie eine Periode entsteht. Die Grundperiode aus den Eingängen (eine Zusammenfassung über ihre Paare); eine gröbere
     * über die eigenen Teilperioden, wenn die Kennzahl eine Zusammenfassung ist oder eine Bezugsgröße sie nicht selbst
     * liefert — sonst liefern Messstelle, Stammdatum und Kennzahl die gröbere Periode selbst.
     */
    static String weg(Urteil u, String art) {
        boolean zusammenfassung = KennzahlRegeln.ZUSAMMENFASSUNG.equals(u.rechenform());
        if (art.equals(u.grundperiode())) {
            return zusammenfassung ? EBENE : DIREKT;
        }
        if (zusammenfassung) {
            return ZEIT;
        }
        return u.eingaenge().stream().anyMatch(x -> KennzahlRegeln.BEZUGSGROESSE.equals(x.art())
                && KennzahlRegeln.PERIODENWERT.equals(x.wertart()) && !art.equals(x.periodeArt())) ? ZEIT : DIREKT;
    }

    /** Die nächstfeinere gebildete Periode — die Teilperioden der Zeit (Woche ausgenommen: sie geht nicht auf). */
    static String feinere(List<String> perioden, String art) {
        for (int i = perioden.indexOf(art) - 1; i >= 0; i--) {
            if (!"woche".equals(perioden.get(i))) {
                return perioden.get(i);
            }
        }
        throw new IllegalArgumentException("keine feinere Periode als " + art + " in " + perioden);
    }

    // ------------------------------------------------------------------------------ die drei Wege

    private Bildung direkt(Rahmen r, Urteil u, KennzahlRegeln.Periode per, Aufgeloest zx, Aufgeloest nx, Gelesen zg,
            Gelesen ng, Gespeichert bisher) {
        // P4: ein Stammdatum hat keine Periode und zählt nicht — ohne jeden Periodenwert keine Zeile.
        boolean nichts = (stammdatum(zx) || KennzahlEingangLeser.leer(zg)) && (stammdatum(nx) || KennzahlEingangLeser.leer(ng));
        if (nichts && bisher == null) {
            return null;
        }
        List<HerkunftEingang> eingaenge = List.of(herkunft(0, "zaehler", zx, zg, u), herkunft(1, "nenner", nx, ng, u));
        KennzahlRegeln.LaufendUrteil lu = KennzahlRegeln.laufend(per, r.kx().jetzt().atZone(r.zone()).toOffsetDateTime(),
                r.zone(), nx.art(), nx.wertart());
        Gelesen z = zg;
        Gelesen n = ng;
        if (lu.laeuft()) {
            if (KennzahlRegeln.PERIODE_NICHT_ZU_ENDE.equals(lu.grund())) {
                return new Bildung(nichtZuEnde(bisher), eingaenge, null);
            }
            // P6: die laufende Periode erst, wenn alle Eingänge einen Wert tragen — und dann vorläufig.
            if ((zg.eingang().wert() == null || ng.eingang().wert() == null) && bisher == null) {
                return null;
            }
            z = vorlaeufig(zg);
            n = vorlaeufig(ng);
        }
        KennzahlRegeln.Antrag a = new KennzahlRegeln.Antrag(u.rechenform(), per, u.einheit(), z.eingang(), n.eingang(),
                u.komplement(), false, null, null, null, null, null, null, List.of(), bisher(bisher), anlass(r, bisher));
        return new Bildung(KennzahlRegeln.wert(a), eingaenge, spaetestes(List.of(z, n)));
    }

    /** Q5 über Ebenen: Summe durch Summe über die Paare derselben Periode (K3) — nie ihr Mittel. */
    private Bildung ebene(Rahmen r, Urteil u, KennzahlRegeln.Periode per, LocalDate[] p, List<Map<String, Paar>> paare,
            Gespeichert bisher) {
        List<KennzahlRegeln.Teil> teile = new ArrayList<>();
        List<HerkunftEingang> eingaenge = new ArrayList<>();
        boolean irgendeins = false;
        boolean nichtZuEnde = false;
        boolean alleMitZahl = true;
        Instant ab = null;
        for (int i = 0; i < u.eingaenge().size(); i++) {
            Aufgeloest x = u.eingaenge().get(i);
            Paar pp = zaehltMit(r, x.id(), per.art(), p, paare.get(i).get(per.schluessel()));
            Gespeichert g = pp.zeile();
            teile.add(pp.teil());
            alleMitZahl &= pp.teil().zaehler() != null && pp.teil().nenner() != null;
            if (g != null) {
                irgendeins = true;
                nichtZuEnde |= KennzahlRegeln.PERIODE_NICHT_ZU_ENDE.equals(g.grund());
                ab = spaeter(ab, g.endgueltig() ? g.endgueltigAb() : null);
            }
            eingaenge.add(paarEingang(i, x, pp, u));
        }
        if (!irgendeins && bisher == null) {
            return null;
        }
        if (laeuft(r, per)) {
            if (nichtZuEnde) {
                return new Bildung(nichtZuEnde(bisher), eingaenge, null);
            }
            if (!alleMitZahl && bisher == null) {
                return null;
            }
        }
        KennzahlRegeln.Antrag a = new KennzahlRegeln.Antrag(KennzahlRegeln.ZUSAMMENFASSUNG, per, u.einheit(), null, null,
                false, false, teile, "ebene", KennzahlEingangLeser.wortEbene(u.eingaenge()), null,
                u.eingaenge().get(0).rechenform(), null, List.of(), bisher(bisher), anlass(r, bisher));
        return new Bildung(KennzahlRegeln.wert(a), eingaenge, ab);
    }

    /**
     * Q5 über die Zeit: Summe durch Summe über die eigenen Teilperioden (K14) — ab der ersten, die es gibt (P4), bis zur
     * letzten, die begonnen hat; eine fehlende dazwischen oder danach heißt „x von y … (… fehlt)“. Die Teilperioden sind
     * Zeilen DIESER Kennzahl — ein Selbstverweis in {@code kennzahl_wert_eingang} ist verboten, die Herkunft nennt sie
     * darum nicht als Eingang. Eine Zusammenfassung nennt stattdessen ihre Paare in DIESER Periode (IP-11, Herkunft K14:
     * „KZ-0001 18 200 kWh je 122 500 Stück“); eine andere Kennzahl nennt keine Eingänge.
     */
    private Bildung zeit(Rahmen r, Urteil u, KennzahlRegeln.Periode per, LocalDate[] p, String feiner,
            Map<LocalDate, Gespeichert> eigene, List<Map<String, Paar>> paare, Gespeichert bisher) {
        List<LocalDate[]> teilPerioden = KennzahlEingangLeser.perioden(feiner, p[0], p[1]);
        int erste = -1;
        for (int i = 0; i < teilPerioden.size() && erste < 0; i++) {
            if (eigene.containsKey(teilPerioden.get(i)[0])) {
                erste = i;
            }
        }
        if (erste < 0) {
            return null;
        }
        List<KennzahlRegeln.Teil> teile = new ArrayList<>();
        boolean nichtZuEnde = false;
        Instant ab = null;
        for (int i = erste; i < teilPerioden.size() && !teilPerioden.get(i)[0].isAfter(r.heute()); i++) {
            LocalDate[] t = teilPerioden.get(i);
            Gespeichert roh = eigene.get(t[0]);
            Paar tp = zaehltMit(r, r.k().id(), feiner, t,
                    new Paar(KennzahlEingangLeser.teil(BezugsPeriode.schluesselVon(t[0], feiner), null, roh), roh));
            Gespeichert g = tp.zeile();
            teile.add(tp.teil());
            if (g != null) {
                nichtZuEnde |= KennzahlRegeln.PERIODE_NICHT_ZU_ENDE.equals(g.grund());
                ab = spaeter(ab, g.endgueltig() ? g.endgueltigAb() : null);
            }
        }
        List<HerkunftEingang> eingaenge = new ArrayList<>();
        for (int i = 0; i < paare.size(); i++) {
            eingaenge.add(paarEingang(i, u.eingaenge().get(i), paare.get(i).get(per.schluessel()), u));
        }
        if (laeuft(r, per)) {
            boolean periodenwertNenner = !KennzahlRegeln.ZUSAMMENFASSUNG.equals(u.rechenform())
                    && KennzahlRegeln.PERIODENWERT.equals(rolle(u, "nenner").wertart());
            if (periodenwertNenner || nichtZuEnde) {
                return new Bildung(nichtZuEnde(bisher), eingaenge, null);
            }
        }
        String formDerTeile = KennzahlRegeln.ZUSAMMENFASSUNG.equals(u.rechenform()) ? u.eingaenge().get(0).rechenform()
                : u.rechenform();
        KennzahlRegeln.Antrag a = new KennzahlRegeln.Antrag(KennzahlRegeln.ZUSAMMENFASSUNG, per, u.einheit(), null, null,
                false, false, teile, "zeit", WORT_ZEIT.get(feiner), feiner, formDerTeile,
                bestehenAb(eigene.get(teilPerioden.get(erste)[0]), teilPerioden.get(erste)[0]), List.of(), bisher(bisher),
                anlass(r, bisher));
        return new Bildung(KennzahlRegeln.wert(a), eingaenge, ab);
    }

    /** Je Paar einer Zusammenfassung seine gespeicherten Zeilen der Art in {@code [von, bis]}; sonst keine. */
    private static List<Map<String, Paar>> paare(Rahmen r, Urteil u, String art, LocalDate von, LocalDate bis) {
        List<Map<String, Paar>> aus = new ArrayList<>();
        if (KennzahlRegeln.ZUSAMMENFASSUNG.equals(u.rechenform())) {
            for (Aufgeloest x : u.eingaenge()) {
                aus.add(r.kx().leser().paare(x, art, von, bis));
            }
        }
        return aus;
    }

    /** Ein Paar in der Herkunft: was die Kennzahl in der Periode gespeichert hat, mit Zähler und Nenner (R4). */
    private static HerkunftEingang paarEingang(int position, Aufgeloest x, Paar pp, Urteil u) {
        Gespeichert g = pp.zeile();
        return new HerkunftEingang(position, "paar", KennzahlRegeln.KENNZAHL, x.kennzeichen(), null, null, x.id(),
                g == null ? null : g.wert(), g == null ? null : g.zaehler(), g == null ? null : g.nenner(),
                einheit(x, u), pp.teil().zustand(), g == null ? BigDecimal.ZERO : g.abdeckungProzent(),
                g == null ? null : g.version(), null, g == null ? List.of() : g.kennzeichen());
    }

    /**
     * K9: eine Zeile ohne Zahl, aber mit Zähler UND Nenner (Nenner 0), zählt in Summe durch Summe mit. Ohne Version trägt
     * sie selbst kein vorläufig/endgültig (die Tabelle erlaubt den Zustand nur mit Version) — als Teil ist sie endgültig,
     * wenn ihre eigenen Eingänge es sind: gelesen über denselben Leser (in der Kaskade auf deren Transaktion), nie
     * gespeichert. Nur für eine Kennzahl, die die Periode direkt aus Zähler und Nenner bildet; sonst bleibt der Teil
     * vorläufig, wie jede laufende Periode.
     */
    private Paar zaehltMit(Rahmen r, UUID kennzahl, String art, LocalDate[] p, Paar pp) {
        Gespeichert g = pp.zeile();
        KennzahlRegeln.Periode per = new KennzahlRegeln.Periode(art, BezugsPeriode.schluesselVon(p[0], art));
        if (g == null || g.version() != null || g.zaehler() == null || g.nenner() == null || laeuft(r, per)) {
            return pp;
        }
        Optional<FassungZeile> f = r.kx().kat().fassungAm(kennzahl, p[1]);
        if (f.isEmpty()) {
            return pp;
        }
        Urteil u;
        try {
            u = rechnung(r, f.get());
        } catch (KennzahlAbgelehnt x) {
            return pp;
        }
        if (!DIREKT.equals(weg(u, art))) {
            return pp;
        }
        Gelesen z = r.kx().leser().lies(rolle(u, "zaehler"), art, p[0], p[1]).get(per.schluessel());
        Gelesen n = r.kx().leser().lies(rolle(u, "nenner"), art, p[0], p[1]).get(per.schluessel());
        if (!z.eingang().endgueltig() || !n.eingang().endgueltig()) {
            return pp;
        }
        Gespeichert endgueltig = new Gespeichert(g.id(), g.periodeVon(), g.version(), g.wert(), g.zaehler(), g.nenner(),
                g.mengeZustand(), g.kennzeichen(), g.abdeckungProzent(), g.richtung(), g.grund(),
                ViertelstundeRegeln.ENDGUELTIG, spaetestes(List.of(z, n)), g.definitionFassungId(), g.berechnetAm(),
                g.eingangZustand());
        return new Paar(KennzahlEingangLeser.teil(pp.teil().objekt(), pp.teil().geltung(), endgueltig), endgueltig);
    }

    // ------------------------------------------------------------------------------ schreiben (V3)

    private void schreiben(Rahmen r, FassungZeile f, String art, LocalDate[] p, Gespeichert bisher, Bildung b) {
        if (b == null) {
            return;
        }
        Zaehler z = r.kx().z();
        Kaskade kaskade = r.kx().kaskade();
        KennzahlRegeln.Ergebnis e = b.ergebnis();
        String zustand = e.fassung() == null ? null
                : KennzahlRegeln.ENDGUELTIG.equals(e.fassung()) ? ViertelstundeRegeln.ENDGUELTIG : ViertelstundeRegeln.VORLAEUFIG;
        // Nur die Kaskade bildet einen endgültigen Wert neu — als Version n + 1, verglichen ohne die Nummer.
        boolean neueVersion = kaskade != null && bisher != null && bisher.endgueltig();
        if (bisher != null && gleich(r.kx().repo(), bisher, e, zustand, f.id(), b.eingaenge(), neueVersion)) {
            z.unveraendert++;
            return;
        }
        Instant am = r.kx().jetzt().truncatedTo(ChronoUnit.MICROS);
        if (bisher != null && !am.isAfter(bisher.berechnetAm())) {
            if (kaskade != null) {
                throw new IllegalStateException("UEMS Kennzahl " + r.k().kennzeichen() + " " + art + " " + p[0]
                        + ": die Kaskade um " + am + " liegt nicht nach der neuesten Zeile (" + bisher.berechnetAm() + ")");
            }
            log.warn("UEMS Kennzahl {} {} {}: der Lauf um {} liegt nicht nach der neuesten Zeile ({}) — nicht geschrieben",
                    r.k().kennzeichen(), art, p[0], am, bisher.berechnetAm());
            z.unveraendert++;
            return;
        }
        Instant endgueltigAb = ViertelstundeRegeln.ENDGUELTIG.equals(zustand)
                ? Objects.requireNonNullElse(b.endgueltigAb(), am) : null;
        String ausgang;
        if (kaskade == null) {
            ausgang = inTransaktion(con -> zeile(con, r, f, art, p, bisher, b, zustand, am, endgueltigAb, false));
        } else {
            try {
                ausgang = zeile(kaskade.con(), r, f, art, p, bisher, b, zustand, am, endgueltigAb, neueVersion);
            } catch (SQLException x) {
                throw new IllegalStateException("UEMS Kennzahl " + r.k().kennzeichen() + " " + art + " " + p[0]
                        + ": in der Kaskade nicht geschrieben", x);
            }
            if (!"geschrieben".equals(ausgang)) {
                // Unter der Sperre der Kaskade schreibt niemand dazwischen — geschah es doch, gilt nichts davon.
                throw new IllegalStateException("UEMS Kennzahl " + r.k().kennzeichen() + " " + art + " " + p[0]
                        + ": die neueste Zeile ist nicht mehr die gelesene (" + ausgang + ")");
            }
            if (neueVersion) {
                kaskade.neu().add(new Neu(r.k().id(), r.k().kennzeichen(), art, p[0], p[1], r.zone(), e.version()));
            }
        }
        switch (ausgang) {
            case "geschrieben" -> z.geschrieben++;
            case "endgueltig" -> z.endgueltig++;
            default -> z.unveraendert++;
        }
    }

    /**
     * Eine Zeile unter der Sperre der Kennzahl. Hat ein anderer Lauf die Periode inzwischen geschrieben: {@code anders};
     * im Regellauf bleibt ein endgültiger Wert stehen ({@code endgueltig}). Version n + 1 trägt den Anlass der Kaskade, ein
     * Nachziehen den Anlass seiner Version — dieselbe Nummer, derselbe Anlass (Trigger {@code kennzahl_wert_version_folgt}).
     */
    private String zeile(Connection con, Rahmen r, FassungZeile f, String art, LocalDate[] p, Gespeichert bisher,
            Bildung b, String zustand, Instant am, Instant endgueltigAb, boolean neueVersion) throws SQLException {
        KennzahlRegeln.Ergebnis e = b.ergebnis();
        sperren(con, r.kx().tenant(), r.k().id());
        String anlassArt = neueVersion ? EINGANG.art() : null;
        String anlassKennung = neueVersion ? r.kx().kaskade().anlass() : null;
        // Unter der Sperre: hat ein anderer Lauf die Periode inzwischen geschrieben oder endgültig gemacht?
        try (PreparedStatement ps = con.prepareStatement("SELECT zustand, berechnet_am, version, anlass_art, anlass_kennung "
                + "FROM kennzahl_wert WHERE tenant_id = ? AND kennzahl_id = ? AND periode_art = ? AND periode_von = ? "
                + "ORDER BY version DESC NULLS LAST, berechnet_am DESC LIMIT 1")) {
            ps.setObject(1, r.kx().tenant());
            ps.setObject(2, r.k().id());
            ps.setString(3, art);
            ps.setDate(4, Date.valueOf(p[0]));
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    if (r.kx().kaskade() == null && ViertelstundeRegeln.ENDGUELTIG.equals(rs.getString("zustand"))) {
                        return "endgueltig";
                    }
                    if (bisher == null || !rs.getTimestamp("berechnet_am").toInstant().equals(bisher.berechnetAm())) {
                        return "anders";
                    }
                    if (!neueVersion && e.version() != null
                            && e.version().equals(rs.getObject("version", Integer.class))) {
                        anlassArt = rs.getString("anlass_art");
                        anlassKennung = rs.getString("anlass_kennung");
                    }
                } else if (bisher != null) {
                    return "anders";
                }
            }
        }
        UUID id = UUID.randomUUID();
        try (PreparedStatement ps = con.prepareStatement("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, "
                + "periode_art, periode_von, periode_bis, zeitzone, version, wert, zaehler, nenner, menge_zustand, "
                + "kennzeichen, abdeckung_prozent, richtung, grund, zustand, endgueltig_ab, definition_fassung_id, "
                + "berechnet_am, anlass_art, anlass_kennung) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setObject(1, id);
            ps.setObject(2, r.kx().tenant());
            ps.setObject(3, r.k().id());
            ps.setString(4, art);
            ps.setDate(5, Date.valueOf(p[0]));
            ps.setDate(6, Date.valueOf(p[1]));
            ps.setString(7, r.zone().getId());
            ps.setObject(8, e.version(), Types.INTEGER);
            ps.setBigDecimal(9, e.wert());
            ps.setBigDecimal(10, e.zaehler());
            ps.setBigDecimal(11, e.nenner());
            ps.setString(12, e.zustand());
            ps.setString(13, alsJson(e.kennzeichen()));
            ps.setBigDecimal(14, e.abdeckungProzent());
            ps.setString(15, e.richtung());
            ps.setString(16, e.grund());
            ps.setString(17, zustand);
            ps.setTimestamp(18, endgueltigAb == null ? null : Timestamp.from(endgueltigAb));
            ps.setObject(19, f.id());
            ps.setTimestamp(20, Timestamp.from(am));
            ps.setString(21, anlassArt);
            ps.setString(22, anlassKennung);
            ps.executeUpdate();
        }
        for (HerkunftEingang h : b.eingaenge()) {
            try (PreparedStatement ps = con.prepareStatement("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, "
                    + "kennzahl_id, position, rolle, art, objekt, messstelle_id, bezugsgroesse_id, eingang_kennzahl_id, "
                    + "wert, zaehler, nenner, einheit, menge_zustand, abdeckung_prozent, version, fassung, kennzeichen) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)")) {
                ps.setObject(1, r.kx().tenant());
                ps.setObject(2, id);
                ps.setObject(3, r.k().id());
                ps.setInt(4, h.position());
                ps.setString(5, h.rolle());
                ps.setString(6, h.art());
                ps.setString(7, h.objekt());
                ps.setObject(8, h.messstelleId(), Types.OTHER);
                ps.setObject(9, h.bezugsgroesseId(), Types.OTHER);
                ps.setObject(10, h.kennzahlId(), Types.OTHER);
                ps.setBigDecimal(11, h.wert());
                ps.setBigDecimal(12, h.zaehler());
                ps.setBigDecimal(13, h.nenner());
                ps.setString(14, h.einheit());
                ps.setString(15, h.mengeZustand());
                ps.setBigDecimal(16, h.abdeckungProzent());
                ps.setObject(17, h.version(), Types.INTEGER);
                ps.setObject(18, h.fassung(), Types.INTEGER);
                ps.setString(19, alsJson(h.kennzeichen()));
                ps.executeUpdate();
            }
        }
        return "geschrieben";
    }

    /**
     * V3: nichts Neues — dieselbe Zahl, derselbe Zustand, dieselben Kennzeichen, dieselbe Fassung, dieselben Eingänge. Für
     * Version n + 1 der Kaskade ohne die Nummer und ohne ihren Satz: dieselbe Aussage aus denselben Eingängen mit neuer
     * Nummer ist keine Neubildung.
     */
    private static boolean gleich(KennzahlRepository repo, Gespeichert g, KennzahlRegeln.Ergebnis e, String zustand,
            UUID fassung, List<HerkunftEingang> eingaenge, boolean neueVersion) {
        return zahlGleich(g.wert(), e.wert()) && zahlGleich(g.zaehler(), e.zaehler()) && zahlGleich(g.nenner(), e.nenner())
                && Objects.equals(g.mengeZustand(), e.zustand())
                && ohneVersion(g.kennzeichen(), neueVersion).equals(ohneVersion(e.kennzeichen(), neueVersion))
                && zahlGleich(g.abdeckungProzent(), e.abdeckungProzent()) && Objects.equals(g.richtung(), e.richtung())
                && Objects.equals(g.grund(), e.grund()) && Objects.equals(g.zustand(), zustand)
                && (neueVersion || Objects.equals(g.version(), e.version())) && fassung.equals(g.definitionFassungId())
                && repo.eingaengeText(g.id()).equals(eingaenge.stream().map(HerkunftEingang::text).toList());
    }

    private static List<String> ohneVersion(List<String> saetze, boolean neueVersion) {
        return neueVersion ? saetze.stream().filter(s -> !KennzahlRegeln.versionSatz(s)).toList() : saetze;
    }

    static String eingangText(int position, String rolle, String art, String objekt, BigDecimal wert, BigDecimal zaehler,
            BigDecimal nenner, String einheit, String mengeZustand, BigDecimal abdeckung, Integer version,
            Integer fassung, List<String> kennzeichen) {
        return String.join("|", String.valueOf(position), rolle, art, objekt, zahl(wert), zahl(zaehler), zahl(nenner),
                einheit, String.valueOf(mengeZustand), zahl(abdeckung), String.valueOf(version), String.valueOf(fassung),
                String.join("", kennzeichen));
    }

    // ------------------------------------------------------------------------------ Hilfen

    /** Eine Periode, die noch nicht zu Ende ist, ohne Zahl (P6/K21) — eine frühere vorläufige Version bleibt die Nummer. */
    private static KennzahlRegeln.Ergebnis nichtZuEnde(Gespeichert bisher) {
        Integer version = bisher == null ? null : bisher.version();
        return new KennzahlRegeln.Ergebnis(null, null, null, ErgebnisZustand.KEINE_WERTE, null,
                KennzahlRegeln.PERIODE_NICHT_ZU_ENDE, BigDecimal.ZERO, version == null ? null : KennzahlRegeln.VORLAEUFIG,
                version, List.of(), KennzahlRegeln.OHNE_ZAHL, null);
    }

    private static boolean laeuft(Rahmen r, KennzahlRegeln.Periode per) {
        return KennzahlRegeln.laufend(per, r.kx().jetzt().atZone(r.zone()).toOffsetDateTime(), r.zone(), null, null)
                .laeuft();
    }

    /** Nur die Kaskade hat einen Anlass — für einen endgültigen Wert, der Version n + 1 wird (Q7). */
    private static KennzahlRegeln.Anlass anlass(Rahmen r, Gespeichert bisher) {
        return r.kx().kaskade() != null && bisher != null && bisher.endgueltig() ? EINGANG : null;
    }

    private static KennzahlRegeln.Bisher bisher(Gespeichert g) {
        return g == null || g.version() == null ? null : new KennzahlRegeln.Bisher(g.version(), g.endgueltig());
    }

    private static boolean stammdatum(Aufgeloest x) {
        return KennzahlRegeln.BEZUGSGROESSE.equals(x.art()) && KennzahlRegeln.STAMMDATUM.equals(x.wertart());
    }

    private static Gelesen vorlaeufig(Gelesen g) {
        KennzahlRegeln.Eingang e = g.eingang();
        return new Gelesen(new KennzahlRegeln.Eingang(e.art(), e.objekt(), e.name(), e.geltung(), e.wertart(), e.status(),
                e.wert(), e.einheit(), e.zustand(), e.abdeckungProzent(), false, e.ursache(), e.kennzeichen()),
                g.version(), g.fassung(), g.herkunft(), null);
    }

    /** Q6: endgültig ab dem spätesten Eingang, dessen Zeitpunkt bekannt ist. */
    private static Instant spaetestes(List<Gelesen> gelesen) {
        Instant ab = null;
        for (Gelesen g : gelesen) {
            ab = spaeter(ab, g.eingang().endgueltig() ? g.endgueltigAb() : null);
        }
        return ab;
    }

    private static Instant spaeter(Instant a, Instant b) {
        return a == null ? b : b == null || !b.isAfter(a) ? a : b;
    }

    /** Das eigene „ab …“ der ersten Teilperiode ersetzt deren Beginn (K2: „ab 15.10.2026“, K14: „ab 01.10.2026“). */
    private static LocalDate bestehenAb(Gespeichert erste, LocalDate beginn) {
        for (String satz : erste == null ? List.<String>of() : erste.kennzeichen()) {
            Matcher m = AB.matcher(satz);
            if (m.matches()) {
                return LocalDate.parse(m.group(1), TAG_TEXT);
            }
        }
        return beginn;
    }

    private static Aufgeloest rolle(Urteil u, String rolle) {
        return u.eingaenge().stream().filter(x -> rolle.equals(x.rolle())).findFirst().orElseThrow();
    }

    private static String einheit(Aufgeloest x, Urteil u) {
        return x.einheit() == null || x.einheit().isBlank() ? u.einheit() : x.einheit();
    }

    /** Die Herkunft eines Zähler- oder Nenner-Eingangs (kennzahlwert-herkunft §1): was er in der Periode trug. */
    private static HerkunftEingang herkunft(int position, String rolle, Aufgeloest x, Gelesen g, Urteil u) {
        KennzahlRegeln.Eingang e = g.eingang();
        boolean bezug = KennzahlRegeln.BEZUGSGROESSE.equals(x.art());
        String zustand;
        BigDecimal abdeckung;
        if (bezug) {
            boolean da = e.wert() != null
                    && (KennzahlRegeln.STAMMDATUM.equals(e.wertart()) || KennzahlRegeln.WIRKSAM.equals(e.status()));
            zustand = da ? ErgebnisZustand.VOLLSTAENDIG : ErgebnisZustand.KEINE_WERTE;
            abdeckung = da ? new BigDecimal("100") : BigDecimal.ZERO;
        } else {
            zustand = e.wert() == null ? ErgebnisZustand.KEINE_WERTE : e.zustand();
            abdeckung = KennzahlEingangLeser.abdeckung(g);
        }
        return new HerkunftEingang(position, rolle, x.art(), x.kennzeichen(),
                KennzahlRegeln.MESSSTELLE.equals(x.art()) ? x.id() : null, bezug ? x.id() : null,
                KennzahlRegeln.KENNZAHL.equals(x.art()) ? x.id() : null, e.wert(), null, null, einheit(x, u), zustand,
                abdeckung, bezug ? null : g.version(), bezug ? g.fassung() : null, g.herkunft());
    }

    private static boolean zahlGleich(BigDecimal a, BigDecimal b) {
        return a == null ? b == null : b != null && a.compareTo(b) == 0;
    }

    private static String zahl(BigDecimal b) {
        return b == null ? "null" : b.stripTrailingZeros().toPlainString();
    }

    private String alsJson(List<String> saetze) {
        try {
            return json.writeValueAsString(saetze);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    // ------------------------------------------------------------------------------ Transaktion

    @FunctionalInterface
    private interface Zug<T> {
        T fahren(Connection con) throws SQLException;
    }

    /** Serialisiert die Schreiber EINER Kennzahl bis zum Ende der Transaktion (mehrere Instanzen im Takt). */
    private static void sperren(Connection con, UUID tenant, UUID kennzahl) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")) {
            ps.setString(1, "uems-kennzahl:" + tenant + ":" + kennzahl);
            ps.executeQuery().close();
        }
    }

    private <T> T inTransaktion(Zug<T> zug) {
        return adminJdbc.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                T ergebnis = zug.fahren(con);
                con.commit();
                return ergebnis;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql : new SQLException("UEMS Kennzahl-Wert fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
