package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.FunktionZustandAbleitung.BestandErgebnis;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Funktion;
import com.voltpilot.api.uems.FunktionZustandAbleitung.StandortErgebnis;
import com.voltpilot.api.uems.FunktionZustandAbleitung.TeilnahmeStand;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Zustand;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Der UMSTIEG „Bestand → Zustand“ (UEMS AP-01 IP-2, §4.3/§6.2, W5, A11) für EINEN Kundenbereich —
 * den im {@link TenantContext}, unter RLS, in EINER Transaktion: entweder alles oder nichts.
 *
 * <p>Je nicht archiviertem Standort: jede HEUTE zugeordnete Anlage ohne jede Teilnahme bekommt
 * ihre Bestandsfakten ({@link FunktionBestandFakten}) durch die Vertragsregel
 * {@link FunktionZustandAbleitung#bestand} — {@code aktiv} (übernommen, seit der frühesten
 * laufenden Betriebsweise) oder {@code eingerichtet} wird eine Teilnahme mit
 * {@code uebernommen = true}, {@code kein_objekt} bleibt ohne Zeile („reine Messung“). Hat ein
 * Standort danach mindestens eine Teilnahme, trägt seine Funktion „Steuern &amp; Optimieren“ den
 * HÖCHSTEN Zustand aller ihrer Teilnahmen ({@link FunktionZustandAbleitung#standort}) — angelegt,
 * wenn es sie noch nicht gibt, sonst nachgezogen.
 *
 * <p><b>Die Wächter.</b>
 * <ul>
 *   <li><b>idempotent</b> — eine Anlage mit IRGENDEINER Teilnahme (auch einer beendeten) wird nie
 *       wieder betrachtet: ein zweiter Lauf schreibt nichts, und was der Kunde später mit einer
 *       Teilnahme tut, bleibt stehen.</li>
 *   <li><b>lesend gegenüber dem Bestand</b> (A11: „nichts wird geschaltet“) — er schreibt NUR in
 *       {@code funktion} und {@code funktion_teilnahme}, kennt keinen Publisher, legt keinen
 *       Ruhe-Eintrag an und ändert kein {@code site_profile_state}.</li>
 *   <li><b>ohne Standort nichts</b> — eine Anlage, die (noch) keinem Standort zugeordnet ist
 *       (mehrere Anlagen: nur Vorschläge, AP-02 IP-9), hat keinen Geltungsbereich und wartet auf
 *       den nächsten Lauf nach ihrer Zuordnung.</li>
 *   <li><b>kein Messen</b> — „Messen &amp; Auswerten“ bekommt beim Umstieg kein Objekt (A11:
 *       „Funktion messen = kein Objekt“); seine Einrichtung ist ein eigener Weg.</li>
 * </ul>
 *
 * <p>Die Zeile des Unternehmens wird zuerst gesperrt ({@link UnternehmenRepository#sperren}): zwei
 * gleichzeitige Läufe zählen nacheinander, der zweite sieht die Teilnahmen des ersten.
 */
@Service
public class FunktionBestandService {

    /** „VoltPilot (Bestandsübernahme)“ — derselbe Urheber wie die Standort-Übernahme. */
    static final String WER = OrtProtokoll.akteurName(ProtokollAkteur.bestandsuebernahme());

    private final JdbcTemplate jdbc;
    private final UnternehmenRepository unternehmen;
    private final StandortRepository standorte;
    private final AnlageStandortRepository zuordnungen;
    private final FunktionRepository funktionen;
    private final FunktionTeilnahmeRepository teilnahmen;
    private final FunktionBestandFakten fakten;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public FunktionBestandService(JdbcTemplate jdbc, UnternehmenRepository unternehmen,
            StandortRepository standorte, AnlageStandortRepository zuordnungen, FunktionRepository funktionen,
            FunktionTeilnahmeRepository teilnahmen, FunktionBestandFakten fakten,
            PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.unternehmen = unternehmen;
        this.standorte = standorte;
        this.zuordnungen = zuordnungen;
        this.funktionen = funktionen;
        this.teilnahmen = teilnahmen;
        this.fakten = fakten;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests: die Uhr, an der „heute zugeordnet“ und die Zeitstempel hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Was ein Kundenbereich bekam; ein zweiter Lauf: alles null. */
    public record Ergebnis(int funktionenAngelegt, int funktionenNachgezogen, int teilnahmenAktiv,
            int teilnahmenEingerichtet) {

        public boolean geaendert() {
            return funktionenAngelegt > 0 || funktionenNachgezogen > 0 || teilnahmenAktiv > 0
                    || teilnahmenEingerichtet > 0;
        }
    }

    /** Der Umstieg für den Kundenbereich im {@link TenantContext}. */
    public Ergebnis uebernehmen() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new IllegalStateException("Funktions-Übernahme ohne Kundenbereich");
        }
        return transaktion.execute(s -> uebernehmen(tenant, null));
    }

    /**
     * Derselbe Umstieg wie beim Start-Läufer, begrenzt auf die gerade einem Standort zugeordneten
     * Anlagen. Die ausdrücklich übergebene Zuordnung darf künftig beginnen: Bestätigen und erste
     * Zuordnung schließen den Halb-Zustand sofort, während der Start-Läufer weiterhin nur die am
     * Lauftag gültigen Zuordnungen findet. Fakten und Zustandsableitung bleiben dieselben.
     * Eine vorhandene äußere Transaktion wird dabei beibehalten.
     */
    public Ergebnis uebernehmen(Set<UUID> anlagen) {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new IllegalStateException("Funktions-Übernahme ohne Kundenbereich");
        }
        Set<UUID> genauDiese = Set.copyOf(anlagen);
        if (genauDiese.isEmpty()) {
            return new Ergebnis(0, 0, 0, 0);
        }
        return transaktion.execute(s -> uebernehmen(tenant, genauDiese));
    }

    private record Neu(UUID siteId, BestandErgebnis ergebnis) {}

    private Ergebnis uebernehmen(UUID tenant, Set<UUID> anlagen) {
        unternehmen.sperren();
        Instant jetzt = uhr.instant();
        Map<UUID, String> namen = new HashMap<>();
        jdbc.query("SELECT id, name FROM site", rs -> {
            namen.put(rs.getObject("id", UUID.class), rs.getString("name"));
        });
        Set<UUID> schonTeilnahme = new HashSet<>();
        teilnahmen.alle().forEach(t -> schonTeilnahme.add(t.siteId()));
        List<AnlageStandortRepository.Zuordnung> alleZuordnungen = zuordnungen.alle();

        int angelegt = 0;
        int nachgezogen = 0;
        int aktiv = 0;
        int eingerichtet = 0;
        for (StandortRepository.Standort st : standorte.alle()) {
            if (st.archiviertAm() != null) {
                continue;
            }
            ZoneId zone = ZoneId.of(st.zeitzone());
            LocalDate heute = LocalDate.ofInstant(jetzt, zone);
            List<Neu> neu = new ArrayList<>();
            List<UUID> zugeordneteAnlagen = anlagen == null
                    ? heuteZugeordnet(alleZuordnungen, st.id(), heute)
                    : offenZugeordnet(alleZuordnungen, st.id(), anlagen);
            for (UUID site : zugeordneteAnlagen) {
                if (!namen.containsKey(site) || schonTeilnahme.contains(site)) {
                    continue;
                }
                BestandErgebnis b = FunktionZustandAbleitung.bestand(fakten.lesen(tenant, site, namen.get(site)), zone);
                if (b.zustand() != Zustand.KEIN_OBJEKT) {
                    neu.add(new Neu(site, b));
                }
            }
            if (neu.isEmpty()) {
                continue;
            }

            Optional<FunktionRepository.Funktion> vorhanden = funktionen.laufende(st.id(), Funktion.STEUERN);
            List<TeilnahmeStand> stand = new ArrayList<>();
            vorhanden.ifPresent(f -> teilnahmen.derFunktion(f.id()).forEach(t -> stand.add(new TeilnahmeStand(
                    namen.getOrDefault(t.siteId(), t.siteId().toString()), t.zustand(), t.seit(), List.of()))));
            neu.forEach(n -> stand.add(new TeilnahmeStand(namen.get(n.siteId()), n.ergebnis().zustand(),
                    n.ergebnis().gestartetAm(), List.of())));
            StandortErgebnis s = FunktionZustandAbleitung.standort(stand, zone);

            UUID funktionId;
            if (vorhanden.isEmpty()) {
                funktionId = funktionen.anlegen(tenant, st.id(), Funktion.STEUERN, funktionStand(s, null), WER, jetzt);
                angelegt++;
            } else {
                funktionId = vorhanden.get().id();
                FunktionRepository.Stand vorher = alsStand(vorhanden.get());
                FunktionRepository.Stand nachher = funktionStand(s, vorhanden.get());
                if (!vorher.equals(nachher)) {
                    funktionen.zustandSetzen(funktionId, nachher, WER, jetzt);
                    nachgezogen++;
                }
            }
            for (Neu n : neu) {
                BestandErgebnis b = n.ergebnis();
                FunktionTeilnahmeRepository.Stand t = b.zustand() == Zustand.AKTIV
                        ? new FunktionTeilnahmeRepository.Stand(Zustand.AKTIV, null, b.gestartetAm(), null, null)
                        : new FunktionTeilnahmeRepository.Stand(Zustand.EINGERICHTET, null, null, null, null);
                if (teilnahmen.anlegen(tenant, funktionId, n.siteId(), t, true, jetzt).isPresent()) {
                    if (b.zustand() == Zustand.AKTIV) {
                        aktiv++;
                    } else {
                        eingerichtet++;
                    }
                }
            }
        }
        return new Ergebnis(angelegt, nachgezogen, aktiv, eingerichtet);
    }

    /** Die Anlagen, die am Tag {@code heute} (einschließlich) an diesem Standort hängen. */
    private static List<UUID> heuteZugeordnet(List<AnlageStandortRepository.Zuordnung> alle, UUID standortId,
            LocalDate heute) {
        List<UUID> anlagen = new ArrayList<>();
        for (AnlageStandortRepository.Zuordnung z : alle) {
            if (z.standortId().equals(standortId) && !z.aufgehoben() && !z.gueltigAb().isAfter(heute)
                    && (z.gueltigBis() == null || !z.gueltigBis().isBefore(heute))
                    && !anlagen.contains(z.siteId())) {
                anlagen.add(z.siteId());
            }
        }
        return anlagen;
    }

    /** Gerade bestätigte offene Zuordnungen, auch wenn ihr erster Geltungstag noch bevorsteht. */
    private static List<UUID> offenZugeordnet(List<AnlageStandortRepository.Zuordnung> alle, UUID standortId,
            Set<UUID> gesucht) {
        List<UUID> anlagen = new ArrayList<>();
        for (AnlageStandortRepository.Zuordnung z : alle) {
            if (z.standortId().equals(standortId) && gesucht.contains(z.siteId()) && !z.aufgehoben()
                    && z.gueltigBis() == null && !anlagen.contains(z.siteId())) {
                anlagen.add(z.siteId());
            }
        }
        return anlagen;
    }

    /**
     * Die Zeitpunkte der Funktion aus dem abgeleiteten Standort-Zustand: {@code seit} gehört zum
     * Zustand; was eine vorhandene Funktion schon weiß (wann sie eingerichtet oder aktiv wurde),
     * bleibt stehen, solange der neue Zustand es nicht selbst sagt.
     */
    private static FunktionRepository.Stand funktionStand(StandortErgebnis s, FunktionRepository.Funktion vorher) {
        Instant eingerichtetAm = vorher == null ? null : vorher.eingerichtetAm();
        Instant aktivSeit = vorher == null ? null : vorher.aktivSeit();
        Instant angehaltenSeit = null;
        switch (s.zustand()) {
            case EINGERICHTET -> eingerichtetAm = s.seit();
            case AKTIV -> aktivSeit = s.seit();
            case ANGEHALTEN -> angehaltenSeit = s.seit();
            default -> throw new IllegalStateException("übernommen wird nie " + s.zustand().code());
        }
        return new FunktionRepository.Stand(s.zustand(), eingerichtetAm, aktivSeit, angehaltenSeit, null);
    }

    private static FunktionRepository.Stand alsStand(FunktionRepository.Funktion f) {
        return new FunktionRepository.Stand(f.zustand(), f.eingerichtetAm(), f.aktivSeit(), f.angehaltenSeit(),
                f.archiviertAm());
    }
}
