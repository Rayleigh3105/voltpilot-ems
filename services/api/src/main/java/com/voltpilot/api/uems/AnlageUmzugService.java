package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragAntrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.IntervallMitZustand;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Vorgang;
import com.voltpilot.api.web.dto.AnlageUmzugDto;
import com.voltpilot.api.web.dto.OrtDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Eine bestehende Anlage einem Standort zuordnen oder umziehen — mit „gültig ab" (UEMS AP-02
 * IP-11, Mockup T6, Abnahmefall A11).
 *
 * <h2>Die Kernzusage: kein Regelkreis ändert sich</h2>
 *
 * Eine Zuordnung ist eine Aussage über ZUGEHÖRIGKEIT, kein Eingriff in den Betrieb. Dieser Dienst
 * schreibt genau zwei Tabellen — {@code anlage_standort} (das laufende Intervall endet am Vortag,
 * das neue erbt dessen Ende) und {@code ort_aenderung} — und ruft keinen Publisher, keinen
 * Override, keine Funktion und keinen Fahrplan. Box-Heimat, MQTT-Topics {@code ems/{t}/{Anlage}/…}
 * (sie tragen die Anlage, nie den Standort), Freigaben, Betriebsmodell, Ladepark-Rahmen,
 * Fahrpläne, Messstellen (sie hängen an ihrem Ort, nie an der Anlage), der Netzanschluss und die
 * Teilnahme an „Steuern &amp; Optimieren" bleiben, wie sie sind. {@link #BLEIBT} nennt das als
 * Codes, die Folgen-Karte spricht sie aus, und {@code AnlageUmzugApiTest} beweist es, indem er
 * die ganze Datenbank vorher und nachher vergleicht und jeden Publisher zählt.
 *
 * <h2>Vorschau = Wirkung</h2>
 *
 * {@link #vorschau} und {@link #umziehen} teilen {@link #planen}: dieselbe Regel
 * ({@link OrtsbaumAbleitung#eintrag}, nie nachgebaut), dieselben Fakten, dieselbe Antwortform.
 * Die Vorschau schreibt nichts; der Eintrag liest die Zuordnungen danach frisch.
 *
 * <h2>Protokoll</h2>
 *
 * Je Eintrag ein {@code ort_aenderung}-Eintrag „verschoben" an der ANLAGE, am neuen STANDORT und
 * — wenn es einen gab — am bisherigen STANDORT, jeder mit Urheber und (falls genannt) Begründung.
 * Das ist bewusst mehr als die Regel „ein Eintrag je Schreibvorgang" der Ortsstruktur: die
 * Zuordnung ändert, was an ZWEI Standorten zählt, und jedes Protokoll erzählt seine Seite.
 */
@Service
public class AnlageUmzugService {

    /** Was die Zuordnung nie berührt — Codes in der Reihenfolge der Folgen-Karte. */
    public static final List<String> BLEIBT = List.of("box", "topics", "freigaben", "betriebsmodell",
            "ladepark_rahmen", "fahrplaene", "messstellen");
    /** Höchstlänge der Begründung in Zeichen. */
    static final int BEGRUENDUNG_MAX = 500;

    static final String ART = "verschoben";

    private final JdbcTemplate jdbc;
    private final StandortService standortService;
    private final StandortLesemodellService lesemodell;
    private final AnlageStandortRepository zuordnungen;
    private final UnternehmenRepository unternehmen;
    private final FunktionTeilnahmeRepository teilnahmen;
    private final FunktionRepository funktionen;
    private final OrtProtokoll protokoll;
    private volatile Clock uhr = Clock.systemUTC();

    public AnlageUmzugService(JdbcTemplate jdbc, StandortService standortService,
            StandortLesemodellService lesemodell, AnlageStandortRepository zuordnungen,
            UnternehmenRepository unternehmen, FunktionTeilnahmeRepository teilnahmen,
            FunktionRepository funktionen, OrtProtokoll protokoll) {
        this.jdbc = jdbc;
        this.standortService = standortService;
        this.lesemodell = lesemodell;
        this.zuordnungen = zuordnungen;
        this.unternehmen = unternehmen;
        this.teilnahmen = teilnahmen;
        this.funktionen = funktionen;
        this.protokoll = protokoll;
    }

    /** Nur für Tests: die Uhr, an der „heute" hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** {@code GET …/standort/vorschau}: was der Eintrag bewirken würde — schreibt nichts. */
    @Transactional(readOnly = true)
    public AnlageUmzugDto.Umzug vorschau(UUID siteId, UUID standortId, LocalDate gueltigAb) {
        Plan p = planen(siteId, standortId, gueltigAb);
        List<AnlageUmzugDto.Zuordnung> danach = p.ergebnis().intervalle().stream()
                .map(i -> new AnlageUmzugDto.Zuordnung(ref(p.baum(), i.eltern()), i.ab(), i.bis(),
                        i.zustand().name().toLowerCase(Locale.ROOT)))
                .toList();
        return umzug(p, danach, null, List.of());
    }

    /** {@code PUT …/standort}: die Zuordnung ab „gültig ab" samt Protokoll — in EINER Transaktion. */
    @Transactional
    public AnlageUmzugDto.Umzug umziehen(UUID siteId, AnlageUmzugDto.Anfrage a, ProtokollAkteur wer) {
        String begruendung = begruendung(a.begruendung());
        // Derselbe Riegel wie die Funktionen und die Bestandsübernahme: zwei Umzüge derselben
        // Anlage urteilen nie auf demselben Stand.
        unternehmen.sperren();
        Plan p = planen(siteId, a.standortId(), a.gueltigAb());
        StandortRepository.Standort ziel = p.ziel();
        AnlageStandortRepository.Zuordnung laufend = p.laufend();

        // Erst beenden, dann eintragen — sonst lehnt der Exklusions-Constraint ab.
        if (laufend != null) {
            zuordnungen.beenden(laufend.id(), p.ab().minusDays(1));
        }
        zuordnungen.zuordnen(p.tenant(), siteId, ziel.id(), p.ab(), p.neu().bis(), wer.sub());

        List<AnlageUmzugDto.Eintrag> eintraege = new ArrayList<>();
        StandortRepository.Standort bisher = p.bisher();

        Map<String, Object> altAnlage = null;
        if (laufend != null) {
            altAnlage = standortFelder(bisher, laufend.standortId());
            altAnlage.put("gueltig_ab", laufend.gueltigAb().toString());
            altAnlage.put("gueltig_bis", laufend.gueltigBis() == null ? null : laufend.gueltigBis().toString());
        }
        Map<String, Object> neuAnlage = new LinkedHashMap<>();
        neuAnlage.put("anlage_name", p.anlageName());
        neuAnlage.putAll(standortFelder(ziel, ziel.id()));
        mitGrund(neuAnlage, p.neu().bis(), begruendung);
        eintraege.add(eintragen(p, "anlage", siteId, altAnlage, neuAnlage, p.zone(), wer));

        Map<String, Object> hinzu = new LinkedHashMap<>();
        hinzu.put("anlage_id", siteId);
        hinzu.put("anlage_name", p.anlageName());
        hinzu.put("richtung", "hinzu");
        if (laufend != null) {
            hinzu.put("von_standort_name", bisher == null ? null : bisher.name());
        }
        mitGrund(hinzu, p.neu().bis(), begruendung);
        eintraege.add(eintragen(p, "standort", ziel.id(), null, hinzu, p.zone(), wer));

        if (laufend != null && bisher != null) {
            Map<String, Object> hinaus = new LinkedHashMap<>();
            hinaus.put("anlage_id", siteId);
            hinaus.put("anlage_name", p.anlageName());
            hinaus.put("richtung", "hinaus");
            hinaus.put("nach_standort_name", ziel.name());
            mitGrund(hinaus, p.neu().bis(), begruendung);
            eintraege.add(eintragen(p, "standort", bisher.id(), null, hinaus, ZoneId.of(bisher.zeitzone()), wer));
        }

        List<AnlageUmzugDto.Zuordnung> gelesen = zuordnungen.fuerAnlage(siteId).stream()
                .sorted(Comparator.comparing(AnlageStandortRepository.Zuordnung::gueltigAb)
                        .thenComparing(z -> !z.aufgehoben()))
                .map(z -> new AnlageUmzugDto.Zuordnung(ref(p.baum(), z.standortId()), z.gueltigAb(), z.gueltigBis(),
                        OrtsbaumAbleitung.zuordnungZustand(new Intervall(z.gueltigAb(), z.gueltigBis(), null,
                                z.aufgehoben()), p.heute()).name().toLowerCase(Locale.ROOT)))
                .toList();
        return umzug(p, gelesen, begruendung, eintraege);
    }

    // ------------------------------------------------------------------ Urteil

    /** Der Stand, auf dem geurteilt wird, und das Urteil — die EINE Stelle für Vorschau und Eintrag. */
    private record Plan(UUID tenant, UUID siteId, String anlageName, StandortService.Baum baum,
            StandortRepository.Standort ziel, StandortRepository.Standort bisher,
            AnlageStandortRepository.Zuordnung laufend, EintragErgebnis ergebnis, IntervallMitZustand neu,
            LocalDate ab, LocalDate heute, ZoneId zone, Instant jetzt) {}

    private Plan planen(UUID siteId, UUID standortId, LocalDate gueltigAb) {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw OrtAbgelehnt.nichtGefunden("Kein Kundenbereich gewählt.");
        }
        List<String> namen = jdbc.queryForList("SELECT name FROM site WHERE id = ?", String.class, siteId);
        if (namen.isEmpty()) {
            throw OrtAbgelehnt.nichtGefunden("Diese Anlage gibt es nicht.");
        }
        if (standortId == null) {
            throw OrtAbgelehnt.anfrage("standortId", "Bitte wählen Sie einen Standort.");
        }
        StandortService.Baum b = standortService.baum(List.of());
        StandortRepository.Standort ziel = b.zeilen().standorte().stream()
                .filter(s -> s.id().equals(standortId)).findFirst()
                .orElseThrow(() -> OrtAbgelehnt.anfrage("standortId", "Diesen Standort gibt es nicht."));
        String anlage = siteId.toString();
        if (b.baum().anlagen().stream().noneMatch(x -> x.kennzeichen().equals(anlage))) {
            throw OrtAbgelehnt.nichtGefunden("Diese Anlage gibt es nicht.");
        }

        ZoneId zone = ZoneId.of(ziel.zeitzone());
        Instant jetzt = uhr.instant();
        LocalDate heute = jetzt.atZone(zone).toLocalDate();
        LocalDate ab = gueltigAb == null ? heute : gueltigAb;
        EintragErgebnis e = OrtsbaumAbleitung.eintrag(b.baum(),
                new EintragAntrag(anlage, Vorgang.VERSCHIEBEN, ab, ziel.kurzzeichen(), heute));
        if (!e.erlaubt()) {
            throw abgelehnt(e);
        }
        IntervallMitZustand neu = e.intervalle().stream()
                .filter(i -> !i.aufgehoben() && i.ab().equals(ab) && ziel.kurzzeichen().equals(i.eltern()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("Eintrag ohne neues Intervall"));
        AnlageStandortRepository.Zuordnung laufend = zuordnungen.fuerAnlage(siteId).stream()
                .filter(z -> !z.aufgehoben() && !z.gueltigAb().isAfter(ab)
                        && (z.gueltigBis() == null || !z.gueltigBis().isBefore(ab)))
                .findFirst().orElse(null);
        if (laufend != null ? !Objects.equals(laufend.gueltigBis(), neu.bis()) : neu.bis() != null) {
            throw new IllegalStateException("Lesemodell und Zuordnungen weichen voneinander ab: " + siteId);
        }
        StandortRepository.Standort bisher = laufend == null ? null : standort(b, laufend.standortId());
        return new Plan(tenant, siteId, namen.get(0), b, ziel, bisher, laufend, e, neu, ab, heute, zone, jetzt);
    }

    /** Die Gründe des Vertrags mit seinem Satz; das Feld sagt dem Dialog, wohin der Satz gehört. */
    private static OrtAbgelehnt abgelehnt(EintragErgebnis e) {
        OrtAbgelehnt.Grund g = switch (e.grund()) {
            case VOR_DEM_ERSTEN_INTERVALL -> OrtAbgelehnt.Grund.VOR_DEM_ERSTEN_INTERVALL;
            case OBJEKT_ARCHIVIERT -> OrtAbgelehnt.Grund.OBJEKT_ARCHIVIERT;
            case GLEICHER_TAG -> OrtAbgelehnt.Grund.GLEICHER_TAG;
            case ZIEL_IST_BISHERIGER_ELTERN -> OrtAbgelehnt.Grund.ZIEL_IST_BISHERIGER_ELTERN;
            case ZIEL_GAB_ES_NOCH_NICHT -> OrtAbgelehnt.Grund.ZIEL_GAB_ES_NOCH_NICHT;
            case ZIEL_ARCHIVIERT -> OrtAbgelehnt.Grund.ZIEL_ARCHIVIERT;
            // Das Ziel ist immer ein Standort, und VERSCHIEBEN ist keine Korrektur.
            case ZIEL_ART_UNZULAESSIG, KEIN_BEGINN_AN_DEM_TAG ->
                    throw new IllegalStateException("beim Zuordnen einer Anlage unmöglich: " + e.grund());
        };
        String feld = switch (g) {
            case ZIEL_IST_BISHERIGER_ELTERN, ZIEL_ARCHIVIERT -> "standortId";
            default -> "gueltigAb";
        };
        return OrtAbgelehnt.von(g, e.text(), Map.of("feld", feld));
    }

    private static String begruendung(String roh) {
        if (roh == null || roh.isBlank()) {
            return null;
        }
        String b = roh.strip();
        if (b.codePointCount(0, b.length()) > BEGRUENDUNG_MAX) {
            throw OrtAbgelehnt.anfrage("begruendung",
                    "Die Begründung darf höchstens " + BEGRUENDUNG_MAX + " Zeichen lang sein.");
        }
        return b;
    }

    // ------------------------------------------------------------------ Antwort

    private AnlageUmzugDto.Umzug umzug(Plan p, List<AnlageUmzugDto.Zuordnung> zuordnungenDanach,
            String begruendung, List<AnlageUmzugDto.Eintrag> eintraege) {
        IntervallMitZustand neu = p.neu();
        AnlageUmzugDto.StandortRef danach = neu.bis() == null ? null : p.ergebnis().intervalle().stream()
                .filter(i -> !i.aufgehoben() && i.ab().equals(neu.bis().plusDays(1)))
                .findFirst().map(i -> ref(p.baum(), i.eltern())).orElse(null);
        RueckwirkungErgebnis r = OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(
                OffsetDateTime.ofInstant(p.jetzt(), p.zone()), p.ab(), neu.bis(), p.zone(), null));

        int boxen = zahl("SELECT count(*) FROM device WHERE site_id = ? AND ausgebaut_am IS NULL", p.siteId());
        boolean ladepark = zahl("SELECT (SELECT count(*) FROM site_charging_config WHERE site_id = ?) "
                + "+ (SELECT count(*) FROM site_charge_point_allowlist WHERE site_id = ?)", p.siteId(), p.siteId()) > 0;
        List<String> bleibt = BLEIBT.stream()
                .filter(c -> !"box".equals(c) || boxen > 0)
                .filter(c -> !"ladepark_rahmen".equals(c) || ladepark)
                .toList();

        return new AnlageUmzugDto.Umzug(p.siteId(), p.anlageName(),
                p.bisher() == null ? null : ref(p.bisher()), ref(p.ziel()), p.ab(), neu.bis(), danach,
                new OrtDto.Rueckwirkung(r.art().name().toLowerCase(Locale.ROOT), r.tage(), r.abzeichen()),
                zuordnungenDanach, bleibt, boxen, netzanschluss(p), teilnahme(p), 0, begruendung,
                List.copyOf(eintraege));
    }

    /** Der Netzanschluss, an dem die Anlage am „gültig ab" hängt — gelesen wie im Standort-Lesemodell. */
    private AnlageUmzugDto.Netzanschluss netzanschluss(Plan p) {
        if (p.bisher() == null) {
            return null;
        }
        return lesemodell.standort(p.bisher().id(), p.ab()).stream()
                .flatMap(s -> s.anlagen().stream())
                .filter(x -> x.id().equals(p.siteId()) && x.netzanschluss() != null)
                .findFirst()
                .map(x -> new AnlageUmzugDto.Netzanschluss(x.netzanschluss().id(), x.netzanschluss().kennzeichen()))
                .orElse(null);
    }

    /** Die laufende Teilnahme an „Steuern &amp; Optimieren" mit dem Standort ihrer Funktion. */
    private AnlageUmzugDto.Teilnahme teilnahme(Plan p) {
        return teilnahmen.laufendeDerAnlage(p.siteId())
                .flatMap(t -> funktionen.finde(t.funktionId())
                        .map(f -> new AnlageUmzugDto.Teilnahme(f.funktion().code(), t.zustand().code(),
                                ref(p.baum(), f.standortId()))))
                .orElse(null);
    }

    private int zahl(String sql, Object... args) {
        Integer n = jdbc.queryForObject(sql, Integer.class, args);
        return n == null ? 0 : n;
    }

    private AnlageUmzugDto.Eintrag eintragen(Plan p, String objektArt, UUID objektId, Map<String, Object> alt,
            Map<String, Object> neu, ZoneId zone, ProtokollAkteur wer) {
        long id = protokoll.eintragen(p.tenant(), objektArt, objektId, ART, alt, neu, p.ab(), zone, p.jetzt(), wer);
        return new AnlageUmzugDto.Eintrag(id, objektArt, objektId);
    }

    private static Map<String, Object> standortFelder(StandortRepository.Standort s, UUID id) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("standort_id", id);
        m.put("standort_kurzzeichen", s == null ? null : s.kurzzeichen());
        m.put("standort_name", s == null ? null : s.name());
        return m;
    }

    private static void mitGrund(Map<String, Object> m, LocalDate bis, String begruendung) {
        if (bis != null) {
            m.put("gueltig_bis", bis.toString());
        }
        if (begruendung != null) {
            m.put("begruendung", begruendung);
        }
    }

    private static StandortRepository.Standort standort(StandortService.Baum b, UUID id) {
        return b.zeilen().standorte().stream().filter(s -> s.id().equals(id)).findFirst().orElse(null);
    }

    private static AnlageUmzugDto.StandortRef ref(StandortRepository.Standort s) {
        return new AnlageUmzugDto.StandortRef(s.id(), s.kurzzeichen(), s.name());
    }

    private static AnlageUmzugDto.StandortRef ref(StandortService.Baum b, UUID id) {
        StandortRepository.Standort s = standort(b, id);
        return s == null ? new AnlageUmzugDto.StandortRef(id, null, null) : ref(s);
    }

    /** Die Eltern im Baum sind Kurzzeichen (StandortService schlüsselt um). */
    private static AnlageUmzugDto.StandortRef ref(StandortService.Baum b, String kurzzeichen) {
        UUID id = b.standorte().get(kurzzeichen);
        return id != null ? ref(b, id) : ref(b, UUID.fromString(kurzzeichen));
    }
}
