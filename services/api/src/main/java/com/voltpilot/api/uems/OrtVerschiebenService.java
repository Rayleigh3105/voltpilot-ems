package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragAntrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragGrund;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Folgen;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FolgenErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.IntervallMitZustand;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtArt;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.StandAm;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Vorgang;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import com.voltpilot.api.web.dto.OrtDto;
import com.voltpilot.api.web.dto.OrtVerschiebungDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Ein Gebäude oder einen Bereich verschieben — mit „gültig ab" (UEMS AP-02 IP-12, Mockups V1–V4,
 * Abnahmefälle A1, A2, A13).
 *
 * <h2>Die Kernzusage (A13): nichts Elektrisches und nichts direkt am Standort Hängendes zieht mit</h2>
 *
 * Verschieben ist eine Aussage über den ORT, nicht über die Elektrik. Dieser Dienst schreibt genau
 * zwei Tabellen — {@code ort_zuordnung} (das laufende Intervall des Orts endet am Vortag, das neue
 * erbt dessen Ende) und {@code ort_aenderung} (GENAU EIN Eintrag am Ort, Regel 14). Bereiche hängen
 * weiter an ihrem Gebäude und ziehen darum mit; Messstellen hängen weiter an ihrem Ort — ihr
 * Standort ändert sich nur ABGELEITET über den Baum (Regel 7). Anlagen, ihre Netzanschlüsse und
 * eine Messstelle, die direkt am Standort hängt, bleiben, wo sie sind (E11); die Folgen-Karte
 * nennt sie mit dem Weg. Keine Box, kein Topic, kein Sender, keine Funktion, kein Fahrplan —
 * {@code OrtVerschiebenApiTest} zählt jeden MQTT-Sender und vergleicht die ganze Datenbank.
 *
 * <h2>Vorschau = Wirkung</h2>
 *
 * {@link #vorschau} und {@link #verschieben} teilen {@link #planen}: dieselben Regeln
 * ({@link OrtsbaumAbleitung#eintrag}, {@link OrtsbaumAbleitung#verschiebenFolgen},
 * {@link OrtsbaumAbleitung#nameBelegt} — aufgerufen, nie nachgebaut), dieselben Fakten, dieselbe
 * Antwortform. Die Vorschau schreibt nichts und lehnt ab wie der Eintrag; der Eintrag liest seine
 * Zuordnungen und seinen Protokolleintrag danach frisch.
 */
@Service
public class OrtVerschiebenService {

    static final int BEGRUENDUNG_MAX = 500;
    static final String ART = "verschoben";

    private final JdbcTemplate jdbc;
    private final StandortLesemodellService lesemodell;
    private final ObjectProvider<OrtsbaumMessstellen> messstellen;
    private final OrtZuordnungRepository zuordnungen;
    private final OrtAenderungRepository aenderungen;
    private final UnternehmenRepository unternehmen;
    private final OrtProtokoll protokoll;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();

    public OrtVerschiebenService(JdbcTemplate jdbc, StandortLesemodellService lesemodell,
            ObjectProvider<OrtsbaumMessstellen> messstellen, OrtZuordnungRepository zuordnungen,
            OrtAenderungRepository aenderungen, UnternehmenRepository unternehmen, OrtProtokoll protokoll,
            ObjectMapper json) {
        this.jdbc = jdbc;
        this.lesemodell = lesemodell;
        this.messstellen = messstellen;
        this.zuordnungen = zuordnungen;
        this.aenderungen = aenderungen;
        this.unternehmen = unternehmen;
        this.protokoll = protokoll;
        this.json = json;
    }

    /** Nur für Tests: die Uhr, an der „heute" hängt (A1: „am 20.02.2027 eingetragen"). */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** {@code GET …/verschieben/vorschau}: was der Eintrag bewirken würde — schreibt nichts. */
    @Transactional(readOnly = true)
    public OrtVerschiebungDto.Verschiebung vorschau(UUID ortId, UUID zielId, LocalDate gueltigAb) {
        Plan p = planen(ortId, zielId, gueltigAb);
        List<OrtVerschiebungDto.Zuordnung> danach = p.eintrag().intervalle().stream()
                .map(i -> new OrtVerschiebungDto.Zuordnung(knoten(p.baum(), i.eltern()), i.ab(), i.bis(),
                        i.zustand().name().toLowerCase(Locale.ROOT)))
                .toList();
        return antwort(p, danach, null, List.of());
    }

    /** {@code POST …/verschieben}: die Zuordnung ab „gültig ab" samt Protokoll — in EINER Transaktion. */
    @Transactional
    public OrtVerschiebungDto.Verschiebung verschieben(UUID ortId, OrtVerschiebungDto.Anfrage a,
            ProtokollAkteur wer) {
        String begruendung = begruendung(a.begruendung());
        // Derselbe Riegel wie jeder Schreibweg der Ortsstruktur: zwei Vorgänge urteilen nie auf demselben Stand.
        unternehmen.sperren();
        Plan p = planen(ortId, a.zielId(), a.gueltigAb());
        OrtZuordnungRepository.Zuordnung laufend = p.laufend();

        // Erst beenden, dann eintragen — sonst lehnt der Exklusions-Constraint ab.
        zuordnungen.beenden(laufend.id(), p.ab().minusDays(1));
        zuordnungen.zuordnen(p.tenant(), ortId, p.zielStandortId(), p.zielOrtId(), p.ab(), p.neu().bis(), wer.sub());

        Map<String, Object> alt = new LinkedHashMap<>();
        elternFelder(alt, p.bisher(), p.bisherStandort());
        alt.put("gueltig_ab", laufend.gueltigAb().toString());
        alt.put("gueltig_bis", laufend.gueltigBis() == null ? null : laufend.gueltigBis().toString());
        Map<String, Object> neu = new LinkedHashMap<>();
        elternFelder(neu, p.ziel(), p.zielStandort());
        if (p.neu().bis() != null) {
            neu.put("gueltig_bis", p.neu().bis().toString());
        }
        if (begruendung != null) {
            neu.put("begruendung", begruendung);
        }
        long id = protokoll.eintragen(p.tenant(), p.ort().art(), ortId, ART, alt, neu, p.ab(), p.zone(), p.jetzt(),
                wer);

        List<OrtVerschiebungDto.Zuordnung> gelesen = zuordnungen.fuerOrt(ortId).stream()
                .sorted(Comparator.comparing(OrtZuordnungRepository.Zuordnung::gueltigAb)
                        .thenComparing(z -> !z.aufgehoben()))
                .map(z -> new OrtVerschiebungDto.Zuordnung(knoten(p.zeilen(), z.eltern()), z.gueltigAb(),
                        z.gueltigBis(), OrtsbaumAbleitung.zuordnungZustand(new Intervall(z.gueltigAb(),
                                z.gueltigBis(), null, z.aufgehoben()), p.heute()).name().toLowerCase(Locale.ROOT)))
                .toList();
        return antwort(p, gelesen, begruendung, List.of(eintrag(p, id)));
    }

    // ------------------------------------------------------------------ Urteil

    /** Der Stand, auf dem geurteilt wird, und das Urteil — die EINE Stelle für Vorschau und Eintrag. */
    private record Plan(UUID tenant, Zeilen zeilen, StandortService.Baum baum, OrtRepository.Ort ort,
            UUID zielStandortId, UUID zielOrtId, String zielKz, OrtZuordnungRepository.Zuordnung laufend,
            EintragErgebnis eintrag, IntervallMitZustand neu, Folgen folgen, StandAm stand,
            OrtVerschiebungDto.Knoten bisher, OrtVerschiebungDto.Knoten bisherStandort,
            OrtVerschiebungDto.Knoten ziel, OrtVerschiebungDto.Knoten zielStandort,
            LocalDate ab, LocalDate heute, ZoneId zone, Instant jetzt) {}

    private Plan planen(UUID ortId, UUID zielId, LocalDate gueltigAb) {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw OrtAbgelehnt.nichtGefunden("Kein Kundenbereich gewählt.");
        }
        Zeilen z = lesemodell.zeilen();
        OrtRepository.Ort o = z.orte().stream().filter(x -> x.id().equals(ortId)).findFirst()
                .orElseThrow(() -> OrtAbgelehnt.nichtGefunden("Diesen Ort gibt es nicht."));
        if (zielId == null) {
            throw OrtAbgelehnt.anfrage("zielId", "Bitte wählen Sie, wohin " + o.name() + " ziehen soll.");
        }
        UUID zielStandortId = null;
        UUID zielOrtId = null;
        String zielKz;
        StandortRepository.Standort zielStandort = z.standorte().stream()
                .filter(s -> s.id().equals(zielId)).findFirst().orElse(null);
        if (zielStandort != null) {
            zielStandortId = zielId;
            zielKz = zielStandort.kurzzeichen();
        } else {
            OrtRepository.Ort zielOrt = z.orte().stream().filter(x -> x.id().equals(zielId)).findFirst()
                    .orElseThrow(() -> OrtAbgelehnt.anfrage("zielId", "Dieses Ziel gibt es nicht."));
            zielOrtId = zielId;
            zielKz = zielOrt.kurzzeichen();
        }

        // Derselbe Baum wie Archivieren und die Messstellen-Zuordnung: Orte nach Kurzzeichen, mit Messstellen.
        StandortService.Baum b = StandortService.baum(z,
                messstellen.getIfAvailable(OrtsbaumMessstellen.Keine::new).messstellen());
        Instant jetzt = uhr.instant();
        ZoneId zone = OrtService.lage(z, StandortLesemodell.baum(z), ortId, jetzt).zone();
        LocalDate heute = jetzt.atZone(zone).toLocalDate();
        LocalDate ab = gueltigAb == null ? heute : gueltigAb;

        EintragAntrag antrag = new EintragAntrag(o.kurzzeichen(), Vorgang.VERSCHIEBEN, ab, zielKz, heute);
        FolgenErgebnis f = OrtsbaumAbleitung.verschiebenFolgen(b.baum(), antrag);
        if (!f.erlaubt()) {
            throw abgelehnt(f.grund(), f.text());
        }
        EintragErgebnis e = OrtsbaumAbleitung.eintrag(b.baum(), antrag);
        IntervallMitZustand neu = e.intervalle().stream()
                .filter(i -> !i.aufgehoben() && i.ab().equals(ab) && zielKz.equals(i.eltern()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("Eintrag ohne neues Intervall"));
        OrtZuordnungRepository.Zuordnung laufend = z.ortZuordnungen().stream()
                .filter(iv -> iv.ortId().equals(ortId) && !iv.aufgehoben() && !iv.gueltigAb().isAfter(ab)
                        && (iv.gueltigBis() == null || !iv.gueltigBis().isBefore(ab)))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("Verschieben ohne laufende Zuordnung: " + ortId));
        if (!Objects.equals(laufend.gueltigBis(), neu.bis())) {
            throw new IllegalStateException("Lesemodell und Zuordnungen weichen voneinander ab: " + ortId);
        }
        // Regel 13: unter den neuen Geschwistern ist der Name frei — am ersten Tag und heute (wie beim Anlegen).
        OrtService.nameFrei(z, StandortLesemodell.baum(z), OrtArt.valueOf(o.art().toUpperCase(Locale.ROOT)),
                zielId.toString(), o.name(), ab, heute, ortId.toString());

        StandAm stand = OrtsbaumAbleitung.standAm(b.baum(), ab);
        OrtVerschiebungDto.Knoten ziel = knoten(b, zielKz);
        return new Plan(tenant, z, b, o, zielStandortId, zielOrtId, zielKz, laufend, e, neu, f.folgen(), stand,
                knoten(z, laufend.eltern()), knoten(b, standortAm(stand, o.kurzzeichen())), ziel,
                zielStandortId != null ? ziel : knoten(b, standortAm(stand, zielKz)), ab, heute, zone, jetzt);
    }

    /** Die Gründe des Vertrags mit seinem Satz; das Feld sagt dem Dialog, wohin der Satz gehört. */
    private static OrtAbgelehnt abgelehnt(EintragGrund grund, String satz) {
        OrtAbgelehnt.Grund g = switch (grund) {
            case ZIEL_ART_UNZULAESSIG -> OrtAbgelehnt.Grund.ZIEL_ART_UNZULAESSIG;
            case VOR_DEM_ERSTEN_INTERVALL -> OrtAbgelehnt.Grund.VOR_DEM_ERSTEN_INTERVALL;
            case OBJEKT_ARCHIVIERT -> OrtAbgelehnt.Grund.OBJEKT_ARCHIVIERT;
            case GLEICHER_TAG -> OrtAbgelehnt.Grund.GLEICHER_TAG;
            case ZIEL_IST_BISHERIGER_ELTERN -> OrtAbgelehnt.Grund.ZIEL_IST_BISHERIGER_ELTERN;
            case ZIEL_GAB_ES_NOCH_NICHT -> OrtAbgelehnt.Grund.ZIEL_GAB_ES_NOCH_NICHT;
            case ZIEL_ARCHIVIERT -> OrtAbgelehnt.Grund.ZIEL_ARCHIVIERT;
            // VERSCHIEBEN ist keine Korrektur.
            case KEIN_BEGINN_AN_DEM_TAG -> throw new IllegalStateException("beim Verschieben unmöglich: " + grund);
        };
        String feld = switch (g) {
            case ZIEL_ART_UNZULAESSIG, ZIEL_IST_BISHERIGER_ELTERN, ZIEL_ARCHIVIERT -> "zielId";
            default -> "gueltigAb";
        };
        return OrtAbgelehnt.von(g, satz, Map.of("feld", feld));
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

    private OrtVerschiebungDto.Verschiebung antwort(Plan p, List<OrtVerschiebungDto.Zuordnung> zuordnungenDanach,
            String begruendung, List<OrtVerschiebungDto.Eintrag> eintraege) {
        IntervallMitZustand neu = p.neu();
        OrtVerschiebungDto.Knoten danach = neu.bis() == null ? null : p.eintrag().intervalle().stream()
                .filter(i -> !i.aufgehoben() && i.ab().equals(neu.bis().plusDays(1)))
                .findFirst().map(i -> knoten(p.baum(), i.eltern())).orElse(null);
        RueckwirkungErgebnis r = OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(
                OffsetDateTime.ofInstant(p.jetzt(), p.zone()), p.ab(), neu.bis(), p.zone(), null));
        OrtVerschiebungDto.Zeitraum betroffen = r.rueckwirkendBetroffen() == null ? null
                : new OrtVerschiebungDto.Zeitraum(r.rueckwirkendBetroffen().von(), r.rueckwirkendBetroffen().bis());
        return new OrtVerschiebungDto.Verschiebung(p.ort().id(), p.ort().art(), p.ort().kurzzeichen(), p.ort().name(),
                p.bisher(), p.bisherStandort(), p.ziel(), p.zielStandort(), p.ab(), neu.bis(), danach,
                new OrtDto.Rueckwirkung(r.art().name().toLowerCase(Locale.ROOT), r.tage(), r.abzeichen()), betroffen,
                zuordnungenDanach, folgen(p), 0, begruendung, List.copyOf(eintraege));
    }

    /** Das Urteil des Vertrags in seiner Reihenfolge — hier kommen nur IDs, Namen und Orte dazu. */
    private OrtVerschiebungDto.Folgen folgen(Plan p) {
        Folgen f = p.folgen();
        StandortService.Baum b = p.baum();
        Map<String, UUID> msIds = new HashMap<>();
        if (!f.messstellenWechselnStandort().isEmpty() || !f.bleibenMessstellen().isEmpty()) {
            jdbc.query("SELECT kennzeichen, id FROM messstelle",
                    rs -> {
                        msIds.put(rs.getString("kennzeichen"), rs.getObject("id", UUID.class));
                    });
        }
        Map<String, OrtsbaumAbleitung.Messstelle> ms = new HashMap<>();
        b.baum().messstellen().forEach(m -> ms.put(m.kennzeichen(), m));
        Map<String, OrtsbaumAbleitung.Anlage> an = new HashMap<>();
        b.baum().anlagen().forEach(a -> an.put(a.kennzeichen(), a));
        Set<String> bleibend = Set.copyOf(f.bleibenAnlagen());

        List<OrtVerschiebungDto.Knoten> ziehenMit = f.ziehenMit().stream().map(kz -> knoten(b, kz)).toList();
        List<OrtVerschiebungDto.Messstelle> wechseln = f.messstellenWechselnStandort().stream()
                .map(kz -> messstelle(p, ms.get(kz), msIds.get(kz))).toList();
        List<OrtVerschiebungDto.Anlage> anlagen = f.bleibenAnlagen().stream()
                .map(kz -> new OrtVerschiebungDto.Anlage(UUID.fromString(kz), an.get(kz).name(),
                        knoten(b, p.stand().anlagen().stream().filter(x -> x.kennzeichen().equals(kz))
                                .map(OrtsbaumAbleitung.AnlageAmStichtag::standort).findFirst().orElse(null))))
                .toList();
        List<OrtVerschiebungDto.Netzanschluss> netz = f.bleibenNetzanschluesse().stream()
                .map(kz -> new OrtVerschiebungDto.Netzanschluss(p.zeilen().netzanschluesse().stream()
                        .filter(x -> x.kennzeichen().equals(kz) && bleibend.contains(x.siteId().toString()))
                        .sorted(Comparator.comparing((StandortLesemodell.NetzanschlussBindung x) -> !x.laeuftAm(p.ab())))
                        .map(StandortLesemodell.NetzanschlussBindung::netzanschlussId)
                        .findFirst().orElse(null), kz))
                .toList();
        List<OrtVerschiebungDto.Messstelle> bleiben = f.bleibenMessstellen().stream()
                .map(kz -> messstelle(p, ms.get(kz), msIds.get(kz))).toList();
        return new OrtVerschiebungDto.Folgen(ziehenMit, wechseln, anlagen, netz, bleiben);
    }

    private static OrtVerschiebungDto.Messstelle messstelle(Plan p, OrtsbaumAbleitung.Messstelle m, UUID id) {
        String ort = OrtsbaumAbleitung.verortung(p.baum().baum(), m.kennzeichen(), p.ab()).ort();
        return new OrtVerschiebungDto.Messstelle(id, m.kennzeichen(), m.name(), knoten(p.baum(), ort));
    }

    /** Der geschriebene Eintrag, frisch gelesen: Zeit · was (der Kundensatz) · gilt ab · wer (V4). */
    private OrtVerschiebungDto.Eintrag eintrag(Plan p, long id) {
        OrtAenderungRepository.Eintrag e = aenderungen.fuerObjekt(p.ort().art(), p.ort().id()).stream()
                .filter(x -> x.id() == id).findFirst()
                .orElseThrow(() -> new IllegalStateException("Protokolleintrag fehlt: " + id));
        return new OrtVerschiebungDto.Eintrag(e.id(), e.objektArt(), e.objektId(),
                AenderungSatz.satz(e.objektArt(), e.art(), knotenJson(e.altJson()), knotenJson(e.neuJson()), null),
                e.giltAb(), e.rueckwirkend(), e.akteurName(), e.createdAt().atZone(p.zone()).toOffsetDateTime());
    }

    private JsonNode knotenJson(String roh) {
        if (roh == null) {
            return null;
        }
        try {
            return json.readTree(roh);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Protokolleintrag nicht lesbar", ex);
        }
    }

    private static void elternFelder(Map<String, Object> m, OrtVerschiebungDto.Knoten eltern,
            OrtVerschiebungDto.Knoten standort) {
        m.put("eltern_id", eltern.id());
        m.put("eltern_art", eltern.art());
        m.put("eltern_kurzzeichen", eltern.kurzzeichen());
        m.put("eltern_name", eltern.name());
        m.put("standort_id", standort == null ? null : standort.id());
        m.put("standort_name", standort == null ? null : standort.name());
    }

    private static String standortAm(StandAm stand, String kz) {
        return stand.orte().stream().filter(o -> o.kennzeichen().equals(kz))
                .map(OrtsbaumAbleitung.OrtAmStichtag::standort).findFirst().orElse(null);
    }

    /** Ein Knoten aus dem Kurzzeichen-Baum; {@code U} ist das Unternehmen. */
    private static OrtVerschiebungDto.Knoten knoten(StandortService.Baum b, String kz) {
        if (kz == null) {
            return null;
        }
        UUID standort = b.standorte().get(kz);
        if (standort != null) {
            return knoten(b.zeilen(), standort);
        }
        OrtRepository.Ort o = b.ort(kz);
        if (o != null) {
            return new OrtVerschiebungDto.Knoten(o.id(), o.art(), o.kurzzeichen(), o.name());
        }
        if (OrtsbaumAbleitung.UNTERNEHMEN.equals(kz)) {
            UnternehmenRepository.Unternehmen u = b.zeilen().unternehmen();
            return new OrtVerschiebungDto.Knoten(u == null ? null : u.id(), "unternehmen", null,
                    u == null ? null : u.name());
        }
        return new OrtVerschiebungDto.Knoten(null, null, kz, null);
    }

    /** Ein Knoten aus seiner ID (Standort oder Ort). */
    private static OrtVerschiebungDto.Knoten knoten(Zeilen z, UUID id) {
        for (StandortRepository.Standort s : z.standorte()) {
            if (s.id().equals(id)) {
                return new OrtVerschiebungDto.Knoten(s.id(), "standort", s.kurzzeichen(), s.name());
            }
        }
        for (OrtRepository.Ort o : z.orte()) {
            if (o.id().equals(id)) {
                return new OrtVerschiebungDto.Knoten(o.id(), o.art(), o.kurzzeichen(), o.name());
            }
        }
        return new OrtVerschiebungDto.Knoten(id, null, null, null);
    }
}
