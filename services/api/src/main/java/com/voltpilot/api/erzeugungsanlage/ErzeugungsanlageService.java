package com.voltpilot.api.erzeugungsanlage;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeugungsanlage.ErzeugungsanlageRepository.Bestand;
import com.voltpilot.api.erzeugungsanlage.ErzeugungsanlageRepository.Ea;
import com.voltpilot.api.erzeugungsanlage.ErzeugungsanlageRepository.Fassung;
import com.voltpilot.api.erzeugungsanlage.ErzeugungsanlageRepository.Verweis;
import com.voltpilot.api.optimizer.EegRates;
import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.ErzeugungsanlagenDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Erzeugungsanlagen einer Anlage lesen und pflegen (Messkonzepte S1, NUR ANZEIGE). Das Lesemodell rechnet den Satz
 * je EA mit {@link EaVerguetung} aus ihrer eigenen Inbetriebnahme und Leistung; Fahrplan, Erlöse und Box bleiben beim
 * Satz der Anlage.
 *
 * <p>Schreiben: eine EA anlegen (mit MaStR-Nachschlagen oder von Hand, auch aus einem Vorschlag), ihre Identität
 * ändern, eine Fassung ab einem Tag setzen, Komponenten verweisen und lösen, eine versehentlich angelegte EA aufheben.
 * Jeder Schreibvorgang schreibt einen Protokolleintrag; eine Ablehnung schreibt nichts. Eine EA, die der Anlage folgt
 * ({@link ErzeugungsanlageBestand}), nimmt Leistung, Inbetriebnahme, MaStR-Einheit und eigenen Satz nur über die
 * Anlage an - sonst zeigte sie etwas anderes als die Karte „Einspeisevergütung“ (409). Wer eine zweite EA anlegt,
 * löst EA 1 von der Anlage; ab dann pflegt ein Mensch beide.
 */
@Service
public class ErzeugungsanlageService {

    static final Set<String> ARTEN = Set.of("pv", "wind", "wasser", "biomasse", "kwk", "sonstige");
    static final Set<String> EINSPEISEARTEN = Set.of("voll", "ueberschuss");
    private static final Pattern SEE = Pattern.compile("^SEE[0-9]{12}$");
    private static final BigDecimal SATZ_MAX = BigDecimal.valueOf(100);
    /** NUMERIC(12, 3). */
    private static final BigDecimal LEISTUNG_MAX = new BigDecimal("999999999.999");

    static final String FOLGT_ANLAGE = "Solange sie die einzige Erzeugungsanlage ist, übernimmt EA 1 Leistung, "
            + "Inbetriebnahme, MaStR-Einheit und eigenen Satz aus Ihrer Anlage. Ändern Sie diese dort: "
            + "unter „Registrierung (MaStR)“ und „Einspeisevergütung“.";

    private final ErzeugungsanlageRepository repo;
    private final ObjectMapper json;
    private final TransactionTemplate transaktion;
    private final EegRates rates;
    private volatile Clock uhr = Clock.systemUTC();

    public ErzeugungsanlageService(ErzeugungsanlageRepository repo, ObjectMapper json,
            PlatformTransactionManager transactionManager, OptimizerProperties optimizer) {
        this.repo = repo;
        this.json = json;
        this.transaktion = new TransactionTemplate(transactionManager);
        // Derselbe Satzplan wie Karte, Optimierer und Erlöse (OPTIMIZER_EEG_RATES_JSON).
        this.rates = EegRates.fromJson(optimizer.eegRatesJson());
    }

