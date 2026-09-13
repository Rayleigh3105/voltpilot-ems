package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.web.dto.MessstelleDto;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.sql.Date;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Bilanz je Anlage (UEMS AP-10 IP-9) — ein LESE-Modell über das, was schon steht, und der eine
 * Schreibweg „Rest anlegen“ (E18).
 *
 * <p><b>Der Rest ist eine Rechnung, keine gespeicherte Zahl (E3).</b> Je Hauptzähler Bezug der Anlage
 * und je Tag der Periode leitet {@link BilanzAbleitung#restAusStellung} die Terme aus der Stellung ab;
 * Tage mit denselben Termen bilden einen Abschnitt. Die Mengen der Terme kommen aus dem Lese-Modell
 * „Werte je Messstelle“ (AP-08 IP-9, {@link MessstelleWerteService}), die Zeilen Zufluss · Abfluss ·
 * zugeordnet aus {@link BilanzAbleitung#summe} und der Rest aus
 * {@link MessstelleFormelRegeln#periodenwert} ({@code rest} → {@link BilanzAbleitung#rest}). Hier wird
 * nichts gerechnet und nichts formatiert — ändert sich die Stellung, ändert sich der Rest von selbst.
 *
 * <p><b>Abschnitte.</b> Gelten in der Periode überall dieselben Terme, rechnet EIN Abschnitt mit dem
 * Periodenwert (Tage ohne Hauptzähler zählen nicht als Wechsel). Wechseln sie, rechnet jeder Abschnitt
 * Tag für Tag mit Tageswerten — eine Zahl über die ganze Periode ist dann ein Periodenwert der
 * berechneten Messstelle, und den baut AP-10 IP-10.
 *
 * <p><b>Live</b> kommt über den PR-688-Weg ({@link MessstelleFormelService#restLive}).
 *
 * <p>Rechte (eingetragen, nicht durchgesetzt — AP-03): lesen {@code messstelle.ansehen}, „Rest
 * anlegen“ {@code messstelle.formel} (AP-10 §4.10).
 */
@Service
public class BilanzService {

    public static final List<String> PERIODEN = List.of("tag", "monat", "jahr");
    public static final String VORGABE_PERIODE = "monat";
    public static final String AKTION_REST_ANLEGEN = "rest_anlegen";
    /** Der vorbelegte Name einer Rest-Messstelle (E18): „&lt;Anlage&gt; nicht zugeordnet“. */
    static final String NAME_ENDUNG = " " + BilanzAbleitung.NICHT_ZUGEORDNET;
    private static final String HAUPTZAEHLER = "Hauptzähler";
    private static final String BEZUG = "Bezug";
    private static final String KWH = "kWh";

    private final JdbcTemplate jdbc;
    private final BilanzStellungen stellungen;
    private final BilanzRestRepository reste;
    private final MessstelleWerteService werte;
    private final MessstelleFormelService formeln;
    private final MessstelleService messstellen;
    private volatile Clock uhr = Clock.systemUTC();

    public BilanzService(JdbcTemplate jdbc, BilanzStellungen stellungen,
            BilanzRestRepository reste, MessstelleWerteService werte, MessstelleFormelService formeln,
            MessstelleService messstellen) {
        this.jdbc = jdbc;
        this.stellungen = stellungen;
        this.reste = reste;
        this.werte = werte;
        this.formeln = formeln;
        this.messstellen = messstellen;
    }

    /** Nur für Tests: die Uhr, an der „heute“ hängt (der Live-Wert hat seine eigene, PR 688). */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------ lesen

    public BilanzDto.Bilanz bilanz(UUID siteId, String periodeWort, LocalDate amTag) {
        String name = anlageName(siteId);
        String periode = periodeWort == null || periodeWort.isBlank() ? VORGABE_PERIODE : periodeWort;
        if (!PERIODEN.contains(periode)) {
            throw BilanzAbgelehnt.anfrage("periode", "„periode“ ist tag, monat oder jahr.");
        }
        ZoneId zone = zone(siteId, amTag);
        LocalDate heute = uhr.instant().atZone(zone).toLocalDate();
        LocalDate am = amTag == null ? heute : amTag;
        LocalDate von = switch (periode) {
            case "tag" -> am;
            case "monat" -> am.withDayOfMonth(1);
            default -> am.withDayOfYear(1);
        };
        LocalDate bis = switch (periode) {
            case "tag" -> am;
            case "monat" -> am.withDayOfMonth(am.lengthOfMonth());
            default -> am.withDayOfYear(am.lengthOfYear());
        };
        BilanzStellungen.Stand stand = stellungen.lesen();
        Map<UUID, BilanzRestRepository.Rest> alleReste = reste.alle();
        List<BilanzDto.Hauptzaehler> hauptzaehler = new ArrayList<>();
        for (String kz : hauptzaehlerDerAnlage(stand, siteId, von, bis)) {
            Messstelle x = stand.nachKennzeichen().get(kz);
            hauptzaehler.add(hauptzaehler(x, siteId, name, periode, von, bis, heute, stand, alleReste.get(x.id())));
        }
        return new BilanzDto.Bilanz(new BilanzDto.Anlage(siteId, name), periode, am, von, bis, zone.getId(),
                List.copyOf(hauptzaehler));
    }

    /** Die Hauptzähler Bezug (gemessen, Strom), die in der Periode an mindestens einem Tag in DIESER Anlage stehen. */
    private static List<String> hauptzaehlerDerAnlage(BilanzStellungen.Stand stand, UUID siteId, LocalDate von,
            LocalDate bis) {
        TreeSet<String> out = new TreeSet<>();
        for (BilanzAbleitung.StellungZeile z : stand.zeilen()) {
            if (HAUPTZAEHLER.equals(z.stellung()) && BEZUG.equals(z.richtung())
                    && siteId.toString().equals(z.anlage())
                    && (z.ab() == null || !z.ab().isAfter(bis)) && (z.bis() == null || !z.bis().isBefore(von))) {
                out.add(z.messstelle());
            }
        }
        return List.copyOf(out);
    }

    private record Lauf(LocalDate von, LocalDate bis, BilanzAbleitung.RestFassung fassung) {}

    private BilanzDto.Hauptzaehler hauptzaehler(Messstelle x, UUID siteId, String anlageName, String periode,
            LocalDate von, LocalDate bis, LocalDate heute, BilanzStellungen.Stand stand,
            BilanzRestRepository.Rest rest) {
        // E3: je TAG die Terme aus der Stellung; gleiche Terme hintereinander sind ein Abschnitt.
        List<Lauf> laeufe = new ArrayList<>();
        for (LocalDate tag = von; !tag.isAfter(bis); tag = tag.plusDays(1)) {
            BilanzAbleitung.RestFassung f = stand.rest(x.kennzeichen(), tag);
            if (f.fehler() != null || !siteId.toString().equals(f.anlage())) {
                continue;
            }
            Lauf letzter = laeufe.isEmpty() ? null : laeufe.get(laeufe.size() - 1);
            if (letzter != null && letzter.fassung().terme().equals(f.terme())
                    && letzter.bis().plusDays(1).equals(tag)) {
                laeufe.set(laeufe.size() - 1, new Lauf(letzter.von(), tag, letzter.fassung()));
            } else {
                laeufe.add(new Lauf(tag, tag, f));
            }
        }
        boolean gleicheTerme = laeufe.stream().map(l -> l.fassung().terme()).distinct().count() <= 1;
        List<BilanzDto.Abschnitt> abschnitte = new ArrayList<>();
        if (gleicheTerme && !laeufe.isEmpty()) {
            abschnitte.add(abschnitt(laeufe.get(0).von(), laeufe.get(laeufe.size() - 1).bis(), periode, von, bis,
                    laeufe.get(0).fassung(), stand));
        } else {
            for (Lauf l : laeufe) {
                abschnitte.add(abschnitt(l.von(), l.bis(), "tag", l.von(), l.bis(), l.fassung(), stand));
            }
        }

        BilanzDto.MessstelleRef restRef = null;
        BilanzDto.Vorschlag vorschlag = null;
        if (rest != null) {
            MessstelleDto.Messstelle r = messstellen.eine(rest.messstelleId());
            restRef = new BilanzDto.MessstelleRef(r.id(), r.kennzeichen(), r.name());
        } else {
            BilanzAbleitung.RestFassung jetzt = stand.rest(x.kennzeichen(), heute);
            if (jetzt.fehler() == null && siteId.toString().equals(jetzt.anlage())) {
                vorschlag = new BilanzDto.Vorschlag(AKTION_REST_ANLEGEN, x.id(), anlageName + NAME_ENDUNG);
            }
        }

        MessstelleFormelService.RestLive live = formeln.restLive(x.id());
        List<BilanzDto.Fehlender> fehlende = live.urteil().fehlende().stream()
                .map(f -> new BilanzDto.Fehlender(f.term(), f.grund())).toList();
        BilanzDto.Live liveDto = new BilanzDto.Live(live.urteil().wert(), MessstelleFormelService.RestLive.EINHEIT,
                live.urteil().wert() == null, fehlende,
                live.stand() == null ? null : live.stand().atOffset(ZoneOffset.UTC),
                List.of(BilanzAbleitung.VORLAEUFIG_GERAETE_VERDICHTUNG));

        return new BilanzDto.Hauptzaehler(new BilanzDto.MessstelleRef(x.id(), x.kennzeichen(), x.name()), restRef,
                vorschlag, !gleicheTerme, List.copyOf(abschnitte), liveDto);
    }

    /**
     * Ein Abschnitt mit seinen Zeilen. {@code raster} = die Periode: EIN Werte-Eintrag über
     * [{@code von}, {@code bis}]; {@code raster} = {@code tag}: je Tag einer.
     */
    private BilanzDto.Abschnitt abschnitt(LocalDate abschnittVon, LocalDate abschnittBis, String raster,
            LocalDate von, LocalDate bis, BilanzAbleitung.RestFassung fassung, BilanzStellungen.Stand stand) {
        List<BilanzDto.Term> terme = new ArrayList<>();
        Map<String, List<MessstelleWerteDto.Wert>> jeMessstelle = new LinkedHashMap<>();
        Map<String, String> gruende = new LinkedHashMap<>();
        for (BilanzAbleitung.RestTerm t : fassung.terme()) {
            Messstelle m = stand.nachKennzeichen().get(t.messstelle());
            terme.add(new BilanzDto.Term(t.messstelle(), m == null ? null : m.id(), m == null ? null : m.name(),
                    t.rolle(), t.anteil()));
            if (!jeMessstelle.containsKey(t.messstelle())) {
                try {
                    jeMessstelle.put(t.messstelle(), werte.werte(t.messstelle(), raster, von.toString(),
                            bis.toString(), null).werte());
                } catch (MessstelleWerteRegeln.Abgelehnt e) {
                    jeMessstelle.put(t.messstelle(), List.of());
                    gruende.put(t.messstelle(), e.ablehnung().grund().wort());
                }
            }
        }
        List<BilanzDto.Werte> zeilen = new ArrayList<>();
        List<LocalDate> tage = new ArrayList<>();
        if ("tag".equals(raster)) {
            for (LocalDate t = von; !t.isAfter(bis); t = t.plusDays(1)) {
                tage.add(t);
            }
        } else {
            tage.add(null);
        }
        for (LocalDate tag : tage) {
            List<BilanzAbleitung.Summand> zufluss = new ArrayList<>();
            List<BilanzAbleitung.Summand> abfluss = new ArrayList<>();
            List<BilanzAbleitung.Summand> zugeordnet = new ArrayList<>();
            List<MessstelleFormelRegeln.Periodeneingang> eingaenge = new ArrayList<>();
            List<BilanzDto.Eingang> eingangDtos = new ArrayList<>();
            for (BilanzAbleitung.RestTerm t : fassung.terme()) {
                MessstelleWerteDto.Wert w = wertAm(jeMessstelle.get(t.messstelle()), tag);
                BigDecimal menge = w == null ? null : w.menge();
                String zustand = w == null || w.zustand() == null || menge == null
                        ? BilanzAbleitung.KEINE_WERTE : w.zustand();
                Integer abdeckung = w == null ? null : w.abdeckungProzent();
                int version = w == null || w.version() == null ? 1 : w.version();
                List<String> kennzeichen = w == null || w.kennzeichen() == null ? List.of() : w.kennzeichen();
                String grund = w != null ? w.grund() : gruende.get(t.messstelle());
                BilanzAbleitung.Summand summand = new BilanzAbleitung.Summand(t.messstelle(), menge, zustand,
                        abdeckung, version, kennzeichen, "+", BigDecimal.ONE);
                switch (t.rolle()) {
                    case BilanzAbleitung.ZUFLUSS -> zufluss.add(summand);
                    case BilanzAbleitung.ABFLUSS -> abfluss.add(summand);
                    default -> zugeordnet.add(summand);
                }
                eingaenge.add(new MessstelleFormelRegeln.Periodeneingang(t.messstelle(), t.rolle(), t.anteil(), null,
                        null, menge, zustand, abdeckung, version, kennzeichen));
                eingangDtos.add(new BilanzDto.Eingang(t.messstelle(), t.rolle(), t.anteil(), menge, zustand, abdeckung,
                        version, kennzeichen, grund));
            }
            String ebene = tag == null ? raster : "tag";
            MessstelleFormelRegeln.Periodenwert r = MessstelleFormelRegeln.periodenwert(MessstelleFormelRegeln.REST,
                    MessstelleRegeln.BERECHNET, KWH, ebene, 1, List.of(), eingaenge);
            MessstelleRegeln.Groesse g = MessstelleFormelRegeln.hauptgroesse(MessstelleFormelRegeln.REST,
                    MessstelleRegeln.BERECHNET, "Intervallmenge", null).hauptgroesse();
            zeilen.add(new BilanzDto.Werte(tag == null ? von : tag, tag == null ? bis : tag,
                    summe(zufluss, ebene), summe(abfluss, ebene), summe(zugeordnet, ebene),
                    new BilanzDto.Rest(r.menge(), g.groesse(), g.richtung(), g.einheit(), r.zustand(),
                            r.abdeckungProzent(), r.fehlend(), r.kennzeichen(), r.satz()),
                    List.copyOf(eingangDtos)));
        }
        return new BilanzDto.Abschnitt(abschnittVon, abschnittBis, raster, List.copyOf(terme),
                fassung.ausserhalb(), List.copyOf(zeilen));
    }

    private static BilanzDto.Summe summe(List<BilanzAbleitung.Summand> summanden, String ebene) {
        BilanzAbleitung.SummeUrteil u = BilanzAbleitung.summe(KWH, ebene, summanden);
        return new BilanzDto.Summe(summanden.isEmpty() ? null : u.menge(), summanden.isEmpty() ? null : u.zustand(),
                u.abdeckungProzent(), u.vorhanden(), u.gesamt(), u.fehlend(), summanden.isEmpty() ? List.of()
                        : u.kennzeichen(), u.anzeige());
    }

    /** Der Wert eines Tages ({@code tag}) oder der einzige der Periode ({@code tag == null}). */
    private static MessstelleWerteDto.Wert wertAm(List<MessstelleWerteDto.Wert> werte, LocalDate tag) {
        if (werte == null || werte.isEmpty()) {
            return null;
        }
        if (tag == null) {
            return werte.get(0);
        }
        for (MessstelleWerteDto.Wert w : werte) {
            if (tag.equals(tagVon(w.von()))) {
                return w;
            }
        }
        return null;
    }

    private static LocalDate tagVon(String von) {
        try {
            return OffsetDateTime.parse(von).toLocalDate();
        } catch (DateTimeParseException e) {
            return LocalDate.parse(von.substring(0, 10));
        }
    }

    // --------------------------------------------------------------- schreiben

    /**
     * E18 — „Rest anlegen“ für einen Hauptzähler der Anlage: nur, wenn er HEUTE Hauptzähler Bezug dieser
     * Anlage ist (sonst 422 {@code rest_ohne_hauptzaehler}); nie zweimal
     * ({@link MessstelleFormelService#restAnlegen}).
     */
    public BilanzDto.RestAngelegt restAnlegen(UUID siteId, BilanzDto.RestAnlegen a, ProtokollAkteur wer) {
        String anlageName = anlageName(siteId);
        if (a == null || a.hauptzaehlerId() == null) {
            throw BilanzAbgelehnt.anfrage("hauptzaehler_id", "„hauptzaehler_id“ fehlt: die Messstelle des Hauptzählers.");
        }
        String name = a.name() == null ? anlageName + NAME_ENDUNG : a.name().strip();
        if (name.isEmpty()) {
            throw BilanzAbgelehnt.anfrage("name", "Der Name ist leer — ohne Angabe heißt der Rest „"
                    + anlageName + NAME_ENDUNG + "“.");
        }
        BilanzStellungen.Stand stand = stellungen.lesen();
        Messstelle x = stand.nachKennzeichen().values().stream()
                .filter(m -> m.id().equals(a.hauptzaehlerId())).findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
        LocalDate heute = uhr.instant().atZone(zone(siteId, null)).toLocalDate();
        BilanzAbleitung.RestFassung f = stand.rest(x.kennzeichen(), heute);
        if (f.fehler() != null || !siteId.toString().equals(f.anlage())) {
            throw BilanzAbgelehnt.ohneHauptzaehler(x.kennzeichen());
        }
        MessstelleFormelService.RestAngelegt r = formeln.restAnlegen(x, name, wer);
        return new BilanzDto.RestAngelegt(r.neu(), new BilanzDto.MessstelleRef(x.id(), x.kennzeichen(), x.name()),
                messstellen.eine(r.messstelleId()));
    }

    // ------------------------------------------------------------------ Helfer

    private String anlageName(UUID siteId) {
        if (TenantContext.get() == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Kein Kundenbereich gewählt.");
        }
        // Unter RLS: eine fremde Anlage ist nicht da (404), nie „verboten“.
        return jdbc.query("SELECT name FROM site WHERE id = ?", (rs, n) -> rs.getString(1), siteId).stream()
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden."));
    }

    /**
     * Die Zeitzone der Tage: STANDORT der Anlage am Tag → UNTERNEHMEN → Vorgabe — dieselbe Kette wie die
     * Tagesklasse und das Lese-Modell „Werte je Messstelle“, damit die Perioden auf den gespeicherten liegen.
     */
    private ZoneId zone(UUID siteId, LocalDate tag) {
        UUID tenant = TenantContext.get();
        LocalDate stichtag = tag == null ? uhr.instant().atZone(ZoneId.of(TagRegeln.VORGABE_ZONE)).toLocalDate() : tag;
        if (siteId != null) {
            Optional<String> standort = jdbc.query("""
                    SELECT st.zeitzone FROM anlage_standort a
                      JOIN standort st ON st.id = a.standort_id AND st.tenant_id = a.tenant_id
                     WHERE a.tenant_id = ? AND a.site_id = ? AND a.aufgehoben_am IS NULL
                       AND a.gueltig_ab <= ? AND (a.gueltig_bis IS NULL OR a.gueltig_bis >= ?)
                     ORDER BY a.gueltig_ab DESC LIMIT 1
                    """, (rs, n) -> rs.getString(1), tenant, siteId, Date.valueOf(stichtag), Date.valueOf(stichtag))
                    .stream().findFirst();
            if (standort.isPresent() && TagRegeln.ZONEN.contains(standort.get())) {
                return TagRegeln.zone(standort.get());
            }
        }
        Optional<String> unternehmen = jdbc.query(
                "SELECT zeitzone FROM unternehmen WHERE tenant_id = ? ORDER BY created_at, id LIMIT 1",
                (rs, n) -> rs.getString(1), tenant).stream().findFirst();
        if (unternehmen.isPresent() && TagRegeln.ZONEN.contains(unternehmen.get())) {
            return TagRegeln.zone(unternehmen.get());
        }
        return TagRegeln.zone(TagRegeln.VORGABE_ZONE);
    }
}
