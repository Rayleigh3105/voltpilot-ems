package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BestandsuebernahmeAbleitung.Art;
import com.voltpilot.api.uems.BestandsuebernahmeAbleitung.Eingang;
import com.voltpilot.api.uems.BestandsuebernahmeAbleitung.Plan;
import com.voltpilot.api.uems.BestandsuebernahmeAbleitung.Vorschlag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.OrtArt;
import com.voltpilot.api.uems.StandortLesemodell.Adresse;
import com.voltpilot.api.uems.StandortRepository.NeuerStandort;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Wendet die Regel der BESTANDSÜBERNAHME ({@link BestandsuebernahmeAbleitung}, UEMS AP-02
 * IP-9) auf EINEN Kundenbereich an — den im {@link TenantContext}, unter RLS, in EINER
 * Transaktion: entweder alles oder nichts.
 *
 * <ul>
 *   <li>{@code standort_anlegen}: das nächste Kurzzeichen ({@link OrtKurzzeichen}), der
 *       Standort als Entwurf ohne Adresse, seine Zuordnung ab dem Tag des Anlegens der Anlage
 *       ({@link AnlageStandortService#zuordnen}) — und je Standort und je Zuordnung EIN
 *       Protokolleintrag „VoltPilot (Bestandsübernahme)" ({@link ProtokollAkteur#bestandsuebernahme}),
 *       beide mit „gilt ab" = dem Tag der Zuordnung (A5: rückwirkend). Der Standort besteht
 *       dann ab diesem Tag (StandortLesemodell: das früheste Gebundene, Vektor-Fall
 *       {@code a5-bestand-standort-besteht-seit-der-anlage}); sein {@code created_at} bleibt
 *       der ehrliche Zeitpunkt des Anlegens.</li>
 *   <li>{@code vorschlagen}: je Anlage ohne Vorschlag eine Zeile in {@code standort_vorschlag}
 *       — kein Protokoll, keine Zuordnung.</li>
 *   <li>{@code nichts}: nichts.</li>
 * </ul>
 *
 * <p><b>Was er nie berührt</b> (A5: „Cockpit, Fahrplan, Erlöse, Steuerung byte-identisch;
 * kein Kommando, keine Topic-Änderung"): keine Anlage, kein Gerät, keine Komponente, kein
 * Fahrplan, kein Push, kein Kommando — er kennt keinen Publisher und schreibt nur in
 * {@code standort}, {@code anlage_standort}, {@code ort_aenderung}, {@code ort_kurzzeichen},
 * {@code ort_kurzzeichen_seq} und {@code standort_vorschlag}. Die einzige sichtbare Folge in
 * den Antworten der Anlage ist das additive Feld {@code standort} (IP-3) für eine
 * zugeordnete Anlage.
 *
 * <p>Die Zeile des Unternehmens wird zuerst gesperrt ({@link UnternehmenRepository#sperren}):
 * zwei gleichzeitige Läufe zählen nacheinander, der zweite sieht den Standort des ersten.
 */
@Service
public class BestandsuebernahmeService {

    private final JdbcTemplate jdbc;
    private final UnternehmenRepository unternehmen;
    private final StandortRepository standorte;
    private final StandortVorschlagRepository vorschlaege;
    private final OrtKurzzeichen kurzzeichen;
    private final OrtProtokoll protokoll;
    private final AnlageStandortService anlageStandort;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public BestandsuebernahmeService(JdbcTemplate jdbc, UnternehmenRepository unternehmen,
            StandortRepository standorte, StandortVorschlagRepository vorschlaege, OrtKurzzeichen kurzzeichen,
            OrtProtokoll protokoll, AnlageStandortService anlageStandort,
            PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.unternehmen = unternehmen;
        this.standorte = standorte;
        this.vorschlaege = vorschlaege;
        this.kurzzeichen = kurzzeichen;
        this.protokoll = protokoll;
        this.anlageStandort = anlageStandort;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests: die Uhr, an der der Eintragstag des Protokolls hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Was ein Kundenbereich bekam. {@code standortId} nur bei {@code standort_anlegen};
     * {@code vorschlaege} = die tatsächlich geschriebenen Zeilen.
     */
    public record Ergebnis(Plan plan, UUID standortId, int zuordnungen, int vorschlaege) {

        /** Hat der Lauf etwas geschrieben? Ein zweiter Lauf: nie. */
        public boolean geaendert() {
            return standortId != null || zuordnungen > 0 || vorschlaege > 0;
        }
    }

    /** Eine Anlage, wie die Regel sie liest. */
    private record Anlage(UUID id, String name, OffsetDateTime angelegtUm) {}

    /** Die Übernahme für den Kundenbereich im {@link TenantContext}. */
    public Ergebnis uebernehmen() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw new IllegalStateException("Bestandsübernahme ohne Kundenbereich");
        }
        return transaktion.execute(s -> uebernehmen(tenant));
    }

    private Ergebnis uebernehmen(UUID tenant) {
        Optional<UUID> unternehmenId = unternehmen.sperren();
        Optional<UnternehmenRepository.Unternehmen> u = unternehmenId.isEmpty() ? Optional.empty()
                : unternehmen.desKundenbereichs();
        List<StandortRepository.Standort> st = standorte.alle();
        List<Anlage> anlagen = jdbc.query("SELECT id, name, created_at FROM site ORDER BY created_at, id",
                (rs, n) -> new Anlage(rs.getObject("id", UUID.class), rs.getString("name"),
                        rs.getObject("created_at", OffsetDateTime.class)));
        List<UUID> mitVorschlag = vorschlaege.alle().stream().map(StandortVorschlagRepository.Vorschlag::siteId)
                .toList();

        Map<String, Anlage> jeKennzeichen = new HashMap<>();
        anlagen.forEach(a -> jeKennzeichen.put(a.id().toString(), a));
        Plan plan = BestandsuebernahmeAbleitung.plan(new Eingang(
                u.map(x -> new BestandsuebernahmeAbleitung.Unternehmen(x.zeitzone())).orElse(null),
                anlagen.stream().map(a -> new BestandsuebernahmeAbleitung.Anlage(a.id().toString(), a.name(),
                        a.angelegtUm())).toList(),
                st.stream().map(x -> new BestandsuebernahmeAbleitung.Standort(x.kurzzeichen(),
                        x.archiviertAm() != null)).toList(),
                mitVorschlag.stream().map(UUID::toString).toList()));

        if (plan.art() == Art.STANDORT_ANLEGEN) {
            Instant jetzt = uhr.instant();
            BestandsuebernahmeAbleitung.NeuerStandort ns = plan.standort();
            Anlage anlage = jeKennzeichen.get(plan.zuordnung().anlage());
            ZoneId zone = ZoneId.of(ns.zeitzone());
            ProtokollAkteur wer = ProtokollAkteur.bestandsuebernahme();
            String kz = kurzzeichen.vergeben(tenant, OrtArt.STANDORT);
            UUID standortId = standorte.anlegen(new NeuerStandort(tenant, unternehmenId.get(), ns.name(), kz,
                    null, null, null, null, ns.zeitzone(), null, null, null, null, ns.zustand(), null), jetzt);
            protokoll.eintragen(tenant, "standort", standortId, "angelegt", null,
                    StandortService.protokollFelder(kz, ns.name(), new Adresse(null, null, null, null),
                            ns.zeitzone(), null, null, null, ns.zustand()),
                    plan.zuordnung().gueltigAb(), zone, jetzt, wer);
            StandortRepository.Standort neu = standorte.finde(standortId).orElseThrow();
            anlageStandort.zuordnen(tenant, anlage.id(), anlage.name(), neu, plan.zuordnung().gueltigAb(), jetzt,
                    wer);
            return new Ergebnis(plan, standortId, 1, 0);
        }
        int geschrieben = 0;
        for (Vorschlag v : plan.vorschlaege()) {
            if (vorschlaege.anlegen(tenant, UUID.fromString(v.anlage()), v.name(),
                    u.orElseThrow().zeitzone(), v.gueltigAb())) {
                geschrieben++;
            }
        }
        return new Ergebnis(plan, null, 0, geschrieben);
    }
}
