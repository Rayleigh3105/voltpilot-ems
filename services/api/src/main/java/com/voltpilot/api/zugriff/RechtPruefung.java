package com.voltpilot.api.zugriff;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BezugsgroesseAbgelehnt;
import com.voltpilot.api.uems.BezugsgroesseRegeln;
import com.voltpilot.api.uems.KennzahlRegeln;
import com.voltpilot.api.uems.KostenstelleProzessAbgelehnt;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Anlage;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import com.voltpilot.api.uems.VerteilungAbgelehnt;
import com.voltpilot.api.zugriff.ZugriffContext.Zugang;
import com.voltpilot.api.zugriff.ZugriffContext.Zugriff;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * Das Recht einer Aktion am Objekt der Anfrage (UEMS AP-03 IP-6) — die EINE Stelle, an der das API eine Schreibroute
 * gegen die Rechte-Matrix prüft. {@link RechtInterceptor} ruft {@link #route} für jede Route mit {@link Recht}; ein
 * Handler, dessen Ziel erst im Anfragekörper steht, ruft {@link #pruefen} bzw. {@link #rueckwirkend}.
 *
 * <p><b>Geltungsbereich vor Aktion (W2).</b> Zuerst wird das Objekt aufgelöst — unter derselben Verbindung wie die
 * Route, also unter Mandanten-RLS und dem Standort-Zaun aus IP-5. Sieht die Anfrage es nicht (oder gibt es es nicht),
 * geht sie unverändert an die Route, deren eigene 404 byte-gleich bleibt. Sieht sie es, liegt es aber nach dem
 * Rechte-Vertrag außerhalb (Messstelle und Bezugsgröße haben keinen Standort-Zaun), antwortet diese Stelle mit
 * GENAU der 404, die die Route für eine nie vergebene Kennung gibt. Erst im Geltungsbereich 403 {@link RechtFehlt}.
 * Lesende Routen eines solchen Objekts fragen dieselbe Auflösung über {@link #pruefenLesen} bzw. {@link #lesbar}.
 *
 * <p><b>Wer fragt</b>, steht allein im {@link ZugriffContext}: die wirksamen Zuweisungen des Kundenkontos (nie
 * zugewiesen = Kundenadministrator, Bestandsregel E12) bzw. die angenommene Unterstützung. Zwei Fälle prüft sie
 * bewusst NICHT und zählt sie: ohne Kontext (kein Kundenbereich im Token, Jobs, OIDC aus) und der Plattform-Umschalter
 * {@code X-Tenant-Id} — der bleibt bis IP-8, wie er ist (AP-03 W3).
 *
 * <p>Standorte tragen im Vertrags-Eingang ihre ID (wie in {@code KennzahlRechte}/{@code BerichtRechte}), nicht das
 * Kurzzeichen der Selbstauskunft.
 */
@Component
public class RechtPruefung {

    private static final Logger log = LoggerFactory.getLogger(RechtPruefung.class);

    /** Wie eine Prüfung ausging — Anfrage-Attribut {@link RechtInterceptor#URTEIL} und Zähler {@code voltpilot_recht_total}. */
    public enum Ergebnis {
        ERLAUBT("erlaubt"),
        /** 403 {@code recht_fehlt}. */
        RECHT_FEHLT("recht_fehlt"),
        /** 404 aus dieser Stelle: sichtbar, nach dem Vertrag aber außerhalb des Geltungsbereichs. */
        AUSSERHALB("ausserhalb"),
        /** 404 {@code zugriff_beendet}: der Aufrufer hatte diesen Standort, und die Zuweisung ist vorbei (IP-9). */
        ZUGRIFF_BEENDET("zugriff_beendet"),
        /** Die Anfrage sieht das Objekt nicht (oder es gibt es nicht): die Route antwortet selbst. */
        UNSICHTBAR("unsichtbar"),
        /** Kein Zugriff-Kontext — nicht geprüft. */
        OHNE_KONTEXT("ohne_kontext"),
        /** Plattform am Umschalter {@code X-Tenant-Id} — nicht geprüft bis IP-8 (W3). */
        UMSCHALTER("umschalter");

        private final String code;

        Ergebnis(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Das Urteil über eine Route: {@code ablehnung} ist die Antwort, die statt des Handlers geht, sonst {@code null}. */
    public record Urteil(Ergebnis ergebnis, RuntimeException ablehnung) {}

    /** Aktion der Matrix: rückwirkend ändern („gültig ab" in der Vergangenheit, AP-02 E2, W14). */
    public static final String RUECKWIRKEND = "aenderung.rueckwirkend";

    private static final Instant IMMER = Instant.EPOCH;

    private final JdbcTemplate jdbc;
    private final Geltungsbereich geltungsbereich;
    private final ZugriffRepository zugriffe;
    private final MeterRegistry metriken;

    public RechtPruefung(JdbcTemplate jdbc, Geltungsbereich geltungsbereich, ZugriffRepository zugriffe,
            MeterRegistry metriken) {
        this.jdbc = jdbc;
        this.geltungsbereich = geltungsbereich;
        this.zugriffe = zugriffe;
        this.metriken = metriken;
    }

    // ------------------------------------------------------------------ Einstiege

    /**
     * Die Prüfung einer Route mit {@link Recht}.
     *
     * @param pfad die Pfadvariablen der Anfrage
     * @param controller der einfache Klassenname des Controllers — er wählt die 404, die die Route selbst gibt
     */
    public Urteil route(Recht recht, Map<String, String> pfad, String controller) {
        Zugriff z = ZugriffContext.get();
        Ergebnis ohne = ungeprueft(z);
        if (ohne != null) {
            return zaehle(new Urteil(ohne, null));
        }
        if (recht.ziel() == RechtZiel.DIENST) {
            return zaehle(irgendwo(z, List.of(recht.value())));
        }
        UUID id = null;
        if (recht.ziel() != RechtZiel.UNTERNEHMEN) {
            String variable = recht.variable().isEmpty() ? recht.ziel().variable() : recht.variable();
            id = uuid(pfad.get(variable));
            if (id == null) {
                // Keine Kennung, die es geben kann: die Route antwortet selbst (400 bzw. 404), geschrieben wird nichts.
                return zaehle(new Urteil(Ergebnis.UNSICHTBAR, null));
            }
        }
        return zaehle(urteil(z, recht.value()[0], aufloesen(recht.ziel(), id),
                () -> nichtGefunden(recht.ziel(), controller)));
    }

    /**
     * Die genaue Prüfung im Handler, wenn das Ziel im Anfragekörper steht. Ein unsichtbares Ziel geht durch (der Dienst
     * antwortet wie für eine unbekannte Kennung); außerhalb wirft {@code nichtGefunden} — dieselbe Ausnahme, die der
     * Dienst für eine unbekannte Kennung wirft; ohne Recht {@link RechtFehlt}.
     */
    public void pruefen(String kennung, RechtZiel ziel, UUID id, Supplier<? extends RuntimeException> nichtGefunden) {
        if (ziel == RechtZiel.DIENST) {
            throw new IllegalArgumentException("Die genaue Prüfung braucht ein Ziel.");
        }
        Zugriff z = ZugriffContext.get();
        if (ungeprueft(z) != null || (ziel != RechtZiel.UNTERNEHMEN && id == null)) {
            return;
        }
        Urteil u = zaehle(urteil(z, kennung, aufloesen(ziel, id), nichtGefunden));
        if (u.ablehnung() != null) {
            throw u.ablehnung();
        }
    }

    /**
     * {@link #pruefen} für eine Liste: {@code true} genau dann, wenn {@link #pruefen} nicht würfe. {@code false} heißt,
     * die Zeile fehlt — ohne Hinweis, ohne Anzahl, auch statt einer 403. Gezählt wird nicht (keine Schreibroute).
     */
    public boolean erlaubt(String kennung, RechtZiel ziel, UUID id) {
        if (ziel == RechtZiel.DIENST) {
            throw new IllegalArgumentException("Die genaue Prüfung braucht ein Ziel.");
        }
        Zugriff z = ZugriffContext.get();
        if (ungeprueft(z) != null || (ziel != RechtZiel.UNTERNEHMEN && id == null)) {
            return true;
        }
        return urteil(z, kennung, aufloesen(ziel, id), null).ablehnung() == null;
    }

    /**
     * Ein Standort ODER ein Gebäude/Bereich als Ziel (Ort verschieben: der neue Elternknoten) — wie {@link #pruefen}.
     */
    public void pruefenStandortOderOrt(String kennung, UUID id, Supplier<? extends RuntimeException> nichtGefunden) {
        if (ungeprueft(ZugriffContext.get()) != null || id == null) {
            return;
        }
        pruefen(kennung, sichtbar("standort", id) ? RechtZiel.STANDORT : RechtZiel.ORT, id, nichtGefunden);
    }

    /**
     * „Gültig ab" vor heute (Zeitzone des Unternehmens) braucht {@code aenderung.rueckwirkend} — der Bearbeiter ändert
     * nur ab heute (AP-02 E2, AP-03 W14). {@code null} = ab heute.
     */
    public void rueckwirkend(LocalDate gueltigAb) {
        if (gueltigAb == null || ungeprueft(ZugriffContext.get()) != null) {
            return;
        }
        LocalDate heute = jdbc.queryForObject("SELECT uems_zugriff_heute(?)", LocalDate.class, TenantContext.get());
        if (heute != null && gueltigAb.isBefore(heute)) {
            pruefen(RUECKWIRKEND, RechtZiel.UNTERNEHMEN, null, null);
        }
    }

    /**
     * Die OCPP-Stufe des Aufrufers an einer Anlage — aus der Zuweisung (AP-03 E13, IP-7): {@code SITE_ADMIN} für
     * Kundenadministrator und Bedienberechtigt, {@code CUSTOMER} für den Unterstützer mit „Einrichten und Bedienen",
     * {@code PLATFORM} für VoltPilot, sonst {@code KEINE}. Leer ohne Kontext und am Umschalter:
     * dort gelten die Realm-Rollen wie vor IP-7 ({@code OcppActionPolicy}). Eine Anlage ohne Standort decken nur
     * unternehmensweite Zuweisungen (wie {@link #route} sie auflöst).
     *
     * <p>Captain 22.09.2026 E2 = A: Das gedachte Bestands-Recht (E12: nie zugewiesen, Kundenbereich ohne
     * Stichtag) ist auf ALLEN Achsen Kundenadministrator, auch hier {@code SITE_ADMIN}. Sobald der Kundenbereich
     * seinen Stichtag trägt, liefert {@link #benutzer} nur noch echte Zuweisungen. Der Mandanten-/Standort-Zaun
     * wird weiterhin vor der Stufen-Ableitung geprüft.
     */
    public Optional<RechteAbleitung.OcppStufe> ocppStufe(UUID siteId) {
        Zugriff z = ZugriffContext.get();
        if (ungeprueft(z) != null || siteId == null) {
            return Optional.empty();
        }
        if (!geltungsbereich.siteVisible(siteId)) {
            return Optional.of(RechteAbleitung.OcppStufe.KEINE);
        }
        List<UUID> standorte = jdbc.queryForList(ANLAGE_STANDORT, UUID.class, siteId);
        String standort = standorte.isEmpty() || standorte.get(0) == null ? OHNE_STANDORT : standorte.get(0).toString();
        return Optional.of(RechteAbleitung.ocppStufe(benutzer(z), kundenbereich(standort, List.of()), standort,
                z.stand()).stufe());
    }

    /** Der Platzhalter-Standort einer Anlage ohne Zuordnung: ihn deckt nur eine unternehmensweite Zuweisung. */
    private static final String OHNE_STANDORT = "anlage-ohne-standort";

    /**
     * Der Aufrufer als Benutzer der Rechte-Ableitung — für die Dienste, die ihr Urteil selbst sprechen (Kennzahlen,
     * Berichte, Korrekturen). Leer ohne Kontext und am Umschalter: dort bleibt die Festlegung von vor IP-6.
     */
    public static Optional<Benutzer> aufrufer() {
        Zugriff z = ZugriffContext.get();
        return ungeprueft(z) != null ? Optional.empty() : Optional.of(benutzer(z));
    }

    // ------------------------------------------------------------------ Urteil

    private static Ergebnis ungeprueft(Zugriff z) {
        if (z == null) {
            return Ergebnis.OHNE_KONTEXT;
        }
        return z.zugang() == Zugang.UMSCHALTER ? Ergebnis.UMSCHALTER : null;
    }

    /** Das Objekt, aufgelöst auf das, woran das Recht hängt. */
    private sealed interface Ort {
        record Unsichtbar() implements Ort {}

        record Ausserhalb() implements Ort {}

        record Unternehmen() implements Ort {}

        record AmStandort(String standort) implements Ort {}

        /** Hängt heute an keinem Standort: nur unternehmensweite Rollen (wie eine Anlage ohne Zuordnung, IP-5). */
        record OhneStandort() implements Ort {}

        /** Eine Messstelle ohne Ort: die Vorprüfung „irgendwo" (sie hängt noch an keinem Standort). */
        record NochOhneOrt() implements Ort {}
    }

    private Urteil urteil(Zugriff z, String kennung, Ort ort, Supplier<? extends RuntimeException> nichtGefunden) {
        return switch (ort) {
            case Ort.Unsichtbar u -> new Urteil(Ergebnis.UNSICHTBAR, null);
            case Ort.Ausserhalb a -> ausserhalb(nichtGefunden);
            case Ort.NochOhneOrt n -> irgendwo(z, List.of(kennung));
            case Ort.Unternehmen u -> darf(z, kennung, Ziel.unternehmen(), null, nichtGefunden);
            case Ort.AmStandort s -> darf(z, kennung, Ziel.standort(s.standort()), s.standort(), nichtGefunden);
            case Ort.OhneStandort o -> darf(z, kennung, Ziel.anlage(new Anlage("", List.of()), null), null, nichtGefunden);
        };
    }

    private Urteil darf(Zugriff z, String kennung, Ziel ziel, String standort,
            Supplier<? extends RuntimeException> nichtGefunden) {
        Benutzer b = benutzer(z);
        DarfErgebnis d = RechteAbleitung.darf(RechteMatrixDatei.matrix(), b, kundenbereich(standort, List.of()), kennung,
                ziel, z.stand());
        if (d.darf()) {
            ZugriffContext.handelndeRolle(d.rolle());
            return new Urteil(Ergebnis.ERLAUBT, null);
        }
        if (d.grund() == RechteAbleitung.Grund.ZUGRIFF_BEENDET) {
            // Nicht „gibt es nicht“, sondern „Sie hatten es“ (IP-9, §5.9): der Standort steht in der BEENDETEN
            // Zuweisung des Aufrufers, die der Zugriff-Kontext mitführt — sein Name gehört ihm, nicht dem Zaun.
            return new Urteil(Ergebnis.ZUGRIFF_BEENDET, ZugriffBeendet.standort(standortName(z, standort)));
        }
        if (!d.sichtbar()) {
            return ausserhalb(nichtGefunden);
        }
        return rechtFehlt(z, b, kennung, ziel, standort);
    }

    /** Der Kundenname des Standorts aus den Zuweisungen des Aufrufers — {@code null}, wenn keine ihn nennt. */
    private static String standortName(Zugriff z, String standortId) {
        if (standortId == null) {
            return null;
        }
        return Stream.concat(z.zuweisungen().stream(), z.beendete().stream())
                .filter(x -> x.standortId() != null && standortId.equals(x.standortId().toString()))
                .map(ZugriffRepository.Zeile::standortName).filter(Objects::nonNull).findFirst().orElse(null);
    }

    /** Hat der Aufrufer eines der Rechte im Unternehmen oder an einem seiner Standorte? */
    private Urteil irgendwo(Zugriff z, List<String> kennungen) {
        Benutzer b = benutzer(z);
        Set<String> standorte = new LinkedHashSet<>();
        b.zuweisungen().stream().filter(x -> x.wirksam(z.stand()) && x.standorte() != null)
                .forEach(x -> standorte.addAll(x.standorte()));
        // Der Satz der Ablehnung nennt die Rolle am ersten eigenen Standort (etwa Bearbeiter), sonst die im Unternehmen.
        String kennungNein = kennungen.get(0);
        String standortNein = null;
        for (String kennung : kennungen) {
            List<String> ziele = new ArrayList<>();
            ziele.add(null);
            ziele.addAll(standorte);
            for (String s : ziele) {
                DarfErgebnis d = RechteAbleitung.darf(RechteMatrixDatei.matrix(), b, kundenbereich(s, List.of()),
                        kennung, s == null ? Ziel.unternehmen() : Ziel.standort(s), z.stand());
                if (d.darf()) {
                    ZugriffContext.handelndeRolle(d.rolle());
                    return new Urteil(Ergebnis.ERLAUBT, null);
                }
                if (s != null && standortNein == null) {
                    kennungNein = kennung;
                    standortNein = s;
                }
            }
        }
        return rechtFehlt(z, b, kennungNein, standortNein == null ? Ziel.unternehmen() : Ziel.standort(standortNein),
                standortNein);
    }

    /** 403 mit dem Weg zum Kundenadministrator — die Namen werden nur für die Ablehnung gelesen. */
    private Urteil rechtFehlt(Zugriff z, Benutzer b, String kennung, Ziel ziel, String standort) {
        List<Person> kundenadministratoren = zugriffe.wirksamImKundenbereich(Rolle.KUNDENADMINISTRATOR, z.stand())
                .stream().map(a -> new Person(a.zeile().benutzerSub(), a.name())).distinct().toList();
        DarfErgebnis d = RechteAbleitung.darf(RechteMatrixDatei.matrix(), b,
                kundenbereich(standort, kundenadministratoren), kennung, ziel, z.stand());
        return new Urteil(Ergebnis.RECHT_FEHLT, new RechtFehlt(kennung, d));
    }

    private static Urteil ausserhalb(Supplier<? extends RuntimeException> nichtGefunden) {
        RuntimeException e = nichtGefunden == null ? null : nichtGefunden.get();
        return new Urteil(Ergebnis.AUSSERHALB, e != null ? e : new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    /** Der Kundenbereich des Vertrags-Eingangs: nur der Ziel-Standort — über fremde entscheidet die Zuweisung. */
    private static Kundenbereich kundenbereich(String standort, List<Person> kundenadministratoren) {
        return new Kundenbereich("Kundenbereich", standort == null ? List.of() : List.of(new Standort(standort, standort)),
                kundenadministratoren);
    }

    /**
     * Der Aufrufer als Eingang des Vertrags. Er bekommt die wirksamen UND die beendeten Zuweisungen (IP-9): der
     * Vertrag filtert selbst nach {@code wirksam(jetzt)} und braucht die beendeten allein, um eine Ablehnung
     * {@code zugriff_beendet} statt {@code ausserhalb_geltungsbereich} zu nennen (§5.9). Ein Bestandskonto (E12)
     * hat per Definition keine.
     */
    static Benutzer benutzer(Zugriff z) {
        List<Zuweisung> zuweisungen = z.zugang() == Zugang.KONTO && z.bestandskonto()
                ? List.of(new Zuweisung(Rolle.KUNDENADMINISTRATOR, null, null, null, IMMER, null, null))
                : Stream.concat(z.zuweisungen().stream(), z.beendete().stream())
                        .map(RechtPruefung::zuweisung).toList();
        return new Benutzer(z.sub(), z.sub(), z.konto(), KontoZustand.AKTIV, zuweisungen);
    }

    /** Wie {@link ZugriffRepository.Zeile#alsZuweisung}, der Standort aber als ID. */
    private static Zuweisung zuweisung(ZugriffRepository.Zeile x) {
        String bis = x.gueltigBis() != null
                ? x.gueltigBis().toString()
                : x.endetAm() != null ? OffsetDateTime.ofInstant(x.endetAm(), x.zeitzone()).toString() : null;
        return new Zuweisung(x.rolle(), x.standortId() == null ? null : List.of(x.standortId().toString()), x.umfang(),
                x.art(), x.gueltigAb(), bis, x.beendetAm());
    }

    // ------------------------------------------------------------------ Auflösung

    private static final String HEUTE = "uems_zugriff_heute(%s.tenant_id)";

    private static final String ANLAGE_STANDORT = "SELECT a.standort_id FROM anlage_standort a "
            + "WHERE a.site_id = ? AND a.aufgehoben_am IS NULL "
            + "AND daterange(a.gueltig_ab, a.gueltig_bis, '[]') @> " + HEUTE.formatted("a") + " "
            + "ORDER BY a.gueltig_ab DESC LIMIT 1";

    // Ein Gebäude hängt am Standort, ein Bereich am Standort oder an einem Gebäude — eine Stufe, wie
    // uems_zugriff_ort_sichtbar (V20260915190000).
    private static final String ORT_STANDORT = "SELECT coalesce(z.eltern_standort_id, g.eltern_standort_id) "
            + "FROM ort o "
            + "LEFT JOIN ort_zuordnung z ON z.tenant_id = o.tenant_id AND z.ort_id = o.id AND z.aufgehoben_am IS NULL "
            + "AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> " + HEUTE.formatted("o") + " "
            + "LEFT JOIN ort_zuordnung g ON g.tenant_id = z.tenant_id AND g.ort_id = z.eltern_ort_id "
            + "AND g.aufgehoben_am IS NULL "
            + "AND daterange(g.gueltig_ab, g.gueltig_bis, '[]') @> " + HEUTE.formatted("o") + " "
            + "WHERE o.id = ? LIMIT 1";

    private static final String MESSSTELLE_ORT = "SELECT mo.unternehmen_id, mo.standort_id, mo.ort_id "
            + "FROM messstelle m "
            + "LEFT JOIN messstelle_ort mo ON mo.tenant_id = m.tenant_id AND mo.messstelle_id = m.id "
            + "AND mo.aufgehoben_am IS NULL "
            + "AND daterange(mo.gueltig_ab, mo.gueltig_bis, '[]') @> " + HEUTE.formatted("m") + " "
            + "WHERE m.id = ? LIMIT 1";

    private static final String BEZUGSGROESSE_GELTUNG =
            "SELECT geltung_art, standort_id, ort_id, messstelle_id FROM bezugsgroesse WHERE id = ?";

    private Ort aufloesen(RechtZiel ziel, UUID id) {
        return switch (ziel) {
            case UNTERNEHMEN -> new Ort.Unternehmen();
            case ANLAGE -> geltungsbereich.siteVisible(id) ? anlage(id) : new Ort.Unsichtbar();
            case STANDORT -> sichtbar("standort", id) ? new Ort.AmStandort(id.toString()) : new Ort.Unsichtbar();
            case ORT -> ort(id);
            case DEVICE -> ueberAnlage(jdbc.query("SELECT site_id FROM device WHERE id = ?",
                    (rs, i) -> Optional.ofNullable(rs.getObject(1, UUID.class)), id));
            case GERAET -> ueberAnlage(jdbc.query("SELECT site_id FROM geraet WHERE id = ?",
                    (rs, i) -> Optional.ofNullable(rs.getObject(1, UUID.class)), id));
            case MESSSTELLE -> messstelle(id);
            case BEZUGSGROESSE -> bezugsgroesse(id);
            case DIENST -> throw new IllegalArgumentException("DIENST löst kein Objekt auf");
        };
    }

    private boolean sichtbar(String tabelle, UUID id) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM " + tabelle + " WHERE id = ?)", Boolean.class, id));
    }

    private Ort anlage(UUID site) {
        List<UUID> standort = jdbc.queryForList(ANLAGE_STANDORT, UUID.class, site);
        return standort.isEmpty() || standort.get(0) == null
                ? new Ort.OhneStandort()
                : new Ort.AmStandort(standort.get(0).toString());
    }

    /**
     * Gerät über seine Anlage. {@code device} ({@code site_scope}, V20260915190000) und {@code geraet}
     * ({@code wago_geraet_site_scope}, V20260918102000; Entscheid A vom 21.09.2026) tragen den Standort-Zaun selbst:
     * eine Zeile hinter dem Zaun ist unsichtbar, die Route antwortet 404 mit dem gemeinsamen Körper.
     */
    private Ort ueberAnlage(List<Optional<UUID>> zeilen) {
        if (zeilen.isEmpty()) {
            return new Ort.Unsichtbar();
        }
        Optional<UUID> site = zeilen.get(0);
        if (site.isEmpty()) {
            return new Ort.OhneStandort();
        }
        if (!geltungsbereich.siteVisible(site.get())) {
            return new Ort.Unsichtbar();
        }
        return anlage(site.get());
    }

    private Ort ort(UUID id) {
        List<Optional<UUID>> zeilen = jdbc.query(ORT_STANDORT,
                (rs, i) -> Optional.ofNullable(rs.getObject(1, UUID.class)), id);
        if (zeilen.isEmpty()) {
            return new Ort.Unsichtbar();
        }
        return zeilen.get(0).<Ort>map(s -> new Ort.AmStandort(s.toString())).orElseGet(Ort.OhneStandort::new);
    }

    /** Ein Gebäude/Bereich, auf das ein ungezäuntes Objekt zeigt: unsichtbar heißt dort „außerhalb". */
    private Ort ortVon(UUID ortId) {
        Ort o = ort(ortId);
        return o instanceof Ort.Unsichtbar ? new Ort.Ausserhalb() : o;
    }

    private record Verweis(String art, UUID unternehmen, UUID standort, UUID ort, UUID messstelle) {}

    private Ort messstelle(UUID id) {
        // Erst lesen, dann auflösen: keine zweite Abfrage, solange die erste ihr Ergebnis offen hält.
        List<Verweis> zeilen = jdbc.query(MESSSTELLE_ORT, (rs, i) -> new Verweis(null,
                rs.getObject("unternehmen_id", UUID.class), rs.getObject("standort_id", UUID.class),
                rs.getObject("ort_id", UUID.class), null), id);
        if (zeilen.isEmpty()) {
            return new Ort.Unsichtbar();
        }
        Verweis v = zeilen.get(0);
        if (v.unternehmen() != null) {
            return new Ort.Unternehmen();
        }
        if (v.standort() != null) {
            return new Ort.AmStandort(v.standort().toString());
        }
        return v.ort() != null ? ortVon(v.ort()) : new Ort.NochOhneOrt();
    }

    private Ort bezugsgroesse(UUID id) {
        List<Verweis> zeilen = jdbc.query(BEZUGSGROESSE_GELTUNG, (rs, i) -> new Verweis(rs.getString("geltung_art"),
                null, rs.getObject("standort_id", UUID.class), rs.getObject("ort_id", UUID.class),
                rs.getObject("messstelle_id", UUID.class)), id);
        if (zeilen.isEmpty()) {
            return new Ort.Unsichtbar();
        }
        Verweis v = zeilen.get(0);
        return geltung(v.art(), v.standort(), v.ort(), v.messstelle());
    }

    /**
     * Die Geltung einer Bezugsgröße (AP-09) als Ziel — auch für den Anfragekörper ({@link #pruefenGeltung}).
     * Prozess und Kostenstelle gelten unternehmensweit (AP-03 §4.9).
     */
    private Ort geltung(String art, UUID standort, UUID ort, UUID messstelle) {
        return switch (Objects.requireNonNullElse(art, "")) {
            case "standort" -> standort == null ? new Ort.Ausserhalb() : new Ort.AmStandort(standort.toString());
            case "gebaeude", "bereich" -> ort == null ? new Ort.Ausserhalb() : ortVon(ort);
            case "messstelle" -> {
                Ort m = messstelle == null ? new Ort.Unsichtbar() : messstelle(messstelle);
                yield m instanceof Ort.Unsichtbar ? new Ort.Ausserhalb() : m;
            }
            default -> new Ort.Unternehmen();
        };
    }

    /**
     * Die Geltung aus einem Anfragekörper (Bezugsgröße anlegen/ändern). Eine unbekannte Art oder Kennung geht durch —
     * der Dienst antwortet {@code geltung_unbekannt}; ein Ziel außerhalb wirft {@code nichtGefunden}.
     */
    public void pruefenGeltung(String kennung, String art, UUID id, Supplier<? extends RuntimeException> nichtGefunden) {
        Zugriff z = ZugriffContext.get();
        if (ungeprueft(z) != null || art == null) {
            return;
        }
        Ort ort = switch (art) {
            case "unternehmen", "prozess", "kostenstelle" -> new Ort.Unternehmen();
            case "standort" -> id == null ? new Ort.Unsichtbar()
                    : sichtbar("standort", id) ? new Ort.AmStandort(id.toString()) : new Ort.Ausserhalb();
            case "gebaeude", "bereich", "messstelle" -> id == null ? new Ort.Unsichtbar()
                    : geltung(art, null, "messstelle".equals(art) ? null : id, "messstelle".equals(art) ? id : null);
            default -> new Ort.Unsichtbar();
        };
        Urteil u = zaehle(urteil(z, kennung, ort, nichtGefunden));
        if (u.ablehnung() != null) {
            throw u.ablehnung();
        }
    }

    // ------------------------------------------------------------------ Lesen

    /** Die Aktion des Lesens: „Bezugsgrößen und Werte, Herkunft, Fassungen, Importe ansehen" (AP-09 §4.11). */
    private static final String ANSEHEN = KennzahlRegeln.ANSEHEN;

    /**
     * Der Leseweg einer Route zu einem Objekt per Kennung (AP-03 R-A1, §4.9): dieselbe Auflösung wie {@link #pruefen},
     * gefragt mit {@code messwerte.ansehen} (AP-09 §4.11). Wer das Recht unternehmensweit hat, sieht jedes Objekt des
     * Kundenbereichs; eine Unternehmens-Geltung (auch Prozess und Kostenstelle, {@link #geltung}) sieht NUR er — für
     * jedes andere Konto gibt es sie nicht. Außerhalb wirft {@code nichtGefunden}, nie 403: die Antwort gleicht der
     * einer unbekannten Kennung. Ein unsichtbares Objekt geht durch (die Route antwortet selbst); ohne Kontext und am
     * Umschalter bleibt alles wie bisher. Gezählt wird nicht ({@code voltpilot_recht_total} zählt Schreibrouten).
     */
    public void pruefenLesen(RechtZiel ziel, UUID id, Supplier<? extends RuntimeException> nichtGefunden) {
        Urteil u = lesen(ziel, id, nichtGefunden);
        if (u.ablehnung() != null) {
            throw u.ablehnung();
        }
    }

    /** {@link #pruefenLesen} für eine Liste: {@code false} heißt, die Zeile fehlt — ohne Hinweis, ohne Anzahl. */
    public boolean lesbar(RechtZiel ziel, UUID id) {
        Urteil u = lesen(ziel, id, null);
        return u.ablehnung() == null && u.ergebnis() != Ergebnis.UNSICHTBAR;
    }

    /**
     * Der Hinweis an der Stelle einer Zahl, die einen Eingang außerhalb des Zugriffs umfasst (AP-03 R-A6, wörtlich):
     * ohne Namen, ohne Werte, ohne Anzahl der fremden Eingänge. Derselbe Satz wie an der Kennzahl.
     */
    public static final String AUSSERHALB_ZUGRIFF = RechteAbleitung.TEXTE.get("standortuebergreifend");

    /**
     * Liegt JEDER Eingang im Zugriff (AP-03 R-A3)? {@code false} heißt: die Zahl, die aus ihnen entsteht, fehlt ganz
     * — nicht teilweise, nicht als Rest —, und an ihrer Stelle steht {@link #AUSSERHALB_ZUGRIFF}. Dieselbe Frage wie
     * {@link #lesbar} je Eingang: ohne Kontext, am Umschalter und mit einer unternehmensweiten Rolle (auch das
     * Bestandskonto) ist jeder Eingang im Zugriff. Nur Routen fragen; interne Leser rechnen mit allen Eingängen.
     */
    public boolean alleLesbar(RechtZiel ziel, Collection<UUID> eingaenge) {
        return eingaenge.stream().allMatch(id -> lesbar(ziel, id));
    }

    /** Was ein Konto von einem Auswahl-Katalog der Geltung Unternehmen (Kostenstellen, Prozesse) sieht. */
    public enum Katalog {
        /** Jede Zeile mit jedem Feld — wie vor dem Zaun. */
        GANZ,
        /** Jede Zeile, aber nur ihre Stammdaten: Kennung, Kennzeichen, Name, Gültigkeit, Eltern. */
        STAMMDATEN,
        /** Keine Zeile — ohne Hinweis, ohne Anzahl. */
        KEINER
    }

    /**
     * Die Rechte, die das Zuordnen einer Messstelle zu Prozess und Kostenstelle tragen — genau die {@link Recht} der
     * zwei Schreibwege {@code PUT /messstellen/{id}/prozesse} und {@code PUT /messstellen/{id}/verteilung}.
     */
    static final List<String> ZUORDNEN = List.of("messstelle.bearbeiten", "messstelle.verteilung");

    /**
     * Darf dieses Konto den Auswahl-Katalog der Kostenstellen und Prozesse sehen (Entscheid 21.09.2026, Lesart B)? Eine
     * unternehmensweite Rolle ({@link #lesbar} für die Geltung Unternehmen), ohne Kontext und am Umschalter: ganz. Wer
     * eines der Rechte {@link #ZUORDNEN} im Unternehmen oder an einem seiner Standorte hat, sieht die Namen, die er zum
     * Zuordnen braucht — nur die Stammdaten, keine Werte, keine Messstellen (AP-03 R-A1 gilt weiter für Detail und
     * Bilanz). Jedes andere Konto: keiner. Gezählt wird nicht (keine Schreibroute).
     */
    public Katalog auswahlKatalog() {
        Zugriff z = ZugriffContext.get();
        if (ungeprueft(z) != null || unternehmensweitLesend(z)) {
            return Katalog.GANZ;
        }
        Benutzer b = benutzer(z);
        List<String> ziele = new ArrayList<>();
        ziele.add(null);
        b.zuweisungen().stream().filter(x -> x.wirksam(z.stand()) && x.standorte() != null)
                .forEach(x -> ziele.addAll(x.standorte()));
        for (String kennung : ZUORDNEN) {
            for (String s : ziele) {
                if (RechteAbleitung.darf(RechteMatrixDatei.matrix(), b, kundenbereich(s, List.of()), kennung,
                        s == null ? Ziel.unternehmen() : Ziel.standort(s), z.stand()).darf()) {
                    return Katalog.STAMMDATEN;
                }
            }
        }
        return Katalog.KEINER;
    }

    /** Hat der Aufrufer {@code messwerte.ansehen} unternehmensweit — sieht er also jedes Objekt des Kundenbereichs? */
    private boolean unternehmensweitLesend(Zugriff z) {
        return RechteAbleitung.darf(RechteMatrixDatei.matrix(), benutzer(z), kundenbereich(null, List.of()), ANSEHEN,
                Ziel.unternehmen(), z.stand()).darf();
    }

    private Urteil lesen(RechtZiel ziel, UUID id, Supplier<? extends RuntimeException> nichtGefunden) {
        Zugriff z = ZugriffContext.get();
        Ergebnis ohne = ungeprueft(z);
        if (ohne != null) {
            return new Urteil(ohne, null);
        }
        if (unternehmensweitLesend(z)) {
            return new Urteil(Ergebnis.ERLAUBT, null);
        }
        if (id == null) {
            return new Urteil(Ergebnis.UNSICHTBAR, null);
        }
        Ort ort = aufloesen(ziel, id);
        return urteil(z, ANSEHEN, ort instanceof Ort.Unternehmen ? new Ort.Ausserhalb() : ort, nichtGefunden);
    }

    /** Die 404, die die Route für eine nie vergebene Kennung gibt — {@code RechtMatrixApiTest} vergleicht beide. */
    static RuntimeException nichtGefunden(RechtZiel ziel, String controller) {
        return switch (ziel) {
            case MESSSTELLE -> switch (Objects.requireNonNullElse(controller, "")) {
                case "VerteilungController" -> VerteilungAbgelehnt.von(VerteilungAbgelehnt.Ablehnung.NICHT_GEFUNDEN);
                case "KostenstelleProzessController" ->
                        KostenstelleProzessAbgelehnt.von(KostenstelleProzessAbgelehnt.Ablehnung.NICHT_GEFUNDEN);
                default -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden.");
            };
            case BEZUGSGROESSE -> BezugsgroesseAbgelehnt.von(BezugsgroesseRegeln.Ablehnung.NICHT_GEFUNDEN);
            case GERAET -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Gerät nicht gefunden.");
            default -> {
                // Gezäunte Objekte sind sichtbar genau an den eigenen Standorten — hierher kommt keine Anfrage.
                log.warn("Recht: außerhalb ohne eigene 404 für {} an {}", ziel, controller);
                yield new ResponseStatusException(HttpStatus.NOT_FOUND);
            }
        };
    }

    private static UUID uuid(String s) {
        if (s == null) {
            return null;
        }
        try {
            return UUID.fromString(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private Urteil zaehle(Urteil u) {
        Counter.builder("voltpilot_recht_total")
                .description("Rechte-Prüfungen der Schreibrouten (UEMS AP-03 IP-6) nach Ergebnis")
                .tag("ergebnis", u.ergebnis().code())
                .register(metriken)
                .increment();
        return u;
    }
}
