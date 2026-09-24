package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/**
 * Die Auffälligkeits-Naht der Verbesserung (UEMS AP-18 IP-15, A1, E4 = A): je endgültigem Monatswert einer Kennzahl mit
 * freigegebener Bezugsbasis-Fassung holt sie den Vergleich des Monats ({@link BezugsbasisVergleich#fuerNaht}, Operation
 * {@code vergleich} gegen die Fassung am letzten Tag, P4) und schreibt bei {@code schlechter} genau einen Vermerk
 * {@code auffaelligkeit} — Kennzahl × Fassung × Monat, idempotent über {@code auffaelligkeit_eindeutig_uq} — mit der
 * kanonischen Kopie der Vergleichszeile als Anlass und ihrer Prüfsumme ({@code bericht_pruefsumme}). {@code besser},
 * {@code im_rahmen}, {@code nicht_anwendbar} und {@code ohne_urteil} schreiben nichts. Sie urteilt nicht und legt keinen
 * Vorgang an: eine Person antwortet (A2).
 *
 * <ul>
 *   <li><b>Endgültigkeits-Takt</b>: {@link KennzahlLauf} ruft sie im Regellauf in DERSELBEN Transaktion, die den
 *       endgültigen Monatswert schreibt (je Wert eine Transaktion); {@link KennzahlLauf#lauf} gibt diese Werte zusätzlich
 *       zurück ({@code Lauf.endgueltig}).</li>
 *   <li><b>Kaskade</b>: {@link KennzahlKaskade} ruft sie nach {@code KennzahlNeuGebildet.melden} in der Transaktion der
 *       Kaskade mit den Monatswerten, die dort endgültig geschrieben wurden (Version n + 1 oder erstmals).</li>
 *   <li><b>Anstoß am Vorgang</b> (IP-17, M5, Z5): {@link #anstossen} (Pfad 1, Kaskade, nach dem Bezugsbasis-Anstoß) und
 *       {@link #messgrundlage} (Pfad 2, Struktur-Läufer im Zweig der Bezugsbasis) setzen über {@link VorgangAnstoss}
 *       Anstöße an Maßnahmen und Energiezielen — derselbe Schalter.</li>
 * </ul>
 *
 * <p>Beide Wege schreiben mit der Verwaltungsrolle ({@code adminJdbcTemplate}, ohne RLS — jede Abfrage nennt den
 * Mandanten oder die Kennzahl); darum darf sie in {@code auffaelligkeit} anhängen ({@code V20260925002000}). Der
 * Standort ist der der Geltung der Kennzahl (RE2, wie beim Energieziel). „Der Monat liegt vor dem Vermerk“ prüft die
 * Naht mit der Uhr des Laufs, nicht die Datenbank.
 *
 * <p><b>Schalter</b> {@value #SCHALTER} (Vorgabe AN): aus → die Naht schweigt und holt nichts nach; die Kennzahl-Werte
 * werden trotzdem gebildet. Wirft bei jedem Fehler — die Transaktion des Werts rollt dann zurück (keine halbe Wahrheit);
 * der Fehler zählt unter dem Label {@link UemsLaeuferMelder#VERBESSERUNG_NAHT}.
 */
@Component
public class VerbesserungNaht {

    public static final String SCHALTER = "voltpilot.uems.verbesserung.enabled";

    static final String SCHLECHTER = "schlechter";
    private static final String MONAT = "monat";
    private static final Logger log = LoggerFactory.getLogger(VerbesserungNaht.class);

    @Value("${" + SCHALTER + ":true}")
    private boolean eingeschaltet = true;

    private final KennzahlService kennzahlen;
    private final BezugsbasisVergleich vergleich;
    private final ObjectMapper json;
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    public VerbesserungNaht(KennzahlService kennzahlen, BezugsbasisVergleich vergleich, ObjectMapper json) {
        this.kennzahlen = kennzahlen;
        this.vergleich = vergleich;
        this.json = json;
    }

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    /** Ein neu geschriebener Vermerk. */
    public record Vermerk(UUID id, UUID kennzahl, String kennzeichen, String periode, String bezugsbasis, int fassung,
            String anlassPruefsumme) {}