    /** Nur für Tests: die Uhr, an der „heute“ hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------------------------------ lesen

    public ErzeugungsanlagenDto lesen(UUID siteId, LocalDate stichtag) {
        Bestand b = bestand(siteId);
        LocalDate tag = stichtag != null ? stichtag : heute();
        List<Ea> eas = repo.aktive(siteId);
        List<UUID> ids = eas.stream().map(Ea::id).toList();
        Map<UUID, List<Fassung>> fassungen = repo.fassungen(ids).stream()
                .collect(Collectors.groupingBy(Fassung::eaId, LinkedHashMap::new, Collectors.toList()));
        Map<UUID, List<Verweis>> verweise = repo.verweise(ids).stream()
                .collect(Collectors.groupingBy(Verweis::eaId, LinkedHashMap::new, Collectors.toList()));
        List<ErzeugungsanlagenDto.Erzeugungsanlage> aus = new ArrayList<>();
        for (Ea ea : eas) {
            List<Fassung> f = fassungen.getOrDefault(ea.id(), List.of());
            Fassung gilt = fassungAm(f, tag);
            EaVerguetung.Stand v = EaVerguetung.von(b.plantKind(), b.netzladenErlaubt(), ea.inbetriebnahme(),
                    ea.abSolarspitzengesetz(), gilt == null ? null : gilt.leistungKwp(),
                    gilt == null ? null : gilt.einspeiseart(), gilt == null ? null : gilt.satzAngegebenCtKwh(), tag,
                    rates);
            aus.add(new ErzeugungsanlagenDto.Erzeugungsanlage(ea.id(), ea.nummer(), ea.name(), bezeichnung(ea),
                    ea.art(), ea.inbetriebnahme(), ea.abSolarspitzengesetz(), ea.registryUnitId(),
                    ea.registryFetchedAt(), ea.folgtAnlage(), gilt == null ? null : form(gilt),
                    f.stream().map(ErzeugungsanlageService::form).toList(),
                    verweise.getOrDefault(ea.id(), List.of()).stream()
                            .map(x -> new ErzeugungsanlagenDto.Komponente(x.id(), x.komponenteId(), x.komponenteName(),
                                    x.eingang(), x.gueltigAb(), x.gueltigBis()))
                            .toList(),
                    new ErzeugungsanlagenDto.Verguetung(v.zustand(), v.wirksamCtKwh(), v.angegebenCtKwh(),
                            v.hergeleitetCtKwh(), v.naeherung(), v.foerderendeAm(),
                            v.ohneVerguetungBeiNegativpreis())));
        }
        ErzeugungsanlageRepository.Anschluss na = repo.netzanschluss(siteId, tag);
        return new ErzeugungsanlagenDto(tag,
                na == null ? null : new ErzeugungsanlagenDto.Netzanschluss(na.id(), na.kennzeichen(), na.name()),
                aus,
                repo.vorschlaege(siteId, tag).stream()
                        .map(x -> new ErzeugungsanlagenDto.Vorschlag(x.komponenteId(), x.name(), x.leistungKwp(),
                                x.registryUnitId()))
                        .toList());
    }

    /** Die Fassung, die am Tag gilt: die mit dem spätesten ersten Tag bis einschließlich {@code tag}. */
    static Fassung fassungAm(List<Fassung> fassungen, LocalDate tag) {
        Fassung gilt = null;
        for (Fassung f : fassungen) {
            if (f.gueltigAb() == null || !f.gueltigAb().isAfter(tag)) {
                if (gilt == null || (f.gueltigAb() != null
                        && (gilt.gueltigAb() == null || f.gueltigAb().isAfter(gilt.gueltigAb())))) {
                    gilt = f;
                }
            }
        }
        return gilt;
    }

    /** „EA 1“ oder „EA 2 · PV Scheune“ - nie „Anlage“ allein (F2). */
    static String bezeichnung(Ea ea) {
        return ea.name() == null ? "EA " + ea.nummer() : "EA " + ea.nummer() + " · " + ea.name();
    }

    // --------------------------------------------------------------------------------------- schreiben

