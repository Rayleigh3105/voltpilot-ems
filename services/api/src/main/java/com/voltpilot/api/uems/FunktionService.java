package com.voltpilot.api.uems;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Aktion;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Funktion;
import com.voltpilot.api.uems.FunktionZustandAbleitung.StandortErgebnis;
import com.voltpilot.api.uems.FunktionZustandAbleitung.TeilnahmeErgebnis;
import com.voltpilot.api.uems.FunktionZustandAbleitung.TeilnahmeStand;
import com.voltpilot.api.uems.FunktionZustandAbleitung.UebergangErgebnis;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Zustand;
import com.voltpilot.api.web.dto.FunktionDto;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Die Funktionen je Standort lesen und „Steuern &amp; Optimieren“ steuern (UEMS AP-01 IP-3, R1/R2, E6 = C, E7, E9).
 *
 * <p><b>Die Regel ist der Vertrag.</b> Zustand, Prüfliste, „es fehlt“, Standort-Zustand und jeder Übergang kommen
 * aus {@link FunktionZustandAbleitung}; dieser Dienst liest nur die Eingänge ({@link FunktionFakten}), schreibt
 * das Ergebnis und nennt je roter Zeile den Weg.
 *
 * <p><b>R1/R2 — Starten und Fortsetzen prüfen die Liste in DERSELBEN Transaktion erneut.</b> Die Zeile des
 * Unternehmens wird zuerst gesperrt (derselbe Riegel wie der Bestands-Umstieg), dann werden die Fakten frisch
 * gelesen, der Übergang abgeleitet und erst dann geschrieben — eine Prüfung vor der Transaktion wäre keine.
 *
 * <p><b>Was geschrieben wird:</b> die Teilnahme (Zustand + Zeitpunkte), die Ruhe bis zum Start (IP-4:
 * {@link DeviceOverrideRepository#clearRuhe} beim Starten/Fortsetzen, {@link DeviceOverrideRepository#putRuhe}
 * beim Anhalten UND Beenden — eine beendete Anlage steuert nicht) und die Funktion des Standorts (der höchste
 * Zustand ihrer Teilnahmen). Der Registry-Push läuft NACH dem Commit, best-effort wie jeder andere. Nicht in
 * IP-3: Betriebsmodell „an“ beim Start (IP-10b), Freigaben beim Beenden zeitgültig beenden.
 */
@Service
public class FunktionService {

    private static final Logger log = LoggerFactory.getLogger(FunktionService.class);

    static final List<Aktion> ANLAGEN_AKTIONEN = List.of(Aktion.AUFNEHMEN, Aktion.STARTEN, Aktion.ANHALTEN,
            Aktion.FORTSETZEN, Aktion.BEENDEN);
    static final List<Aktion> STANDORT_AKTIONEN = List.of(Aktion.ANHALTEN, Aktion.FORTSETZEN, Aktion.BEENDEN);
    /** „Messen &amp; Auswerten“ kennt nur das Einrichten — es startet damit von selbst (AP-01 IP-9a). */
    static final List<Aktion> MESSEN_AKTIONEN = List.of(Aktion.EINRICHTEN);

    private final StandortRepository standorte;
    private final AnlageStandortRepository zuordnungen;
    private final UnternehmenRepository unternehmen;
    private final FunktionRepository funktionen;
    private final FunktionTeilnahmeRepository teilnahmen;
    private final FunktionFakten fakten;
    private final DeviceOverrideRepository overrides;
    private final Geltungsbereich geltungsbereich;
    private final JdbcTemplate jdbc;
    private final ObjectProvider<EntityRegistryService> registry;
    private final LeadDeviceService leadDevices;
    private final BoxFaehigkeiten boxFaehigkeiten;
    private volatile Clock uhr = Clock.systemUTC();

    public FunktionService(StandortRepository standorte, AnlageStandortRepository zuordnungen,
            UnternehmenRepository unternehmen, FunktionRepository funktionen, FunktionTeilnahmeRepository teilnahmen,
            FunktionFakten fakten, DeviceOverrideRepository overrides, Geltungsbereich geltungsbereich, JdbcTemplate jdbc,
            ObjectProvider<EntityRegistryService> registry, LeadDeviceService leadDevices,
            BoxFaehigkeiten boxFaehigkeiten) {
        this.standorte = standorte;
        this.zuordnungen = zuordnungen;
        this.unternehmen = unternehmen;
        this.funktionen = funktionen;
        this.teilnahmen = teilnahmen;
        this.fakten = fakten;
        this.overrides = overrides;
        this.geltungsbereich = geltungsbereich;
        this.jdbc = jdbc;
        this.registry = registry;
        this.leadDevices = leadDevices;
        this.boxFaehigkeiten = boxFaehigkeiten;
    }

    /** Nur für Tests. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ============================================================================ Lesen

    /** {@code GET /api/v1/funktionen}: je nicht archiviertem Standort beide Funktionen, dazu das Unternehmen. */
    @Transactional(readOnly = true)
    public FunktionDto.Funktionen uebersicht() {
        Instant jetzt = uhr.instant();
        Welt w = welt();
        List<FunktionDto.Standort> out = new ArrayList<>();
        int messen = 0;
        int steuern = 0;
        for (StandortRepository.Standort st : w.standorte()) {
            if (st.archiviertAm() != null) {
                continue;
            }
            FunktionDto.Standort s = standortBlock(st, w, jetzt);
            out.add(s);
            messen += Zustand.AKTIV.code().equals(s.messen().zustand()) ? 1 : 0;
            steuern += Zustand.AKTIV.code().equals(s.steuern().zustand()) ? 1 : 0;
        }
        return new FunktionDto.Funktionen(new FunktionDto.Unternehmen(verbreitung(Funktion.MESSEN, messen, out.size()),
                verbreitung(Funktion.STEUERN, steuern, out.size())), List.copyOf(out));
    }

    /**
     * Ob „Messen &amp; Auswerten“ am Standort aktiv ist — aus genau denselben Fakten abgeleitet wie im
     * Kunden-Lesemodell. Ein gespeichertes {@code aktiv} bleibt als Bestandsschutz gültig; der heutige Kundenweg
     * speichert dagegen {@code entwurf} und erreicht {@code aktiv} ausschließlich über die Ableitung.
     */
    @Transactional(readOnly = true)
    public boolean misstAktiv(UUID standortId) {
        Instant jetzt = uhr.instant();
        Welt w = welt();
        StandortRepository.Standort st = w.standort(standortId);
        if (st == null) {
            return false;
        }
        FunktionRepository.Funktion gespeichert = w.funktionDerArt(standortId, Funktion.MESSEN);
        return gespeichert != null && (gespeichert.zustand() == Zustand.AKTIV
                || messenErgebnis(st, w, gespeichert, jetzt).zustand() == Zustand.AKTIV);
    }

    /** Die sechs Start-Fakten der Anlage; Grund und Weg stehen ausschließlich an roten Zeilen. */
    @Transactional(readOnly = true)
    public FunktionDto.SteuernPruefung steuernPruefung(UUID siteId) {
        if (!geltungsbereich.siteVisible(siteId)) {
            throw FunktionAbgelehnt.nichtGefunden("Anlage nicht gefunden.");
        }
        Instant jetzt = uhr.instant();
        Welt w = welt();
        StandortRepository.Standort st = w.heutigerStandortDerAnlage(siteId, jetzt);
        if (st == null) {
            throw FunktionAbgelehnt.nichtGefunden("Standort nicht gefunden.");
        }
        ZoneId zone = ZoneId.of(st.zeitzone());
        FunktionFakten.Anlage f = fakten.anlage(TenantContext.get(), siteId, jetzt, zone, w.register().get());
        FunktionTeilnahmeRepository.Teilnahme t = w.teilnahmeDerAnlage(siteId);
        TeilnahmeErgebnis r = pruefergebnis(w.name(siteId), t, f, jetzt, zone);
        List<FunktionDto.Weg> wege = wege(w.name(siteId), r.pruefliste(), f);
        Map<String, String> wegJePruefung = new HashMap<>();
        wege.forEach(weg -> wegJePruefung.put(weg.pruefung(), weg.satz()));
        List<FunktionDto.SteuernPruefZeile> zeilen = r.pruefliste().stream()
                .map(z -> pruefZeile(z, f, wegJePruefung.get(z.pruefung().code()))).toList();
        boolean bereit = zeilen.size() == FunktionZustandAbleitung.Pruefung.values().length
                && zeilen.stream().allMatch(z -> Boolean.TRUE.equals(z.bestanden()));
        List<FunktionDto.FreigabeZeile> freigabeZeilen = f.freigaben().stream()
                .map(k -> new FunktionDto.FreigabeZeile(k.entityId(), k.name(), k.weg(), k.freigegeben(), k.status(),
                        k.stationVerbunden(), k.steuerartGesetzt()))
                .toList();
        int freigegeben = (int) freigabeZeilen.stream().filter(FunktionDto.FreigabeZeile::freigegeben).count();
        FunktionDto.FreigabeStand freigabeStand = new FunktionDto.FreigabeStand(freigegeben,
                freigabeZeilen.size(), freigegeben + " von " + freigabeZeilen.size() + " freigegeben", freigabeZeilen);
        return new FunktionDto.SteuernPruefung(siteId, w.name(siteId), st.id(), st.name(), bereit, zeilen, freigabeStand,
                "Ab dem nächsten Fahrplan, spätestens in 15 Minuten, steuert VoltPilot " + w.name(siteId)
                        + " innerhalb der vereinbarten Grenzen. Nichts anderes ändert sich. Sie können jederzeit anhalten.");
    }

    /** „Steuern &amp; Optimieren läuft an 1 von 2 Standorten“ — ohne Standort kein Satz. */
    static FunktionDto.Verbreitung verbreitung(Funktion f, int laeuftAn, int standorte) {
        return new FunktionDto.Verbreitung(laeuftAn, standorte, standorte == 0 ? null
                : f.kundenwort() + " läuft an " + laeuftAn + " von " + standorte + " Standorten");
    }

    // ======================================================================== Schreiben

    /** {@code PUT /api/v1/sites/{id}/funktionen/steuern}: starten · anhalten · fortsetzen · beenden je Anlage. */
    @Transactional
    public FunktionDto.SteuernErgebnis steuernAnlage(UUID siteId, String aktionCode, ProtokollAkteur wer) {
        if (!geltungsbereich.siteVisible(siteId)) {
            throw FunktionAbgelehnt.nichtGefunden("Anlage nicht gefunden.");
        }
        Aktion aktion = aktion(aktionCode, ANLAGEN_AKTIONEN,
                "Für eine Anlage gibt es aufnehmen, starten, anhalten, fortsetzen und beenden.");
        unternehmen.sperren();
        Instant jetzt = uhr.instant();
        Welt w = welt();
        FunktionTeilnahmeRepository.Teilnahme t = w.teilnahmeDerAnlage(siteId);
        if (aktion == Aktion.AUFNEHMEN) {
            StandortRepository.Standort ziel = w.heutigerStandortDerAnlage(siteId, jetzt);
            if (ziel == null) {
                throw FunktionAbgelehnt.nichtGefunden("Standort nicht gefunden.");
            }
            UebergangErgebnis u = FunktionZustandAbleitung.uebergangAnlage(aktion,
                    ableiten(siteId, w.name(siteId), t, ZoneId.of(ziel.zeitzone()), jetzt, w.register()).stand());
            if (!u.erlaubt()) {
                throw FunktionAbgelehnt.uebergang(u, List.of(), List.of());
            }
            FunktionRepository.Funktion f = w.funktionDerArt(ziel.id(), Funktion.STEUERN);
            if (f == null || f.zustand() == Zustand.ARCHIVIERT) {
                UUID id = funktionen.anlegen(TenantContext.get(), ziel.id(), Funktion.STEUERN,
                        new FunktionRepository.Stand(Zustand.ENTWURF, null, null, null, null),
                        OrtProtokoll.akteurName(wer), jetzt);
                f = funktionen.finde(id).orElseThrow();
            }
            teilnahmen.anlegen(TenantContext.get(), f.id(), siteId,
                    new FunktionTeilnahmeRepository.Stand(Zustand.ENTWURF, null, null, null, null), false, jetzt)
                    .orElseThrow(() -> new IllegalStateException("Teilnahme wurde nicht angelegt"));
            overrides.putRuhe(siteId, wer.sub() != null ? wer.sub() : OrtProtokoll.akteurName(wer));
            nachDemCommitPushen(List.of(siteId));
            return new FunktionDto.SteuernErgebnis(aktion.code(),
                    List.of(new FunktionDto.AnlageRef(siteId, w.name(siteId))), standortBlock(ziel, welt(), jetzt));
        }
        FunktionRepository.Funktion f = t == null ? null : w.funktion(t.funktionId());
        StandortRepository.Standort st = f == null ? null : w.standort(f.standortId());
        ZoneId zone = st == null ? ZustandAbleitung.VORGABE_ZEITZONE : ZoneId.of(st.zeitzone());

        Abgeleitet a = ableiten(siteId, w.name(siteId), t, zone, jetzt, w.register());
        UebergangErgebnis u = FunktionZustandAbleitung.uebergangAnlage(aktion, a.stand());
        if (!u.erlaubt()) {
            throw FunktionAbgelehnt.uebergang(u, a.stand().fehlt(), a.wege());
        }
        TeilnahmeStand danach = schreiben(t, aktion, jetzt, wer, a.stand());
        List<TeilnahmeStand> stand = new ArrayList<>();
        for (FunktionTeilnahmeRepository.Teilnahme x : w.teilnahmenDerFunktion(f.id())) {
            stand.add(x.siteId().equals(siteId) ? danach
                    : ableiten(x.siteId(), w.name(x.siteId()), x, zone, jetzt, w.register()).stand());
        }
        nachziehen(f, stand, zone, jetzt, wer);
        nachDemCommitPushen(List.of(siteId));
        return new FunktionDto.SteuernErgebnis(aktion.code(), List.of(new FunktionDto.AnlageRef(siteId, w.name(siteId))),
                standortBlock(st, welt(), jetzt));
    }

    /**
     * {@code PUT /api/v1/standorte/{id}/funktionen/steuern}: anhalten · fortsetzen · beenden ALLER Teilnahmen,
     * für die der Übergang der Anlage erlaubt ist. Fortsetzen ist ganz oder gar nicht (Vertrag
     * {@link FunktionZustandAbleitung#uebergangStandort}).
     */
    @Transactional
    public FunktionDto.SteuernErgebnis steuernStandort(UUID standortId, String aktionCode, ProtokollAkteur wer) {
        StandortRepository.Standort st = standorte.finde(standortId)
                .orElseThrow(() -> FunktionAbgelehnt.nichtGefunden("Standort nicht gefunden."));
        Aktion aktion = aktion(aktionCode, STANDORT_AKTIONEN,
                "Für den ganzen Standort gibt es anhalten, fortsetzen und beenden — gestartet wird je Anlage.");
        unternehmen.sperren();
        Instant jetzt = uhr.instant();
        ZoneId zone = ZoneId.of(st.zeitzone());
        Welt w = welt();
        FunktionRepository.Funktion f = w.funktionDerArt(standortId, Funktion.STEUERN);

        List<Abgeleitet> anlagen = new ArrayList<>();
        if (f != null) {
            for (FunktionTeilnahmeRepository.Teilnahme x : w.juengsteJeAnlage(f.id())) {
                anlagen.add(ableiten(x.siteId(), w.name(x.siteId()), x, zone, jetzt, w.register()));
            }
        }
        List<TeilnahmeStand> vorher = anlagen.stream().map(Abgeleitet::stand).toList();
        UebergangErgebnis u = FunktionZustandAbleitung.uebergangStandort(aktion, vorher, zone);
        if (!u.erlaubt()) {
            List<String> fehlt = new ArrayList<>();
            List<FunktionDto.Weg> wege = new ArrayList<>();
            for (Abgeleitet a : anlagen) {
                if (FunktionZustandAbleitung.uebergangAnlage(aktion, a.stand()).grund()
                        == FunktionZustandAbleitung.Grund.PRUEFLISTE_OFFEN) {
                    fehlt.addAll(a.stand().fehlt());
                    wege.addAll(a.wege());
                }
            }
            throw FunktionAbgelehnt.uebergang(u, fehlt, wege);
        }
        List<TeilnahmeStand> danach = new ArrayList<>();
        List<FunktionDto.AnlageRef> betroffen = new ArrayList<>();
        List<String> namen = new ArrayList<>();
        for (Abgeleitet a : anlagen) {
            if (FunktionZustandAbleitung.uebergangAnlage(aktion, a.stand()).erlaubt()) {
                danach.add(schreiben(a.teilnahme(), aktion, jetzt, wer, a.stand()));
                betroffen.add(new FunktionDto.AnlageRef(a.siteId(), a.stand().anlage()));
                namen.add(a.stand().anlage());
            } else {
                danach.add(a.stand());
            }
        }
        if (!namen.equals(u.betroffen())) {
            // Der Vertrag und die Anlage für Anlage angewandte Regel sagen dasselbe — sonst schreibt hier nichts.
            throw new IllegalStateException("Standort-Übergang " + u.betroffen() + " ≠ je Anlage " + namen);
        }
        nachziehen(f, danach, zone, jetzt, wer);
        nachDemCommitPushen(betroffen.stream().map(FunktionDto.AnlageRef::id).toList());
        return new FunktionDto.SteuernErgebnis(aktion.code(), List.copyOf(betroffen), standortBlock(st, welt(), jetzt));
    }

    /**
     * {@code PUT /api/v1/standorte/{id}/funktionen/messen}: „Messen &amp; Auswerten“ für den Standort einrichten
     * (AP-01 IP-9a, Schritt 1 des Assistenten; §4.3 „— → Entwurf“). Legt NUR das Funktionsobjekt im Entwurf an —
     * Box, Messstellen und Prüfung folgen in den weiteren Schritten, und ob der Entwurf eingerichtet ist, entscheidet
     * jedes Lesen neu. Der Übergang ist der des Vertrags ({@link FunktionZustandAbleitung#uebergangMessen}), aus dem
     * Zustand, den auch {@code GET /funktionen} zeigt: ein zweites Einrichten ist 409 {@code bereits_angelegt}, nie
     * eine zweite Zeile; ein archivierter Standort 409 {@code standort_archiviert}.
     */
    @Transactional
    public FunktionDto.MessenErgebnis messenStandort(UUID standortId, String aktionCode, ProtokollAkteur wer) {
        standorte.finde(standortId).orElseThrow(() -> FunktionAbgelehnt.nichtGefunden("Standort nicht gefunden."));
        Aktion aktion = aktion(aktionCode, MESSEN_AKTIONEN, "Für Messen & Auswerten gibt es nur einrichten.");
        unternehmen.sperren();
        Instant jetzt = uhr.instant();
        Welt w = welt();
        StandortRepository.Standort st = w.standort(standortId);
        ZoneId zone = ZoneId.of(st.zeitzone());
        List<UUID> heuteDa = w.heuteZugeordnet(st.id(), LocalDate.ofInstant(jetzt, zone));
        // `messen()` sagt ohne Funktion „kein Objekt“, auch am archivierten Standort — für den Übergang zählt, dass
        // der Standort archiviert ist (Grund `standort_archiviert`), sonst bekäme er eine neue Funktion.
        Zustand vorher = st.archiviertAm() != null ? Zustand.ARCHIVIERT
                : FunktionZustandAbleitung.messen(messenEingang(st, w, w.funktionDerArt(st.id(), Funktion.MESSEN),
                        heuteDa, zone, jetzt)).zustand();
        UebergangErgebnis u = FunktionZustandAbleitung.uebergangMessen(aktion, vorher);
        if (!u.erlaubt()) {
            throw FunktionAbgelehnt.uebergang(u, List.of(), List.of());
        }
        funktionen.anlegen(TenantContext.get(), st.id(), Funktion.MESSEN,
                new FunktionRepository.Stand(u.nachher(), null, null, null, null), OrtProtokoll.akteurName(wer), jetzt);
        return new FunktionDto.MessenErgebnis(aktion.code(), standortBlock(st, welt(), jetzt));
    }

    private static Aktion aktion(String code, List<Aktion> erlaubt, String satz) {
        for (Aktion a : erlaubt) {
            if (a.code().equals(code)) {
                return a;
            }
        }
        throw FunktionAbgelehnt.anfrage(satz);
    }

    /** Schreibt die Teilnahme und die Ruhe; liefert die Teilnahme, wie der Vertrag sie danach ableitet. */
    private TeilnahmeStand schreiben(FunktionTeilnahmeRepository.Teilnahme t, Aktion aktion, Instant jetzt,
            ProtokollAkteur wer, TeilnahmeStand vorher) {
        FunktionTeilnahmeRepository.Stand neu = switch (aktion) {
            case STARTEN -> new FunktionTeilnahmeRepository.Stand(Zustand.AKTIV, t.eingerichtetAm(), jetzt, null, null);
            case FORTSETZEN -> new FunktionTeilnahmeRepository.Stand(Zustand.AKTIV, t.eingerichtetAm(), t.gestartetAm(),
                    null, null);
            case ANHALTEN -> new FunktionTeilnahmeRepository.Stand(Zustand.ANGEHALTEN, t.eingerichtetAm(),
                    t.gestartetAm(), jetzt, null);
            case BEENDEN -> new FunktionTeilnahmeRepository.Stand(Zustand.ARCHIVIERT, t.eingerichtetAm(),
                    t.gestartetAm(), t.angehaltenSeit(), jetzt);
            default -> throw new IllegalStateException(aktion.code());
        };
        if (!teilnahmen.zustandSetzen(t.id(), neu, jetzt)) {
            throw new IllegalStateException("Teilnahme " + t.id() + " nicht geschrieben");
        }
        if (aktion == Aktion.STARTEN || aktion == Aktion.FORTSETZEN) {
            overrides.clearRuhe(t.siteId());
        } else {
            overrides.putRuhe(t.siteId(), wer.sub() != null ? wer.sub() : OrtProtokoll.akteurName(wer));
        }
        Instant seit = switch (neu.zustand()) {
            case AKTIV -> neu.gestartetAm();
            case ANGEHALTEN -> neu.angehaltenSeit();
            default -> neu.beendetAm();
        };
        return new TeilnahmeStand(vorher.anlage(), neu.zustand(), seit, List.of());
    }

    /** Die Funktion des Standorts trägt den höchsten Zustand ihrer Teilnahmen (Vertrag {@code standort}). */
    private void nachziehen(FunktionRepository.Funktion f, List<TeilnahmeStand> stand, ZoneId zone, Instant jetzt,
            ProtokollAkteur wer) {
        StandortErgebnis s = FunktionZustandAbleitung.standort(stand, zone);
        if (s.zustand() == Zustand.KEIN_OBJEKT) {
            return;
        }
        Instant eingerichtetAm = f.eingerichtetAm();
        Instant aktivSeit = f.aktivSeit();
        Instant angehaltenSeit = null;
        Instant archiviertAm = null;
        switch (s.zustand()) {
            case EINGERICHTET -> eingerichtetAm = s.seit() != null ? s.seit() : eingerichtetAm;
            case AKTIV -> aktivSeit = s.seit() != null ? s.seit() : aktivSeit;
            case ANGEHALTEN -> angehaltenSeit = s.seit() != null ? s.seit() : jetzt;
            case ARCHIVIERT -> archiviertAm = s.seit() != null ? s.seit() : jetzt;
            default -> {
                // entwurf trägt keinen Zeitpunkt
            }
        }
        FunktionRepository.Stand neu = new FunktionRepository.Stand(s.zustand(), eingerichtetAm, aktivSeit,
                angehaltenSeit, archiviertAm);
        FunktionRepository.Stand alt = new FunktionRepository.Stand(f.zustand(), f.eingerichtetAm(), f.aktivSeit(),
                f.angehaltenSeit(), f.archiviertAm());
        if (!neu.equals(alt)) {
            funktionen.zustandSetzen(f.id(), neu, OrtProtokoll.akteurName(wer), jetzt);
        }
    }

    /** Die Ruhe reist im Registry-Push — NACH dem Commit, damit die Box nie einen zurückgerollten Stand bekommt. */
    private void nachDemCommitPushen(List<UUID> anlagen) {
        UUID tenant = TenantContext.get();
        Runnable push = () -> anlagen.forEach(site -> pushen(tenant, site));
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            push.run();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                push.run();
            }
        });
    }

    private void pushen(UUID tenant, UUID siteId) {
        EntityRegistryService svc = registry.getIfAvailable();
        if (svc == null) {
            return;
        }
        UUID vorher = TenantContext.get();
        try {
            TenantContext.set(tenant);
            EntityRegistryService.PushOutcome outcome = svc.pushRegistryBestEffort(siteId);
            if (!outcome.published()) {
                log.warn("Funktions-Übergang der Anlage {} nicht an die Box gepusht: {}", siteId, outcome.reason());
            }
        } catch (RuntimeException e) {
            log.warn("Funktions-Übergang der Anlage {} nicht an die Box gepusht: {}", siteId, e.toString());
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    // ======================================================================= Ableitung

    /** Eine Anlage, wie der Vertrag sie sieht, mit dem, was der Kunde braucht. */
    private record Abgeleitet(UUID siteId, FunktionTeilnahmeRepository.Teilnahme teilnahme, TeilnahmeStand stand,
            TeilnahmeErgebnis ergebnis, String text, List<FunktionDto.Weg> wege) {}

    /**
     * Die Teilnahme EINER Anlage aus ihrer gespeicherten Zeile und — nur wo die Prüfliste entscheidet (entwurf,
     * eingerichtet, angehalten) — frischen Fakten. Gespeichert sind der Lebenslauf (aufgenommen, gestartet,
     * angehalten, beendet); die Ruhe ohne Ende wird aus {@code angehalten} gebildet, denn der Dienst schreibt
     * beides in derselben Transaktion.
     */
    private Abgeleitet ableiten(UUID siteId, String name, FunktionTeilnahmeRepository.Teilnahme t, ZoneId zone,
            Instant jetzt, Supplier<List<MessstelleDto.RegisterZeile>> register) {
        if (t == null) {
            TeilnahmeErgebnis r = FunktionZustandAbleitung.teilnahme(new FunktionZustandAbleitung.TeilnahmeEingang(
                    name, false, null, null, false, null, null, List.of(), null, List.of(), null, false, null, jetzt,
                    zone));
            return new Abgeleitet(siteId, null, new TeilnahmeStand(name, r.zustand(), r.seit(), r.fehlt()), r,
                    r.text(), List.of());
        }
        boolean pruefen = t.zustand() == Zustand.ENTWURF || t.zustand() == Zustand.EINGERICHTET
                || t.zustand() == Zustand.ANGEHALTEN;
        FunktionFakten.Anlage f = pruefen ? fakten.anlage(TenantContext.get(), siteId, jetzt, zone, register.get()) : null;
        boolean gestartet = t.zustand() == Zustand.AKTIV || t.zustand() == Zustand.ANGEHALTEN;
        // Eine aus dem Bestand übernommene Teilnahme kann ohne Startdatum laufen (W5): gestartet ist sie trotzdem.
        Instant gestartetAm = !gestartet ? null : t.gestartetAm() != null ? t.gestartetAm() : t.createdAt();
        TeilnahmeErgebnis r = FunktionZustandAbleitung.teilnahme(new FunktionZustandAbleitung.TeilnahmeEingang(
                name, true, t.eingerichtetAm(), gestartetAm, t.uebernommen(),
                t.zustand() == Zustand.ANGEHALTEN ? new FunktionZustandAbleitung.RuheEintrag(t.angehaltenSeit(), null)
                        : null,
                t.beendetAm(), f == null ? List.of() : f.boxen(), f == null ? null : f.hauptzaehler(),
                f == null ? List.of() : f.komponenten(), f == null ? null : f.betriebsmodell(),
                f != null && f.grenze().plausibel(), null, jetzt, zone));
        Instant seit = r.seit();
        String text = r.text();
        if (r.zustand() == Zustand.AKTIV && t.gestartetAm() == null) {
            // Ohne Startdatum gibt es kein „Gestartet am …“ — der Satz des Vertrags dafür steht am Bestand.
            seit = null;
            text = FunktionZustandAbleitung.bestand(new FunktionZustandAbleitung.BestandEingang(name, true, null,
                    false, null, false, null, false), zone).text();
        }
        return new Abgeleitet(siteId, t, new TeilnahmeStand(name, r.zustand(), seit, r.fehlt()), r, text,
                f == null ? List.of() : wege(name, r.pruefliste(), f));
    }

    private static TeilnahmeErgebnis pruefergebnis(String name, FunktionTeilnahmeRepository.Teilnahme t,
            FunktionFakten.Anlage f, Instant jetzt, ZoneId zone) {
        boolean gestartet = t != null && (t.zustand() == Zustand.AKTIV || t.zustand() == Zustand.ANGEHALTEN);
        Instant gestartetAm = !gestartet ? null : t.gestartetAm() != null ? t.gestartetAm() : t.createdAt();
        return FunktionZustandAbleitung.teilnahme(new FunktionZustandAbleitung.TeilnahmeEingang(name, true,
                t == null ? null : t.eingerichtetAm(), gestartetAm, t != null && t.uebernommen(),
                t != null && t.zustand() == Zustand.ANGEHALTEN
                        ? new FunktionZustandAbleitung.RuheEintrag(t.angehaltenSeit(), null) : null,
                t == null ? null : t.beendetAm(), f.boxen(), f.hauptzaehler(), f.komponenten(), f.betriebsmodell(),
                f.grenze().plausibel(), null, jetzt, zone));
    }

    private static FunktionDto.SteuernPruefZeile pruefZeile(FunktionZustandAbleitung.PruefZeile z,
            FunktionFakten.Anlage f, String weg) {
        boolean rot = Boolean.FALSE.equals(z.bestanden());
        String fakt = switch (z.pruefung()) {
            case BOX -> f.boxen().isEmpty() ? "Keine Box verbunden" : f.boxen().stream()
                    .map(b -> b.name() + (b.verbunden() ? " verbunden" : " nicht verbunden"))
                    .collect(Collectors.joining(" · "));
            case FREIGABE -> f.komponenten().isEmpty() ? "Keine steuerbare Komponente" : f.komponenten().stream()
                    .map(k -> k.name() + (k.freigegeben() ? " freigegeben" : " nicht freigegeben"))
                    .collect(Collectors.joining(" · "));
            case VERBINDUNGSTEST -> f.komponenten().isEmpty() ? "Kein Verbindungstest vorhanden"
                    : f.komponenten().stream()
                            .map(k -> "Verbindungstest " + k.name()
                                    + (k.verbindungstestBestanden() ? " bestanden" : " nicht bestanden"))
                            .collect(Collectors.joining(" · "));
            case GRENZE -> grenzeFakt(f.grenze());
            case HAUPTZAEHLER -> f.hauptzaehler() == null ? "Kein Hauptzähler zugeordnet"
                    : "Hauptzähler " + f.hauptzaehler().kennzeichen()
                            + (f.hauptzaehler().zustand() == ZustandAbleitung.LiefertDaten.LIEFERT
                                    ? " liefert Daten" : " liefert keine aktuellen Daten");
            case BETRIEBSWEISE -> "Betriebsweise " + (f.betriebsmodell() != null || f.komponenten().stream()
                    .filter(k -> k.art() == FunktionZustandAbleitung.KomponentenArt.VERBRAUCHER && k.freigegeben())
                    .allMatch(k -> k.steuerart() != null) ? "gesetzt" : "nicht vollständig gesetzt");
        };
        return new FunktionDto.SteuernPruefZeile(z.pruefung().code(), z.bestanden(), fakt,
                rot ? pruefGrund(z.pruefung(), f) : null, rot ? weg : null);
    }

    private static String pruefGrund(FunktionZustandAbleitung.Pruefung p, FunktionFakten.Anlage f) {
        return switch (p) {
            case BOX -> f.boxen().isEmpty() ? "Für die Anlage ist keine Box verbunden."
                    : "Mindestens eine Box hat sich seit mehr als 5 Minuten nicht gemeldet.";
            case FREIGABE -> "Keine steuerbare Komponente trägt die erforderliche Freigabe.";
            case VERBINDUNGSTEST -> "Mindestens ein erforderlicher Verbindungstest fehlt oder ist älter als 90 Tage.";
            case GRENZE -> "Die Grenze ist nicht durch eine passende vereinbarte Leistung belegt.";
            case HAUPTZAEHLER -> f.hauptzaehler() == null ? "Es ist kein Hauptzähler für Netzbezug zugeordnet."
                    : "Der Hauptzähler liefert keine aktuellen Daten.";
            case BETRIEBSWEISE -> "Für eine freigegebene Komponente fehlt die Steuerart oder für den Speicher "
                    + "das Betriebsmodell.";
        };
    }

    private static String grenzeFakt(FunktionFakten.Grenze g) {
        if (g.befund() == FunktionFakten.GrenzeBefund.PLAUSIBEL) {
            return g.netzgrenzeKw() == null ? "Grenze innerhalb der vereinbarten Leistung"
                    : "Grenze " + kw(g.netzgrenzeKw()) + " kW ≤ " + kw(g.vereinbartKw()) + " kW vereinbart";
        }
        return switch (g.befund()) {
            case KEIN_NETZANSCHLUSS -> "Kein Netzanschluss zugeordnet";
            case OHNE_VEREINBARTE_LEISTUNG -> "Vereinbarte Leistung am Netzanschluss " + g.netzanschluss() + " fehlt";
            case UEBER_VEREINBARTER_LEISTUNG -> "Grenze " + kw(g.netzgrenzeKw()) + " kW > " + kw(g.vereinbartKw()) + " kW vereinbart";
            case PLAUSIBEL -> throw new IllegalStateException();
        };
    }

    /** Je roter Zeile der Weg — was der Kunde tun muss, damit sie grün wird. */
    static List<FunktionDto.Weg> wege(String anlage, List<FunktionZustandAbleitung.PruefZeile> pruefliste,
            FunktionFakten.Anlage f) {
        List<FunktionDto.Weg> out = new ArrayList<>();
        for (FunktionZustandAbleitung.PruefZeile z : pruefliste) {
            if (!Boolean.FALSE.equals(z.bestanden())) {
                continue;
            }
            out.add(new FunktionDto.Weg(z.pruefung().code(), switch (z.pruefung()) {
                case BOX -> f.boxen().isEmpty()
                        ? "Verbinden Sie eine Box mit " + anlage + "."
                        : "Prüfen Sie Strom und Internet der Box — sie hat sich seit mehr als 5 Minuten nicht gemeldet.";
                case FREIGABE -> "Geben Sie eine Komponente von " + anlage + " zum Steuern frei.";
                case VERBINDUNGSTEST -> "Wiederholen Sie den Schalt-Test — der letzte bestandene ist älter als 90 Tage.";
                case GRENZE -> grenzeWeg(anlage, f.grenze());
                case HAUPTZAEHLER -> f.hauptzaehler() == null
                        ? "Ordnen Sie einer Messstelle von " + anlage + " die Stellung „Hauptzähler“ mit Richtung "
                                + "„Bezug“ zu."
                        : "Prüfen Sie die Datenquelle des Hauptzählers " + f.hauptzaehler().kennzeichen()
                                + " — ohne Netzmessung regelt VoltPilot nicht am Netz.";
                case BETRIEBSWEISE -> "Wählen Sie für jeden freigegebenen Verbraucher eine Steuerart und für den "
                        + "Speicher ein Betriebsmodell.";
            }));
        }
        return List.copyOf(out);
    }

    static String grenzeWeg(String anlage, FunktionFakten.Grenze g) {
        return switch (g.befund()) {
            case KEIN_NETZANSCHLUSS -> "Ordnen Sie " + anlage + " unter Standort › Netzanschlüsse ihrem Netzanschluss "
                    + "zu und tragen Sie dort die vereinbarte Leistung ein.";
            case OHNE_VEREINBARTE_LEISTUNG -> "Tragen Sie beim Netzanschluss " + g.netzanschluss()
                    + " die vereinbarte Leistung ein.";
            case UEBER_VEREINBARTER_LEISTUNG -> "Senken Sie die Netzgrenze des Ladeparks von " + kw(g.netzgrenzeKw())
                    + " kW auf höchstens " + kw(g.vereinbartKw()) + " kW — die vereinbarte Leistung des Netzanschlusses "
                    + g.netzanschluss() + ".";
            case PLAUSIBEL -> throw new IllegalArgumentException("eine plausible Grenze hat keinen Weg");
        };
    }

    private static String kw(BigDecimal wert) {
        return wert.stripTrailingZeros().toPlainString().replace('.', ',');
    }

    // ======================================================================= Standort

    /** Ein Standort mit beiden Funktionen, wie {@code GET /api/v1/funktionen} ihn zeigt. */
    private FunktionDto.Standort standortBlock(StandortRepository.Standort st, Welt w, Instant jetzt) {
        ZoneId zone = ZoneId.of(st.zeitzone());
        LocalDate heute = LocalDate.ofInstant(jetzt, zone);
        List<UUID> heuteDa = w.heuteZugeordnet(st.id(), heute);

        // ---- Steuern & Optimieren
        FunktionRepository.Funktion fs = w.funktionDerArt(st.id(), Funktion.STEUERN);
        Set<UUID> anlagen = new LinkedHashSet<>(heuteDa);
        Map<UUID, FunktionTeilnahmeRepository.Teilnahme> jeAnlage = new HashMap<>();
        if (fs != null) {
            for (FunktionTeilnahmeRepository.Teilnahme t : w.juengsteJeAnlage(fs.id())) {
                anlagen.add(t.siteId());
                jeAnlage.put(t.siteId(), t);
            }
        }
        List<FunktionDto.Anlage> zeilen = new ArrayList<>();
        List<Abgeleitet> mitTeilnahme = new ArrayList<>();
        for (UUID site : anlagen) {
            FunktionTeilnahmeRepository.Teilnahme t = jeAnlage.get(site);
            Abgeleitet a = ableiten(site, w.name(site), t, zone, jetzt, w.register());
            if (t != null) {
                mitTeilnahme.add(a);
            }
            List<String> aktionen = t == null ? List.of() : ANLAGEN_AKTIONEN.stream()
                    .filter(x -> FunktionZustandAbleitung.uebergangAnlage(x, a.stand()).erlaubt())
                    .map(Aktion::code).toList();
            RuheHinweisRegel.Ergebnis hinweis = ruheHinweis(site, a.stand().zustand(),
                    aktionen.contains(Aktion.ANHALTEN.code()));
            zeilen.add(new FunktionDto.Anlage(site, w.name(site), new FunktionDto.Teilnahme(a.stand().zustand().code(),
                    zeit(a.stand().seit(), zone), a.text(), t != null && t.uebernommen(),
                    new FunktionDto.RuheHinweis(hinweis.jetzt(), hinweis.beimAnhalten()),
                    a.ergebnis().pruefliste().stream()
                            .map(z -> new FunktionDto.PruefZeile(z.pruefung().code(), z.bestanden())).toList(),
                    a.stand().fehlt(), a.wege(), aktionen)));
        }
        List<TeilnahmeStand> stand = mitTeilnahme.stream().map(Abgeleitet::stand).toList();
        StandortErgebnis s = FunktionZustandAbleitung.standort(stand, zone);
        List<String> fehlt = new ArrayList<>();
        stand.stream().filter(x -> x.zustand() == s.zustand()).forEach(x -> fehlt.addAll(x.fehlt()));
        List<String> standortAktionen = stand.isEmpty() ? List.of() : STANDORT_AKTIONEN.stream()
                .filter(x -> FunktionZustandAbleitung.uebergangStandort(x, stand, zone).erlaubt())
                .map(Aktion::code).toList();
        FunktionDto.Steuern steuern = new FunktionDto.Steuern(s.zustand().code(), zeit(s.seit(), zone), s.text(),
                List.copyOf(fehlt), standortAktionen, List.copyOf(zeilen));

        // ---- Messen & Auswerten
        FunktionZustandAbleitung.MessenErgebnis m = messenErgebnis(st, w,
                w.funktionDerArt(st.id(), Funktion.MESSEN), jetzt);
        FunktionDto.Messen messen = new FunktionDto.Messen(m.zustand().code(), zeit(m.seit(), zone), m.text(),
                m.fehlt(), m.datenlage());
        return new FunktionDto.Standort(st.id(), st.kurzzeichen(), st.name(), st.zeitzone(), messen, steuern);
    }

    private FunktionZustandAbleitung.MessenErgebnis messenErgebnis(StandortRepository.Standort st, Welt w,
            FunktionRepository.Funktion fm, Instant jetzt) {
        ZoneId zone = ZoneId.of(st.zeitzone());
        List<UUID> heuteDa = w.heuteZugeordnet(st.id(), LocalDate.ofInstant(jetzt, zone));
        return FunktionZustandAbleitung.messen(messenEingang(st, w, fm, heuteDa, zone, jetzt));
    }

    private RuheHinweisRegel.Ergebnis ruheHinweis(UUID site, Zustand zustand, boolean anhaltenErlaubt) {
        UUID ziel = leadDevices.fuehrendeBox(site).box();
        if (ziel == null) {
            return RuheHinweisRegel.ableiten(zustand, anhaltenErlaubt, List.of());
        }
        Boolean faehig = boxFaehigkeiten.kann(ziel, RuheHinweisRegel.FAEHIGKEIT) ? Boolean.TRUE : null;
        return RuheHinweisRegel.ableiten(zustand, anhaltenErlaubt,
                List.of(new RuheHinweisRegel.Box(true, faehig)));
    }

    /**
     * Die Eingänge von „Messen &amp; Auswerten“. Ohne Funktion braucht die Regel keine Fakten. Mit ihr kommen
     * die Messstellen aus dem Register: ihre Beobachtung ist dort schon aus {@link ZustandAbleitung} gebildet und
     * wird hier als ihre Eingänge zurückgereicht (liefert = ein guter Wert jetzt, liefert nicht = der letzte zu
     * {@code seit}), damit die Regel dasselbe Wort bildet — nie ein zweites Urteil.
     */
    private FunktionZustandAbleitung.MessenEingang messenEingang(StandortRepository.Standort st, Welt w,
            FunktionRepository.Funktion fm, List<UUID> heuteDa, ZoneId zone, Instant jetzt) {
        if (fm == null) {
            return new FunktionZustandAbleitung.MessenEingang(st.name(), false, false, st.archiviertAm(), null,
                    List.of(), List.of(), List.of(), List.of(), jetzt, zone);
        }
        List<ZustandAbleitung.BoxZustand> boxen = new ArrayList<>();
        List<FunktionZustandAbleitung.MessenAnlage> anlagen = new ArrayList<>();
        LocalDate heute = LocalDate.ofInstant(jetzt, zone);
        for (UUID site : heuteDa) {
            boxen.addAll(fakten.boxen(site, jetzt));
            if (fakten.grenze(site, heute).befund() != FunktionFakten.GrenzeBefund.KEIN_NETZANSCHLUSS) {
                int n = (int) w.register().get().stream().filter(z -> FunktionFakten.hauptzaehlerDer(z, site)).count();
                anlagen.add(new FunktionZustandAbleitung.MessenAnlage(w.name(site), n));
            }
        }
        List<FunktionZustandAbleitung.Messstelle> messstellen = new ArrayList<>();
        List<ZustandAbleitung.LiefertDaten> registerZeilen = new ArrayList<>();
        for (MessstelleDto.RegisterZeile z : w.register().get()) {
            if (z.ort() == null || !st.id().equals(z.ort().standortId())) {
                continue;
            }
            // AP-13 IP-7 (E13 = A): die Datenlage zählt JEDE Zeile des Standorts so, wie das Register sie zählt —
            // berechnete und archivierte eingeschlossen; die Prüfliste darunter bleibt bei den gemessenen, aktiven.
            ZustandAbleitung.LiefertDaten imRegister = MessstelleRegisterService.aggregatZustand(z);
            if (imRegister != null) {
                registerZeilen.add(imRegister);
            }
            if (z.beobachtung() == null || "archiviert".equals(z.lebenszyklus())) {
                continue;
            }
            MessstelleDto.RegisterBeobachtung b = z.beobachtung();
            ZustandAbleitung.LiefertDaten ld = ZustandAbleitung.LiefertDaten.vonCode(b.zustand());
            Instant letzter = switch (ld) {
                case LIEFERT -> jetzt;
                case LIEFERT_NICHT_SEIT -> b.seit() == null ? null : b.seit().toInstant();
                default -> null;
            };
            messstellen.add(new FunktionZustandAbleitung.Messstelle(z.kennzeichen(), false,
                    ld != ZustandAbleitung.LiefertDaten.KEINE_DATENQUELLE, letzter, letzter != null,
                    b.kadenzS() == null ? MesskanalService.VORGABE_KADENZ_S : b.kadenzS().longValue()));
        }
        return new FunktionZustandAbleitung.MessenEingang(st.name(), true, !"entwurf".equals(st.zustand()),
                st.archiviertAm(), fm.eingerichtetAm(), boxen, messstellen, registerZeilen, anlagen, jetzt, zone);
    }

    private static OffsetDateTime zeit(Instant t, ZoneId zone) {
        return t == null ? null : OffsetDateTime.ofInstant(t, zone);
    }

    // =========================================================================== Welt

    /** Was ein Lesezug über den Kundenbereich braucht — EINMAL gelesen; das Register erst, wenn es gefragt wird. */
    private Welt welt() {
        Map<UUID, String> namen = new HashMap<>();
        jdbc.query("SELECT id, name FROM site", rs -> {
            namen.put(rs.getObject("id", UUID.class), rs.getString("name"));
        });
        AtomicReference<List<MessstelleDto.RegisterZeile>> register = new AtomicReference<>();
        Supplier<List<MessstelleDto.RegisterZeile>> lazy = () -> register.updateAndGet(r -> r != null ? r : fakten.register());
        return new Welt(standorte.alle(), zuordnungen.alle(), funktionen.alle(), teilnahmen.alle(), namen, lazy);
    }

    private record Welt(List<StandortRepository.Standort> standorte, List<AnlageStandortRepository.Zuordnung> zuordnungen,
            List<FunktionRepository.Funktion> funktionen, List<FunktionTeilnahmeRepository.Teilnahme> teilnahmen,
            Map<UUID, String> namen, Supplier<List<MessstelleDto.RegisterZeile>> register) {

        String name(UUID site) {
            return namen.getOrDefault(site, site.toString());
        }

        StandortRepository.Standort standort(UUID id) {
            return standorte.stream().filter(s -> s.id().equals(id)).findFirst().orElse(null);
        }

        FunktionRepository.Funktion funktion(UUID id) {
            return funktionen.stream().filter(f -> f.id().equals(id)).findFirst().orElse(null);
        }

        /** Die nicht archivierte Funktion dieser Art am Standort, sonst die zuletzt archivierte. */
        FunktionRepository.Funktion funktionDerArt(UUID standortId, Funktion art) {
            FunktionRepository.Funktion archiviert = null;
            for (FunktionRepository.Funktion f : funktionen) {
                if (!f.standortId().equals(standortId) || f.funktion() != art) {
                    continue;
                }
                if (f.zustand() != Zustand.ARCHIVIERT) {
                    return f;
                }
                archiviert = f; // alle() ist nach dem Anlegen sortiert: die letzte gewinnt
            }
            return archiviert;
        }

        List<FunktionTeilnahmeRepository.Teilnahme> teilnahmenDerFunktion(UUID funktionId) {
            return teilnahmen.stream().filter(t -> t.funktionId().equals(funktionId)).toList();
        }

        /** Je Anlage der Funktion die laufende Teilnahme, sonst die zuletzt beendete — in der Reihenfolge der Aufnahme. */
        List<FunktionTeilnahmeRepository.Teilnahme> juengsteJeAnlage(UUID funktionId) {
            Map<UUID, FunktionTeilnahmeRepository.Teilnahme> out = new LinkedHashMap<>();
            for (FunktionTeilnahmeRepository.Teilnahme t : teilnahmenDerFunktion(funktionId)) {
                FunktionTeilnahmeRepository.Teilnahme da = out.get(t.siteId());
                if (da == null || da.zustand() == Zustand.ARCHIVIERT) {
                    out.put(t.siteId(), t);
                }
            }
            return List.copyOf(out.values());
        }

        /** Die laufende Teilnahme der Anlage, sonst ihre zuletzt beendete; {@code null} = nie aufgenommen. */
        FunktionTeilnahmeRepository.Teilnahme teilnahmeDerAnlage(UUID siteId) {
            FunktionTeilnahmeRepository.Teilnahme beendet = null;
            for (FunktionTeilnahmeRepository.Teilnahme t : teilnahmen) {
                if (!t.siteId().equals(siteId)) {
                    continue;
                }
                if (t.zustand() != Zustand.ARCHIVIERT) {
                    return t;
                }
                beendet = t;
            }
            return beendet;
        }

        /** Die Anlagen, die am Tag {@code heute} (einschließlich) am Standort hängen. */
        List<UUID> heuteZugeordnet(UUID standortId, LocalDate heute) {
            List<UUID> out = new ArrayList<>();
            zuordnungen.stream()
                    .filter(z -> z.standortId().equals(standortId) && !z.aufgehoben() && !z.gueltigAb().isAfter(heute)
                            && (z.gueltigBis() == null || !z.gueltigBis().isBefore(heute)))
                    .sorted(Comparator.comparing(AnlageStandortRepository.Zuordnung::gueltigAb))
                    .forEach(z -> {
                        if (!out.contains(z.siteId())) {
                            out.add(z.siteId());
                        }
                    });
            return out;
        }

        StandortRepository.Standort heutigerStandortDerAnlage(UUID siteId, Instant jetzt) {
            for (StandortRepository.Standort st : standorte) {
                LocalDate heute = LocalDate.ofInstant(jetzt, ZoneId.of(st.zeitzone()));
                if (heuteZugeordnet(st.id(), heute).contains(siteId)) {
                    return st;
                }
            }
            return null;
        }
    }
}