    /**
     * Für diese endgültig geschriebenen Werte, in der Transaktion {@code con}: je Monatswert einer Kennzahl mit
     * freigegebener Fassung der Vergleich, bei {@code schlechter} ein Vermerk. Andere Perioden übergeht sie.
     *
     * @return die NEU geschriebenen Vermerke (ein zweiter Lauf über denselben Monat schreibt keinen)
     */
    public List<Vermerk> vermerken(Connection con, UUID tenant, List<KennzahlLauf.Neu> werte, Instant jetzt) {
        if (!eingeschaltet || werte.isEmpty()) {
            return List.of();
        }
        UUID vorher = TenantContext.get();
        TenantContext.set(tenant);
        try {
            JdbcTemplate transaktion = new JdbcTemplate(new SingleConnectionDataSource(con, true));
            List<Vermerk> aus = new ArrayList<>();
            Set<String> gesehen = new LinkedHashSet<>();
            for (KennzahlLauf.Neu w : werte) {
                if (!MONAT.equals(w.periodeArt()) || !gesehen.add(w.kennzahl() + "/" + w.von())) {
                    continue;
                }
                YearMonth monat = YearMonth.from(w.von());
                // Kein Zeitbezug in der Datenbank: dass der Monat vor dem Vermerk liegt, prüft die Uhr des Laufs.
                if (!monat.isBefore(YearMonth.from(jetzt.atZone(w.zone())))
                        || !mitFreigegebenerFassung(transaktion, tenant, w.kennzahl())) {
                    continue;
                }
                vermerk(transaktion, tenant, w, monat, jetzt).ifPresent(aus::add);
            }
            if (!aus.isEmpty()) {
                log.info("UEMS Verbesserung: {} Auffälligkeiten vermerkt ({})", aus.size(),
                        aus.stream().map(v -> v.kennzeichen() + " " + v.periode()).toList());
            }
            return aus;
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.VERBESSERUNG_NAHT);
            throw e;
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    /**
     * Anstoß am Vorgang, Pfad 1 (IP-17, M5): die Kaskade machte diese Kennzahl-Monate zu Version n + 1 — in ihrer
     * Transaktion {@code con}, direkt nach dem Bezugsbasis-Anstoß Pfad 1, mit dessen Anlass-Kennung
     * ({@link BezugsbasisAnstoss#kennung}). Schalter aus → nichts.
     *
     * @return die NEU gesetzten Anstöße (ein zweiter Lauf derselben Korrektur setzt keinen)
     */
    public List<VorgangAnstoss.Gesetzt> anstossen(Connection con, UUID tenant, String anlass,
            List<KennzahlLauf.Neu> neu, Instant jetzt) {
        if (!eingeschaltet || neu.isEmpty()) {
            return List.of();
        }
        return anstoesse("Pfad 1 " + anlass, () -> VorgangAnstoss.nachKorrektur(con, tenant, anlass, neu, jetzt));
    }

    /**
     * Anstoß am Vorgang, Pfad 2 (IP-7 Ziele, IP-17 Maßnahmen, Z5, M5): eine Zeile {@code bezugsbasis_aenderung}
     * (beendet, Fassung n freigegeben) — im Struktur-Läufer, in der Transaktion des Bezugsbasis-Zweigs. Schalter aus →
     * nichts; das Wasserzeichen setzt der Läufer trotzdem (nichts wird nachgeholt, §5.8).
     */
    public List<VorgangAnstoss.Gesetzt> messgrundlage(Connection con, UUID tenant, UUID basis, String protokollArt,
            long eintrag, Instant jetzt) {
        if (!eingeschaltet) {
            return List.of();
        }
        return anstoesse("Pfad 2 " + protokollArt + "-" + eintrag,
                () -> VorgangAnstoss.anVorgaengen(con, tenant, basis, protokollArt, eintrag, jetzt));
    }

    @FunctionalInterface
    private interface Setzen {
        List<VorgangAnstoss.Gesetzt> setzen() throws SQLException;
    }

    private List<VorgangAnstoss.Gesetzt> anstoesse(String was, Setzen setzen) {
        try {
            List<VorgangAnstoss.Gesetzt> aus = setzen.setzen();
            if (!aus.isEmpty()) {
                log.info("UEMS Verbesserung {}: {} Anstöße am Vorgang ({})", was, aus.size(),
                        aus.stream().map(g -> g.art() + " " + g.anlassKennung()).toList());
            }
            return aus;
        } catch (SQLException e) {
            melder.fehler(UemsLaeuferMelder.VERBESSERUNG_NAHT);
            throw new IllegalStateException("UEMS Verbesserung " + was + ": " + e.getMessage(), e);
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.VERBESSERUNG_NAHT);
            throw e;
        }
    }