    public ErzeugungsanlagenDto anlegen(UUID siteId, ErzeugungsanlagenDto.Anlegen a, ProtokollAkteur wer) {
        if (a == null) {
            throw anfrage("Bitte geben Sie die Erzeugungsanlage an.");
        }
        Bestand b = bestand(siteId);
        String name = name(a.name());
        String art = art(a.art());
        LocalDate inbetriebnahme = inbetriebnahme(a.inbetriebnahme());
        Boolean ab51a = inbetriebnahme == null ? a.inbetriebnahmeAbSolarspitzengesetz() : null;
        String unit = see(a.registryUnitId());
        BigDecimal kwp = leistung(a.leistungKwp());
        String einspeiseart = einspeiseart(a.einspeiseart());
        BigDecimal satz = satz(a.satzAngegebenCtKwh());
        Integer eingang = eingang(a.eingang());
        String komponente = a.komponenteId() == null ? null : komponente(siteId, a.komponenteId());
        Instant jetzt = uhr.instant();
        LocalDate heute = heute();
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(siteId);
            List<Ea> eas = repo.aktive(siteId);
            if (a.komponenteId() != null) {
                belegt(siteId, a.komponenteId(), komponente, eingang, heute, null, eas);
            }
            for (Ea folgt : eas) {
                if (folgt.folgtAnlage()) {
                    repo.folgtNichtMehr(folgt.id(), jetzt);
                    repo.protokoll(b.tenantId(), siteId, folgt.id(), "bearbeitet", text(Map.<String, Object>of("folgt_anlage", true)),
                            text(Map.<String, Object>of("folgt_anlage", false)), wer);
                }
            }
            int nummer = repo.naechsteNummer(siteId);
            boolean mastr = a.mastrBestaetigt() && unit != null;
            UUID id = repo.anlegen(b.tenantId(), siteId, nummer, name, art, inbetriebnahme, ab51a,
                    mastr ? "mastr" : null, unit, mastr ? jetzt : null, false, ErzeugungsanlageBestand.kurz(wer));
            repo.fassungEintragen(b.tenantId(), id, null, kwp, einspeiseart, satz, mastr ? "mastr" : "angegeben",
                    ErzeugungsanlageBestand.kurz(wer));
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("nummer", nummer);
            neu.put("name", name);
            neu.put("art", art);
            neu.put("inbetriebnahme", tag(inbetriebnahme));
            neu.put("inbetriebnahme_ab_solarspitzengesetz", ab51a);
            neu.put("registry_unit_id", unit);
            neu.putAll(ErzeugungsanlageBestand.fassung(null, kwp, einspeiseart, satz));
            if (a.komponenteId() != null) {
                repo.verweisEintragen(b.tenantId(), id, a.komponenteId(), eingang, heute,
                        ErzeugungsanlageBestand.kurz(wer));
                neu.put("komponente_id", a.komponenteId().toString());
                neu.put("eingang", eingang);
            }
            repo.protokoll(b.tenantId(), siteId, id, "angelegt", null, text(neu), wer);
        });
        return lesen(siteId, null);
    }

    public ErzeugungsanlagenDto bearbeiten(UUID siteId, UUID eaId, ErzeugungsanlagenDto.Bearbeiten e,
            ProtokollAkteur wer) {
        if (e == null) {
            throw anfrage("Bitte geben Sie die Erzeugungsanlage an.");
        }
        Bestand b = bestand(siteId);
        String name = name(e.name());
        String art = art(e.art());
        LocalDate inbetriebnahme = inbetriebnahme(e.inbetriebnahme());
        Boolean ab51a = inbetriebnahme == null ? e.inbetriebnahmeAbSolarspitzengesetz() : null;
        String unit = see(e.registryUnitId());
        Instant jetzt = uhr.instant();
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(siteId);
            Ea ea = ea(siteId, eaId);
            if (ea.folgtAnlage() && (!Objects.equals(ea.inbetriebnahme(), inbetriebnahme)
                    || !Objects.equals(ea.abSolarspitzengesetz(), ab51a)
                    || !Objects.equals(ea.registryUnitId(), unit))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, FOLGT_ANLAGE);
            }
            boolean mastr = unit != null && (e.mastrBestaetigt()
                    || (unit.equals(ea.registryUnitId()) && "mastr".equals(ea.registry())));
            Instant abgerufen = !mastr ? null
                    : e.mastrBestaetigt() ? jetzt : ea.registryFetchedAt();
            if (Objects.equals(ea.name(), name) && ea.art().equals(art)
                    && Objects.equals(ea.inbetriebnahme(), inbetriebnahme)
                    && Objects.equals(ea.abSolarspitzengesetz(), ab51a)
                    && Objects.equals(ea.registryUnitId(), unit)
                    && Objects.equals(ea.registry(), mastr ? "mastr" : null)
                    && Objects.equals(ea.registryFetchedAt(), abgerufen)) {
                return;
            }
            repo.identitaet(ea.id(), name, art, inbetriebnahme, ab51a, mastr ? "mastr" : null, unit, abgerufen, jetzt);
            repo.protokoll(b.tenantId(), siteId, ea.id(), "bearbeitet",
                    text(identitaet(ea.name(), ea.art(), ea.inbetriebnahme(), ea.abSolarspitzengesetz(),
                            ea.registryUnitId())),
                    text(identitaet(name, art, inbetriebnahme, ab51a, unit)), wer);
        });
        return lesen(siteId, null);
    }

    public ErzeugungsanlagenDto fassungSetzen(UUID siteId, UUID eaId, ErzeugungsanlagenDto.FassungSetzen f,
            ProtokollAkteur wer) {
        if (f == null) {
            throw anfrage("Bitte geben Sie die Fassung an.");
        }
        Bestand b = bestand(siteId);
        LocalDate ab = f.gueltigAb();
        BigDecimal kwp = leistung(f.leistungKwp());
        String einspeiseart = einspeiseart(f.einspeiseart());
        BigDecimal satz = satz(f.satzAngegebenCtKwh());
        Instant jetzt = uhr.instant();
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(siteId);
            Ea ea = ea(siteId, eaId);
            if (ab != null && ea.inbetriebnahme() != null && ab.isBefore(ea.inbetriebnahme())) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
                        "Eine Fassung kann nicht vor der Inbetriebnahme (" + ea.inbetriebnahme() + ") beginnen.");
            }
            if (ea.folgtAnlage()) {
                ErzeugungsanlageBestand.Werte w = ErzeugungsanlageBestand.Werte.aus(b);
                if (!ErzeugungsanlageBestand.gleich(w.kwp(), kwp) || !ErzeugungsanlageBestand.gleich(w.satz(), satz)) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT, FOLGT_ANLAGE);
                }
            }
            Fassung alt = repo.fassungen(List.of(ea.id())).stream()
                    .filter(x -> Objects.equals(x.gueltigAb(), ab)).findFirst().orElse(null);
            if (alt != null && ErzeugungsanlageBestand.gleich(alt.leistungKwp(), kwp)
                    && Objects.equals(alt.einspeiseart(), einspeiseart)
                    && ErzeugungsanlageBestand.gleich(alt.satzAngegebenCtKwh(), satz)) {
                return;
            }
            if (alt != null) {
                repo.fassungAufheben(alt.id(), jetzt);
            }
            String herkunft = f.mastrBestaetigt() ? "mastr" : ea.folgtAnlage() ? "bestand" : "angegeben";
            repo.fassungEintragen(b.tenantId(), ea.id(), ab, kwp, einspeiseart, satz, herkunft,
                    ErzeugungsanlageBestand.kurz(wer));
            repo.protokoll(b.tenantId(), siteId, ea.id(), "fassung",
                    alt == null ? null : text(ErzeugungsanlageBestand.fassung(alt.gueltigAb(), alt.leistungKwp(),
                            alt.einspeiseart(), alt.satzAngegebenCtKwh())),
                    text(ErzeugungsanlageBestand.fassung(ab, kwp, einspeiseart, satz)), wer);
        });
        return lesen(siteId, null);
    }

    public ErzeugungsanlagenDto verweisen(UUID siteId, UUID eaId, ErzeugungsanlagenDto.Verweisen v,
            ProtokollAkteur wer) {
        if (v == null || v.komponenteId() == null) {
            throw anfrage("Bitte wählen Sie die Komponente, die diese Erzeugungsanlage speist.");
        }
        Bestand b = bestand(siteId);
        Integer eingang = eingang(v.eingang());
        String name = komponente(siteId, v.komponenteId());
        LocalDate ab = v.gueltigAb() != null ? v.gueltigAb() : heute();
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(siteId);
            Ea ea = ea(siteId, eaId);
            belegt(siteId, v.komponenteId(), name, eingang, ab, ea.id(), repo.aktive(siteId));
            UUID id = repo.verweisEintragen(b.tenantId(), ea.id(), v.komponenteId(), eingang, ab,
                    ErzeugungsanlageBestand.kurz(wer));
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("verweis_id", id.toString());
            neu.put("komponente_id", v.komponenteId().toString());
            neu.put("eingang", eingang);
            neu.put("gueltig_ab", tag(ab));
            repo.protokoll(b.tenantId(), siteId, ea.id(), "komponente", null, text(neu), wer);
        });
        return lesen(siteId, null);
    }

    /** Ein Verweis endet gestern; einer, der heute oder später begann, wird aufgehoben (er galt nie). */
    public ErzeugungsanlagenDto verweisLoesen(UUID siteId, UUID eaId, UUID verweisId, ProtokollAkteur wer) {
        Bestand b = bestand(siteId);
        Instant jetzt = uhr.instant();
        LocalDate heute = heute();
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(siteId);
            Ea ea = ea(siteId, eaId);
            Verweis v = repo.verweise(List.of(ea.id())).stream().filter(x -> x.id().equals(verweisId)).findFirst()
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Verweis nicht gefunden."));
            if (v.gueltigBis() != null && v.gueltigBis().isBefore(heute)) {
                return;
            }
            Map<String, Object> alt = new LinkedHashMap<>();
            alt.put("verweis_id", v.id().toString());
            alt.put("komponente_id", v.komponenteId().toString());
            alt.put("eingang", v.eingang());
            alt.put("gueltig_ab", tag(v.gueltigAb()));
            alt.put("gueltig_bis", tag(v.gueltigBis()));
            Map<String, Object> neu = new LinkedHashMap<>(alt);
            if (!v.gueltigAb().isBefore(heute)) {
                repo.verweisAufheben(v.id(), jetzt);
                neu.put("aufgehoben", true);
            } else {
                repo.verweisBeenden(v.id(), heute.minusDays(1));
                neu.put("gueltig_bis", tag(heute.minusDays(1)));
            }
            repo.protokoll(b.tenantId(), siteId, ea.id(), "komponente", text(alt), text(neu), wer);
        });
        return lesen(siteId, null);
    }

    /** Eine versehentlich angelegte EA aufheben - nie EA 1, die der Anlage folgt. Ihre Nummer wird nie neu vergeben. */
    public ErzeugungsanlagenDto aufheben(UUID siteId, UUID eaId, ProtokollAkteur wer) {
        Bestand b = bestand(siteId);
        Instant jetzt = uhr.instant();
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(siteId);
            Ea ea = ea(siteId, eaId);
            if (ea.folgtAnlage()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "EA 1 kommt aus Ihrer Anlage und bleibt, "
                        + "solange die Anlage eine PV-Leistung oder eine Registrierung trägt.");
            }
            repo.aufheben(ea.id(), jetzt);
            repo.protokoll(b.tenantId(), siteId, ea.id(), "aufgehoben", text(Map.<String, Object>of("bezeichnung", bezeichnung(ea))),
                    null, wer);
        });
        return lesen(siteId, null);
    }

    // ------------------------------------------------------------------------------------------ Gerüst

    private Bestand bestand(UUID siteId) {
        Bestand b = repo.bestand(siteId);
        if (b == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return b;
    }

    private Ea ea(UUID siteId, UUID eaId) {
        return repo.aktive(siteId).stream().filter(x -> x.id().equals(eaId)).findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Diese Erzeugungsanlage gibt es an dieser Anlage nicht."));
    }

    /**
     * Speist die Komponente ab {@code ab} schon eine (andere) EA? Die ganze Komponente schließt jeden Eingang aus,
     * derselbe Eingang zweimal ebenso; zwei verschiedene Eingänge für zwei EA sind der Normalfall einer Erweiterung am
     * zweiten MPP-Eingang.
     */
    private void belegt(UUID siteId, UUID komponenteId, String name, Integer eingang, LocalDate ab, UUID eigene,
            List<Ea> eas) {
        for (Verweis v : repo.verweiseAuf(siteId, komponenteId)) {
            boolean ueberlappt = v.gueltigBis() == null || !v.gueltigBis().isBefore(ab);
            boolean kollidiert = eingang == null || v.eingang() == null || eingang.equals(v.eingang());
            if (ueberlappt && kollidiert) {
                String belegt = eas.stream().filter(x -> x.id().equals(v.eaId())).findFirst()
                        .map(ErzeugungsanlageService::bezeichnung).orElse("einer anderen Erzeugungsanlage");
                String was = (name == null || name.isBlank() ? "Diese Komponente" : "„" + name + "“")
                        + (v.eingang() == null ? "" : " (Eingang " + v.eingang() + ")");
                throw new ResponseStatusException(HttpStatus.CONFLICT, v.eaId().equals(eigene)
                        ? was + " speist diese Erzeugungsanlage schon."
                        : was + " speist schon " + belegt + ". Lösen Sie den Verweis dort zuerst, oder wählen Sie "
                                + "einen anderen Eingang.");
            }
        }
    }

    private String komponente(UUID siteId, UUID komponenteId) {
        String name = repo.komponenteName(siteId, komponenteId);
        if (name == null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_CONTENT,
                    "Diese Komponente gehört nicht zu dieser Anlage.");
        }
        return name;
    }

    private LocalDate heute() {
        return LocalDate.ofInstant(uhr.instant(), ErzeugungsanlageBestand.BERLIN);
    }

    private static String name(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String n = raw.strip();
        if (n.length() > 80) {
            throw anfrage("Der Name darf höchstens 80 Zeichen lang sein.");
        }
        return n;
    }

    private static String art(String raw) {
        if (raw == null || raw.isBlank()) {
            return "pv";
        }
        if (!ARTEN.contains(raw)) {
            throw anfrage("Die Art ist eine von: pv, wind, wasser, biomasse, kwk, sonstige.");
        }
        return raw;
    }

    private LocalDate inbetriebnahme(LocalDate d) {
        if (d != null && d.isAfter(heute())) {
            throw anfrage("Die Inbetriebnahme liegt in der Zukunft - tragen Sie die Erzeugungsanlage ein, sobald sie "
                    + "in Betrieb ist.");
        }
        return d;
    }

    private static String see(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String s = raw.strip().toUpperCase(java.util.Locale.ROOT);
        if (!SEE.matcher(s).matches()) {
            throw anfrage("Die MaStR-Nummer einer Einheit beginnt mit SEE und hat danach 12 Ziffern, "
                    + "z. B. SEE912345678901.");
        }
        return s;
    }

    private static BigDecimal leistung(BigDecimal kwp) {
        if (kwp == null) {
            return null;
        }
        if (kwp.signum() <= 0 || kwp.compareTo(LEISTUNG_MAX) > 0) {
            throw anfrage("Bitte geben Sie die Leistung als Zahl über 0 kWp an.");
        }
        return ErzeugungsanlageRepository.ohneNullen(kwp.setScale(3, RoundingMode.HALF_UP));
    }

    private static String einspeiseart(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        if (!EINSPEISEARTEN.contains(raw)) {
            throw anfrage("Die Einspeiseart ist voll oder ueberschuss - oder leer, wenn sie nicht bekannt ist.");
        }
        return raw;
    }

    private static BigDecimal satz(BigDecimal ct) {
        if (ct == null) {
            return null;
        }
        if (ct.signum() < 0 || ct.compareTo(SATZ_MAX) > 0) {
            throw anfrage("Bitte geben Sie den Satz als Zahl in ct/kWh zwischen 0 und 100 an, z. B. 8,2.");
        }
        return ErzeugungsanlageRepository.ohneNullen(ct.setScale(3, RoundingMode.HALF_UP));
    }

    private static Integer eingang(Integer k) {
        if (k != null && (k < 1 || k > 20)) {
            throw anfrage("Der Eingang ist eine Zahl von 1 bis 20 - oder leer für die ganze Komponente.");
        }
        return k;
    }

    private static Map<String, Object> identitaet(String name, String art, LocalDate inbetriebnahme, Boolean ab51a,
            String unit) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("art", art);
        m.put("inbetriebnahme", tag(inbetriebnahme));
        m.put("inbetriebnahme_ab_solarspitzengesetz", ab51a);
        m.put("registry_unit_id", unit);
        return m;
    }

    private static ErzeugungsanlagenDto.Fassung form(Fassung f) {
        return new ErzeugungsanlagenDto.Fassung(f.id(), f.gueltigAb(), f.leistungKwp(), f.einspeiseart(),
                f.satzAngegebenCtKwh(), f.herkunft());
    }

    private static String tag(LocalDate d) {
        return d == null ? null : d.toString();
    }

    private static ResponseStatusException anfrage(String grund) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, grund);
    }

    private String text(Map<String, Object> m) {
        try {
            return json.writeValueAsString(m);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
