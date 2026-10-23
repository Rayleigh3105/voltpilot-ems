package com.voltpilot.api.erzeuger;

import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Jungster;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Stammdaten;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Steuerung;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Wechselzeile;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GeraetRepository.Teil;
import com.voltpilot.api.web.dto.ErzeugerJetztDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS EZ-23: das Erzeuger-Cockpit aus EZ-8 (Konzept vp-erzeuger-wago-konzept §4.5) bekommt seine Route. EZ-8 hat nur
 * das Portal gebaut; ohne {@code GET …/erzeuger/jetzt} las es 404 als „älteres Backend“ und blieb wie ohne Steuerung.
 *
 * <p><b>Werte</b> aus derselben Quelle wie die Werte-Fläche der Steuerung ({@link AnlagensteuerungService#werte},
 * EZ-10): der jüngste Wert je Punkt über {@link AnlagensteuerungRepository#juengste}, als Zahl in der Einheit des
 * Katalogs, die Qualität unverändert; mit {@code invalid} oder {@code device_error} ist {@code wert} null. Das
 * Typ-Maximum („ungültig“) kommt nie an — der Leser der Box verwirft es ({@code measurement-driver.js}); dann altert
 * die letzte Lesung, eine Zahl wird nie erfunden.
 *
 * <p><b>Punktnamen.</b> Das Portal liest eigene Namen ({@code ERZEUGER_PUNKT} und {@code einheitPunkt} in
 * {@code erzeuger.ts}: Abschnitt ausgeschrieben, Feld ohne Kürzel), der Katalog speichert die Felder der Vorlage
 * ({@code erzeuger.a.p_nvp_w}, {@code erzeuger.te[2].t_p_ist_w}). {@link #PUNKTE} und {@link #EINHEIT_FELDER} sind
 * die Übersetzung; {@code ErzeugerJetztVertragTest} hält sie gegen {@code erzeuger.ts} und die Fixtures des Portals.
 *
 * <p><b>Heute</b> ({@link #WECHSEL}, für die Tagesleiste): die Zustandswechsel seit Mitternacht (Europe/Berlin), der
 * erste Eintrag ist der Wert um Mitternacht. Schweigt ein Punkt länger als {@link AnlagensteuerungService#AKTUELL_BIS_S}
 * (zwei Herzschläge, dieselbe Grenze wie „aktuell“), gilt er ab da als unbekannt (null) — eine Vorgabe wird nie über
 * eine Lücke verlängert.
 *
 * <p>Mehrere Steuerungen an einer Anlage: das Cockpit zeigt die zuerst eingebaute (dieselbe Reihenfolge wie
 * {@link AnlagensteuerungService#liste}).
 */
@Service
public class ErzeugerJetztService {

    static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    /** Portalname → Katalogschlüssel der festen Abschnitte, in der Reihenfolge von {@code ERZEUGER_PUNKT}. */
    static final Map<String, String> PUNKTE = paare(
            "erzeuger.kopf.anlagenart", "erzeuger.kopf.anlagenart",
            "erzeuger.kopf.te_anzahl", "erzeuger.kopf.te_anzahl",
            "erzeuger.anlage.gueltig", "erzeuger.a.a_gueltig",
            "erzeuger.anlage.alter_s", "erzeuger.a.a_alter_s",
            "erzeuger.anlage.p_nvp_w", "erzeuger.a.p_nvp_w",
            "erzeuger.anlage.p_erzeugung_w", "erzeuger.a.p_erzeugung_w",
            "erzeuger.anlage.zustand", "erzeuger.a.anlage_zustand",
            "erzeuger.anlage.bits", "erzeuger.a.a_bits",
            "erzeuger.anlage.speicher_fuellstand", "erzeuger.a.speicher_fuellstand",
            "erzeuger.anlage.p_installiert_kw", "erzeuger.a.p_installiert_kw",
            "erzeuger.nb.kanal", "erzeuger.nb.n_kanal",
            "erzeuger.nb.bits", "erzeuger.nb.n_bits",
            "erzeuger.nb.p_vorgabe_prozent", "erzeuger.nb.n_p_prozent",
            "erzeuger.nb.cosphi", "erzeuger.nb.n_cosphi",
            "erzeuger.nb.seit_s", "erzeuger.nb.n_seit_s",
            "erzeuger.dv.kanal", "erzeuger.dv.d_kanal",
            "erzeuger.dv.bits", "erzeuger.dv.d_bits",
            "erzeuger.dv.p_soll_w", "erzeuger.dv.d_soll_w",
            "erzeuger.dv.seit_s", "erzeuger.dv.d_seit_s",
            "erzeuger.wirkung.quelle_p", "erzeuger.wirkung.quelle_p",
            "erzeuger.wirkung.bits", "erzeuger.wirkung.s_bits",
            "erzeuger.wirkung.p_grenze_w", "erzeuger.wirkung.p_grenze_w");

    /** Feld je Einheit: Portal ({@code EinheitFeld}) → Katalog ({@code t_*}). */
    static final Map<String, String> EINHEIT_FELDER = paare(
            "zustand", "t_zustand",
            "bits", "t_bits",
            "art", "t_art",
            "nenn_kw", "t_nenn_kw",
            "p_ist_w", "t_p_ist_w",
            "p_soll_w", "t_p_soll_w");

    /** Die Punkte mit den heutigen Wechseln (Portalnamen): wer begrenzt, Netzbetreiber, Direktvermarkter. */
    static final List<String> WECHSEL = List.of("erzeuger.wirkung.quelle_p", "erzeuger.nb.bits", "erzeuger.dv.bits");

    /**
     * Qualitäten ohne Messwert: die Lesung kam, trägt aber keinen Wert — {@code juengste} fiele sonst auf das rohe Wort
     * zurück, das bei skalierten Punkten ({@code n_p_prozent} × 0,1) nicht einmal in der Einheit des Punkts steht.
     */
    private static final java.util.Set<String> KEIN_WERT = java.util.Set.of("invalid", "device_error");

    private final AnlagensteuerungRepository repo;
    private final Clock uhr;

    @Autowired
    public ErzeugerJetztService(AnlagensteuerungRepository repo) {
        this(repo, Clock.systemUTC());
    }

    ErzeugerJetztService(AnlagensteuerungRepository repo, Clock uhr) {
        this.repo = repo;
        this.uhr = uhr;
    }

    /** Leer = die Anlage hat keine Anlagensteuerung (204); eine fremde oder umzäunte Anlage ist 404. */
    @Transactional(readOnly = true)
    public Optional<ErzeugerJetztDto.Jetzt> jetzt(UUID siteId) {
        if (!repo.anlageSichtbar(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        List<Steuerung> steuerungen = repo.steuerungen(siteId);
        if (steuerungen.isEmpty()) {
            return Optional.empty();
        }
        Steuerung s = steuerungen.get(0);
        List<Teil> teile = repo.einheiten(s.geraetId());
        int teAnzahl = repo.fassung(s.geraetId()).map(AnlagensteuerungRepository.Fassung::teAnzahl)
                .orElseGet(() -> Math.max(1, teile.size()));
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();

        Map<String, String> punkte = punkte(teAnzahl);
        Map<String, String> portalname = new LinkedHashMap<>();
        punkte.forEach((portal, katalog) -> portalname.put(katalog, portal));
        Map<String, ErzeugerJetztDto.Wert> werte = new LinkedHashMap<>();
        for (Jungster j : repo.juengste(tenant, s.entityId(), List.copyOf(punkte.values()))) {
            werte.put(portalname.get(j.pointKey()), j.zeit() == null ? new ErzeugerJetztDto.Wert(null, null, null)
                    : new ErzeugerJetztDto.Wert(KEIN_WERT.contains(j.qualitaet()) ? null : j.zahl(), zeit(j.zeit()),
                            j.qualitaet()));
        }

        Instant mitternacht = LocalDate.ofInstant(jetzt, ZONE).atStartOfDay(ZONE).toInstant();
        Map<String, List<Wechselzeile>> zeilen = new LinkedHashMap<>();
        WECHSEL.forEach(p -> zeilen.put(PUNKTE.get(p), new ArrayList<>()));
        for (Wechselzeile z : repo.wechsel(tenant, s.entityId(), List.copyOf(zeilen.keySet()),
                mitternacht.minusSeconds(AnlagensteuerungService.AKTUELL_BIS_S), jetzt,
                AnlagensteuerungService.AKTUELL_BIS_S)) {
            zeilen.get(z.pointKey()).add(z);
        }
        Map<String, List<ErzeugerJetztDto.Wechsel>> wechselHeute = new LinkedHashMap<>();
        WECHSEL.forEach(p -> wechselHeute.put(p, heute(zeilen.get(PUNKTE.get(p)), mitternacht, jetzt)));

        Stammdaten d = repo.stammdaten(siteId).orElse(null);
        String netzbetreiber = repo.netzbetreiber(siteId, LocalDate.ofInstant(jetzt, ZONE))
                .orElse(d == null ? null : leer(d.netzbetreiberBild()));
        String direktvermarkter = d == null ? null
                : leer(d.direktvermarkter()) != null ? leer(d.direktvermarkter()) : leer(d.direktvermarkterBild());

        List<ErzeugerJetztDto.Einheit> einheiten = teile.stream().filter(t -> t.teNr() != null)
                .map(t -> new ErzeugerJetztDto.Einheit(t.teNr(), art(t.einheitArt()),
                        leer(t.typ()) != null ? leer(t.typ()) : leer(t.typBild()), t.nennleistungKw()))
                .toList();
        return Optional.of(new ErzeugerJetztDto.Jetzt(new ErzeugerJetztDto.Steuerung(s.geraetId(), name(s)),
                netzbetreiber, direktvermarkter, einheiten, werte, wechselHeute));
    }

    /** Portalname → Katalogschlüssel aller Punkte eines Bilds mit {@code teAnzahl} Einheiten. */
    static Map<String, String> punkte(int teAnzahl) {
        Map<String, String> out = new LinkedHashMap<>(PUNKTE);
        for (int te = 1; te <= teAnzahl; te++) {
            for (Map.Entry<String, String> f : EINHEIT_FELDER.entrySet()) {
                out.put("erzeuger.te" + te + "." + f.getKey(), "erzeuger.te[" + te + "]." + f.getValue());
            }
        }
        return out;
    }

    /**
     * Die Wechsel eines Punkts heute: zuerst der Wert um Mitternacht (null = keine gute Lesung in den
     * {@link AnlagensteuerungService#AKTUELL_BIS_S} Sekunden davor), dann jeder neue Wert bis {@code jetzt}. Eine
     * Lücke in den Lesungen macht den Punkt ab ihrem Beginn unbekannt; die nächste Lesung gilt wieder.
     */
    static List<ErzeugerJetztDto.Wechsel> heute(List<Wechselzeile> zeilen, Instant mitternacht, Instant jetzt) {
        long luecke = AnlagensteuerungService.AKTUELL_BIS_S;
        List<Stand> leiste = new ArrayList<>();
        for (Wechselzeile z : zeilen) {
            if (z.vorherZeit() != null && z.zeit().isAfter(z.vorherZeit().plusSeconds(luecke))) {
                leiste.add(new Stand(z.vorherZeit().plusSeconds(luecke), null));
            }
            leiste.add(new Stand(z.zeit(), z.wert()));
            if (z.letzte() && jetzt.isAfter(z.zeit().plusSeconds(luecke))) {
                leiste.add(new Stand(z.zeit().plusSeconds(luecke), null));
            }
        }
        BigDecimal umMitternacht = null;
        for (Stand st : leiste) {
            if (!st.ab().isAfter(mitternacht)) {
                umMitternacht = st.wert();
            }
        }
        List<ErzeugerJetztDto.Wechsel> out = new ArrayList<>();
        out.add(new ErzeugerJetztDto.Wechsel(zeit(mitternacht), umMitternacht));
        BigDecimal zuletzt = umMitternacht;
        for (Stand st : leiste) {
            if (st.ab().isAfter(mitternacht) && !st.ab().isAfter(jetzt) && !gleich(st.wert(), zuletzt)) {
                out.add(new ErzeugerJetztDto.Wechsel(zeit(st.ab()), st.wert()));
                zuletzt = st.wert();
            }
        }
        return out;
    }

    private record Stand(Instant ab, BigDecimal wert) {}

    private static boolean gleich(BigDecimal a, BigDecimal b) {
        return a == null ? b == null : b != null && a.compareTo(b) == 0;
    }

    /** {@code einheit_art} der Teile → das Wort des Portals. */
    private static String art(String einheitArt) {
        if ("pv_wechselrichter".equals(einheitArt)) {
            return "pv";
        }
        return "bhkw_motor".equals(einheitArt) ? "bhkw" : null;
    }

    /** Wie die Überwachung die Steuerung nennt ({@code ErzeugerWerteLeser}): Bezeichnung, sonst Kennzeichen. */
    private static String name(Steuerung s) {
        return leer(s.bezeichnung()) != null ? leer(s.bezeichnung()) : s.kennzeichen();
    }

    private static String leer(String text) {
        return text == null || text.isBlank() ? null : text.strip();
    }

    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static Map<String, String> paare(String... kv) {
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            out.put(kv[i], kv[i + 1]);
        }
        return java.util.Collections.unmodifiableMap(out);
    }
}
