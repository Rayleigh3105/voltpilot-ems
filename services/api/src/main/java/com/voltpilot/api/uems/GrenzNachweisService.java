package com.voltpilot.api.uems;

import com.voltpilot.api.uems.NetzanschlussAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.GrenzNachweisRegel.Viertelstunde;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import com.voltpilot.api.web.dto.NetzanschlussDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Predicate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Der Grenz-Nachweis am Netzanschluss rechnen (UEMS AP-15 IP-31, NW-8, M-1, M-2, B5, W10) — gerechnet, nie
 * gespeichert. Je Tag der abgeschlossenen Tage des Monats: die gebundene Anlage (AP-10), ihre wirksame Grenze je
 * Richtung über {@link GrenzeAufloesung} (engerer Wert aus Anlage und Grenzblatt, die Grenze kann im Monat wechseln)
 * und GENAU EIN Hauptzähler der Richtung aus den Stellungen ({@link BilanzStellungen}: Bezug = Hauptzähler Bezug,
 * Einspeisung = Hauptzähler Abgabe). Die Viertelstunden liest {@link MessstelleWerteService} mit Zustand — AP-08,
 * AUFGERUFEN, nie nachgebaut; das Urteil fällt {@link GrenzNachweisRegel}.
 *
 * <p>Ohne gebundene Anlage gilt an dem Tag keine Grenze (wie {@link AnlageGrenzen}). Zwei Hauptzähler derselben
 * Richtung am selben Tag sind kein Beleg: die Viertelstunden des Tages fehlen. Heute und später sind nicht Teil des
 * Nachweises — eine noch laufende Viertelstunde ist keine Lücke.
 */
@Service
public class GrenzNachweisService {

    public static final String BEZUG = "bezug";
    public static final String EINSPEISUNG = "einspeisung";

    private static final String HAUPTZAEHLER = "Hauptzähler";
    private static final Map<String, String> MESSRICHTUNG = Map.of(BEZUG, "Bezug", EINSPEISUNG, "Abgabe");
    /** 20 Tage × 100 Viertelstunden liegen unter der Zeilenbremse des Werte-Lesers (2 200). */
    private static final int TAGE_JE_LESUNG = 20;

    private final StandortRepository standorte;
    private final NetzanschlussRepository anschluesse;
    private final NetzanschlussGrenzeRepository grenzen;
    private final BilanzStellungen stellungen;
    private final MessstelleWerteService werte;
    private final JdbcTemplate jdbc;
    private volatile Clock uhr = Clock.systemUTC();

    public GrenzNachweisService(StandortRepository standorte, NetzanschlussRepository anschluesse,
            NetzanschlussGrenzeRepository grenzen, BilanzStellungen stellungen, MessstelleWerteService werte,
            JdbcTemplate jdbc) {
        this.standorte = standorte;
        this.anschluesse = anschluesse;
        this.grenzen = grenzen;
        this.stellungen = stellungen;
        this.werte = werte;
        this.jdbc = jdbc;
    }