    /** R13: ohne freigegebene Fassung liest die Naht nichts weiter. */
    private static boolean mitFreigegebenerFassung(JdbcTemplate t, UUID tenant, UUID kennzahl) {
        return Boolean.TRUE.equals(t.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsbasis b JOIN bezugsbasis_fassung f "
                + "ON f.tenant_id = b.tenant_id AND f.bezugsbasis_id = b.id WHERE b.tenant_id = ? AND b.kennzahl_id = ? "
                + "AND f.freigabe_status = 'freigegeben')", Boolean.class, tenant, kennzahl));
    }

    private Optional<Vermerk> vermerk(JdbcTemplate t, UUID tenant, KennzahlLauf.Neu w, YearMonth monat, Instant jetzt) {
        Optional<KennzahlService.NahtKennzahl> k = kennzahlen.fuerNaht(w.kennzahl(), jetzt);
        if (k.isEmpty()) {
            return Optional.empty();
        }
        BezugsbasisVergleich.NahtMonat m = vergleich.fuerNaht(t, k.get().basis(), k.get().einheit(), monat);
        if (m == null || m.fassung() == null || m.zeile().bereinigt() == null
                || !SCHLECHTER.equals(m.zeile().bereinigt().urteil())) {
            return Optional.empty();
        }
        String anlass = anlass(w.kennzeichen(), m);
        String pruefsumme = BezugsbasisGrundlage.pruefsumme(anlass);
        List<UUID> neu = t.query("INSERT INTO auffaelligkeit (tenant_id, kennzahl_id, bezugsbasis_id, fassung, periode, "
                + "standort_id, anlass, anlass_pruefsumme, vermerkt_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT ON CONSTRAINT auffaelligkeit_eindeutig_uq DO NOTHING RETURNING id",
                (rs, i) -> rs.getObject("id", UUID.class), tenant, w.kennzahl(), m.basis(), m.fassung(),
                monat.toString(), k.get().standort(), anlass, pruefsumme, Timestamp.from(jetzt));
        return neu.stream().findFirst().map(id -> new Vermerk(id, w.kennzahl(), w.kennzeichen(), monat.toString(),
                m.basisKennzeichen(), m.fassung(), pruefsumme));
    }

    /**
     * Der Anlass: die Vergleichszeile des Lesers (Beschriftung, bereinigtes Ergebnis mit Fassung, gemessen mit Version,
     * Bedingung, erwartet, Δ, Band, Urteil, Grund, Kennzeichen; der Satz) mit Kennzahl, Bezugsbasis und Fassung — als
     * kanonischer Text (Schlüssel sortiert, ohne Leerraum). Die rohe Veränderung zum Vormonat trägt kein Urteil (VG3)
     * und gehört nicht dazu.
     */
    String anlass(String kennzeichen, BezugsbasisVergleich.NahtMonat m) {
        ObjectNode a = json.createObjectNode();
        a.put("kennzahl", kennzeichen);
        a.put("bezugsbasis", m.basisKennzeichen());
        a.put("fassung", m.fassung());
        a.put("monat", m.zeile().periode());
        a.put("beschriftung", m.zeile().beschriftung());
        a.set("bereinigt", json.valueToTree(m.zeile().bereinigt()));
        a.put("satz", m.zeile().satz());
        return BezugsbasisGrundlage.kanonisch(a);
    }
}