    /** Nur für Tests: die Uhr, an der „heute“ hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Der Nachweis eines Monats ({@code JJJJ-MM}; ohne: der laufende am Standort). {@code imZugriff} beantwortet, ob die
     * Hauptzähler einer Richtung im Zugriff liegen ({@code RechtPruefung#alleLesbar}); sonst fehlen ihre Zahlen ganz.
     */
    public NetzanschlussDto.GrenzNachweis nachweis(UUID standortId, UUID id, String monatText,
            Predicate<Collection<UUID>> imZugriff) {
        StandortRepository.Standort s = standorte.finde(standortId)
                .orElseThrow(() -> NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        NetzanschlussRepository.Anschluss na = anschluesse.finde(id).filter(a -> a.standortId().equals(s.id()))
                .orElseThrow(() -> NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        ZoneId zone = ZoneId.of(s.zeitzone());
        LocalDate heute = uhr.instant().atZone(zone).toLocalDate();
        YearMonth monat = monat(monatText, heute);
        LocalDate von = monat.atDay(1);
        LocalDate bis = monat.atEndOfMonth().isBefore(heute) ? monat.atEndOfMonth() : heute.minusDays(1);
        List<NetzanschlussDto.GrenzNachweisRichtung> richtungen = new ArrayList<>();
        if (bis.isBefore(von)) {
            for (String r : List.of(BEZUG, EINSPEISUNG)) {
                richtungen.add(richtung(r, GrenzNachweisRegel.ohneAbgeschlossenenTag(), List.of(), List.of(), null,
                        zone));
            }
            return antwort(na, monat, null, null, zone, richtungen);
        }
        List<NetzanschlussRepository.Bindung> bindungen = anschluesse.bindungenDesAnschlusses(na.id());
        List<GrenzeAufloesung.Fassung> fassungen = grenzen.fassungen(na.id()).stream()
                .map(NetzanschlussGrenzeRepository.Zeile::fassung).toList();
        BilanzStellungen.Stand stand = stellungen.lesen();
        Map<UUID, GrenzeAufloesung.Grenzen> anlagen = new HashMap<>();
        Map<LocalDate, GrenzeAufloesung.Wirksam> wirksam = new LinkedHashMap<>();
        Map<LocalDate, UUID> anlageAm = new HashMap<>();
        for (LocalDate tag = von; !tag.isAfter(bis); tag = tag.plusDays(1)) {
            LocalDate t = tag;
            NetzanschlussRepository.Bindung b = bindungen.stream().filter(x -> x.laeuftAm(t)).findFirst().orElse(null);
            GrenzeAufloesung.Grenzen anlage = b == null ? null : anlagen.computeIfAbsent(b.siteId(), this::anlageWerte);
            wirksam.put(tag, GrenzeAufloesung.aufloesen(anlage, b != null, fassungen, tag));
            if (b != null) {
                anlageAm.put(tag, b.siteId());
            }
        }
        for (String r : List.of(BEZUG, EINSPEISUNG)) {
            richtungen.add(richtung(r, wirksam, anlageAm, stand, zone, imZugriff));
        }
        return antwort(na, monat, von, bis, zone, richtungen);
    }

    // ------------------------------------------------------------------------ je Richtung

    private NetzanschlussDto.GrenzNachweisRichtung richtung(String richtung, Map<LocalDate, GrenzeAufloesung.Wirksam> wirksam,
            Map<LocalDate, UUID> anlageAm, BilanzStellungen.Stand stand, ZoneId zone,
            Predicate<Collection<UUID>> imZugriff) {
        Map<LocalDate, BigDecimal> grenzeAm = new LinkedHashMap<>();
        Map<LocalDate, String> quelleAm = new HashMap<>();
        Map<LocalDate, MessstelleRepository.Messstelle> zaehlerAm = new LinkedHashMap<>();
        for (Map.Entry<LocalDate, GrenzeAufloesung.Wirksam> e : wirksam.entrySet()) {
            GrenzeAufloesung.Wirksam w = e.getValue();
            grenzeAm.put(e.getKey(), BEZUG.equals(richtung) ? w.bezugKw() : w.einspeisungKw());
            quelleAm.put(e.getKey(), BEZUG.equals(richtung) ? w.quelleBezug() : w.quelleEinspeisung());
            UUID anlage = anlageAm.get(e.getKey());
            MessstelleRepository.Messstelle m = anlage == null ? null : hauptzaehler(stand, anlage, richtung, e.getKey());
            if (m != null) {
                zaehlerAm.put(e.getKey(), m);
            }
        }
        List<NetzanschlussDto.MessstelleKurz> zaehler = zaehlerAm.values().stream().distinct()
                .map(m -> new NetzanschlussDto.MessstelleKurz(m.id(), m.kennzeichen(), m.name())).toList();
        List<NetzanschlussDto.GrenzAbschnitt> abschnitte = abschnitte(grenzeAm, quelleAm);
        if (!zaehler.isEmpty() && !imZugriff.test(zaehler.stream().map(NetzanschlussDto.MessstelleKurz::id).toList())) {
            boolean geprueft = grenzeAm.entrySet().stream()
                    .anyMatch(e -> e.getValue() != null && zaehlerAm.containsKey(e.getKey()));
            return new NetzanschlussDto.GrenzNachweisRichtung(richtung, geprueft, null, null, abschnitte, List.of(),
                    null, null, null, null, List.of(), augenblick(), RechtPruefung.AUSSERHALB_ZUGRIFF);
        }
        List<Viertelstunde> viertelstunden = new ArrayList<>();
        List<LocalDate> tage = new ArrayList<>(grenzeAm.keySet());
        int i = 0;
        while (i < tage.size()) {
            LocalDate erster = tage.get(i);
            MessstelleRepository.Messstelle m = zaehlerAm.get(erster);
            int j = i;
            while (j + 1 < tage.size() && j + 1 - i < TAGE_JE_LESUNG
                    && Objects.equals(zaehlerAm.get(tage.get(j + 1)), m)) {
                j++;
            }
            LocalDate letzter = tage.get(j);
            if (m == null) {
                for (LocalDate tag = erster; !tag.isAfter(letzter); tag = tag.plusDays(1)) {
                    for (MessstelleWerteRegeln.Schritt sc : schritte(tag, zone)) {
                        viertelstunden.add(new Viertelstunde(sc.von(), sc.bis(), grenzeAm.get(tag), false, null, null));
                    }
                }
            } else {
                MessstelleWerteDto.Werte w = werte.werte(m.kennzeichen(), MessstelleWerteRegeln.Raster.VIERTELSTUNDE.wort(),
                        erster.toString(), letzter.toString(), null);
                boolean leistung = ErgebnisZustand.KW.equals(w.messstelle().einheit());
                for (MessstelleWerteDto.Wert x : w.werte()) {
                    Instant a = OffsetDateTime.parse(x.von()).toInstant();
                    Instant e = OffsetDateTime.parse(x.bis()).toInstant();
                    BigDecimal mittel = leistung ? x.mittel() : ErgebnisZustand.KWH.equals(w.messstelle().einheit())
                            ? GrenzNachweisRegel.mittelAusMenge(x.menge(), a, e) : null;
                    viertelstunden.add(new Viertelstunde(a, e, grenzeAm.get(a.atZone(zone).toLocalDate()), true,
                            x.grund() == null ? x.zustand() : null, GrenzNachweisRegel.kurz(mittel)));
                }
            }
            i = j + 1;
        }
        return richtung(richtung, GrenzNachweisRegel.nachweis(viertelstunden), abschnitte, zaehler, null, zone);
    }

    private static NetzanschlussDto.GrenzNachweisRichtung richtung(String richtung, GrenzNachweisRegel.Urteil u,
            List<NetzanschlussDto.GrenzAbschnitt> abschnitte, List<NetzanschlussDto.MessstelleKurz> zaehler,
            String ausserhalb, ZoneId zone) {
        if (!u.grenzeGeprueft()) {
            return new NetzanschlussDto.GrenzNachweisRichtung(richtung, false, u.grund(), null, abschnitte, zaehler,
                    null, null, null, null, List.of(), augenblick(), ausserhalb);
        }
        GrenzNachweisRegel.Hoechstes h = u.hoechstes();
        return new NetzanschlussDto.GrenzNachweisRichtung(richtung, true, null, u.urteil(), abschnitte, zaehler,
                new NetzanschlussDto.GrenzViertelstunden(u.erwartet(), u.belegt(), u.unvollstaendig(), u.fehlend()),
                u.belegtProzent(),
                h == null ? null : new NetzanschlussDto.GrenzHoechstes(zeit(h.von(), zone), zeit(h.bis(), zone),
                        h.mittelKw(), h.grenzeKw(), GrenzNachweisRegel.kurz(h.abstandKw())),
                new NetzanschlussDto.GrenzDarueber(u.viertelstundenDarueber(), u.minutenDarueber()),
                u.unterbrechungen().stream().map(x -> new NetzanschlussDto.GrenzUnterbrechung(zeit(x.von(), zone),
                        zeit(x.bis(), zone), x.minuten(), x.hoechstwertKw(), x.grenzeKw())).toList(),
                augenblick(), ausserhalb);
    }

    /** M-2 ist heute nicht messbar: je Viertelstunde stehen Mittel, Min und Max, keine Dauer über einer Schwelle. */
    private static NetzanschlussDto.GrenzAugenblick augenblick() {
        return new NetzanschlussDto.GrenzAugenblick(GrenzNachweisRegel.AUGENBLICK_NICHT_GEMESSEN,
                "keine_dauer_unter_der_viertelstunde");
    }

    /** Genau ein Hauptzähler der Richtung an dem Tag in der Anlage; keiner oder mehrere = {@code null}. */
    private static MessstelleRepository.Messstelle hauptzaehler(BilanzStellungen.Stand stand, UUID anlage,
            String richtung, LocalDate tag) {
        List<String> kz = stand.zeilen().stream()
                .filter(z -> HAUPTZAEHLER.equals(z.stellung()) && MESSRICHTUNG.get(richtung).equals(z.richtung())
                        && anlage.toString().equals(z.anlage()) && z.gilt(tag))
                .map(BilanzAbleitung.StellungZeile::messstelle).distinct().toList();
        return kz.size() == 1 ? stand.nachKennzeichen().get(kz.get(0)) : null;
    }

    /** Zusammenhängende Tage mit derselben wirksamen Grenze und Quelle; Tage ohne Grenze fehlen. */
    private static List<NetzanschlussDto.GrenzAbschnitt> abschnitte(Map<LocalDate, BigDecimal> grenzeAm,
            Map<LocalDate, String> quelleAm) {
        List<NetzanschlussDto.GrenzAbschnitt> out = new ArrayList<>();
        LocalDate ab = null;
        LocalDate zuletzt = null;
        BigDecimal kw = null;
        String quelle = null;
        for (Map.Entry<LocalDate, BigDecimal> e : grenzeAm.entrySet()) {
            BigDecimal w = e.getValue();
            String q = quelleAm.get(e.getKey());
            boolean gleich = w != null && kw != null && w.compareTo(kw) == 0 && Objects.equals(q, quelle);
            if (!gleich) {
                if (kw != null) {
                    out.add(new NetzanschlussDto.GrenzAbschnitt(ab, zuletzt, GrenzNachweisRegel.kurz(kw), quelle));
                }
                ab = e.getKey();
                kw = w;
                quelle = q;
            }
            zuletzt = e.getKey();
        }
        if (kw != null) {
            out.add(new NetzanschlussDto.GrenzAbschnitt(ab, zuletzt, GrenzNachweisRegel.kurz(kw), quelle));
        }
        return out;
    }

    // ------------------------------------------------------------------------ Gerüst

    private static NetzanschlussDto.GrenzNachweis antwort(NetzanschlussRepository.Anschluss na, YearMonth monat,
            LocalDate von, LocalDate bis, ZoneId zone, List<NetzanschlussDto.GrenzNachweisRichtung> richtungen) {
        boolean geprueft = richtungen.stream().anyMatch(NetzanschlussDto.GrenzNachweisRichtung::grenzeGeprueft);
        String grund = null;
        if (!geprueft) {
            List<String> gruende = richtungen.stream().map(NetzanschlussDto.GrenzNachweisRichtung::grund).toList();
            grund = gruende.contains(GrenzNachweisRegel.KEIN_ABGESCHLOSSENER_TAG)
                    ? GrenzNachweisRegel.KEIN_ABGESCHLOSSENER_TAG
                    : gruende.contains(GrenzNachweisRegel.KEIN_HAUPTZAEHLER) ? GrenzNachweisRegel.KEIN_HAUPTZAEHLER
                    : GrenzNachweisRegel.KEINE_GRENZE;
        }
        return new NetzanschlussDto.GrenzNachweis(na.id(), na.kennzeichen(), monat.toString(), von, bis, zone.getId(),
                geprueft, grund, gesamt(richtungen), List.copyOf(richtungen));
    }

    /**
     * Das Urteil über beide Richtungen: überschritten vor nicht belegt vor eingehalten; ohne geprüfte Richtung oder
     * mit einer Richtung außerhalb des Zugriffs keines (die verborgene könnte es ändern).
     */
    static String gesamt(List<NetzanschlussDto.GrenzNachweisRichtung> richtungen) {
        if (richtungen.stream().anyMatch(r -> r.ausserhalbZugriff() != null)) {
            return null;
        }
        List<String> u = richtungen.stream().filter(NetzanschlussDto.GrenzNachweisRichtung::grenzeGeprueft)
                .map(NetzanschlussDto.GrenzNachweisRichtung::urteil).toList();
        for (String wort : List.of(GrenzNachweisRegel.UEBERSCHRITTEN, GrenzNachweisRegel.NICHT_BELEGT,
                GrenzNachweisRegel.EINGEHALTEN)) {
            if (u.contains(wort)) {
                return wort;
            }
        }
        return null;
    }

    private GrenzeAufloesung.Grenzen anlageWerte(UUID siteId) {
        return jdbc.query("SELECT s.max_feed_in_kw, c.grid_limit_kw FROM site s "
                        + "LEFT JOIN site_charging_config c ON c.site_id = s.id WHERE s.id = ?",
                (rs, n) -> new GrenzeAufloesung.Grenzen(rs.getBigDecimal(1), rs.getBigDecimal(2)), siteId)
                .stream().findFirst().orElse(new GrenzeAufloesung.Grenzen(null, null));
    }

    private static List<MessstelleWerteRegeln.Schritt> schritte(LocalDate tag, ZoneId zone) {
        MessstelleWerteRegeln.Zeitangabe t = new MessstelleWerteRegeln.Zeitangabe(tag, null);
        return MessstelleWerteRegeln.zeitraum(new MessstelleWerteRegeln.Form(MessstelleWerteRegeln.Raster.VIERTELSTUNDE,
                t, t, null), zone).schritte();
    }

    private static OffsetDateTime zeit(Instant t, ZoneId zone) {
        return t.atZone(zone).toOffsetDateTime();
    }

    private static YearMonth monat(String text, LocalDate heute) {
        if (text == null || text.isBlank()) {
            return YearMonth.from(heute);
        }
        try {
            return YearMonth.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw NetzanschlussAbgelehnt.anfrage("monat");
        }
    }
}
