package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EinmalAuftragZiel;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Canonical;
import com.voltpilot.api.measurement.MeasurementBudget.Candidate;
import com.voltpilot.api.measurement.MeasurementBudget.Estimate;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.ErwarteteKadenz.Messkanal;
import com.voltpilot.api.uems.QuelleKadenzRepository;
import com.voltpilot.api.uems.UebergabeRepository;
import java.io.PrintStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * AP-14 IP-17: explicitly started, read-only fleet audit before Edge release A.
 * This is not a Spring bean, route or scheduled job.
 */
public final class BestandsboxBudgetPruefung {

    private static final String URL = "VOLTPILOT_BUDGET_DB_URL";
    private static final String USER = "VOLTPILOT_BUDGET_DB_USER";
    private static final String PASSWORD = "VOLTPILOT_BUDGET_DB_PASSWORD";

    private BestandsboxBudgetPruefung() {}

    public record BoxId(UUID tenantId, UUID siteId, UUID deviceId) {}
    public record Urteil(BoxId box, Estimate estimate, String kleinsterAusweg) {}
    public record Ergebnis(int boxenGesamt, int plaeneGeprueft, int angenommen,
            int mitWarnung, List<Urteil> abgelehnt, Map<String, Integer> ablehnungsgruende) {}

    private record Kandidat(String pointKey, boolean custom, Candidate candidate) {}
    private record Ausweg(int differenz, String text) {}

    public static void main(String[] args) {
        String url = required(URL);
        String user = required(USER);
        String password = required(PASSWORD);
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url, user, password);
        Ergebnis result = run(dataSource, System.out);
        if (!result.abgelehnt().isEmpty()) System.exit(2);
    }

    public static Ergebnis run(DataSource dataSource, PrintStream out) {
        Ergebnis result = readOnly(dataSource, BestandsboxBudgetPruefung::pruefen);
        out.print(format(result));
        return result;
    }

    static <T> T readOnly(DataSource dataSource, Function<JdbcTemplate, T> work) {
        DataSourceTransactionManager manager = new DataSourceTransactionManager(dataSource);
        manager.setEnforceReadOnly(true);
        TransactionTemplate transaction = new TransactionTemplate(manager);
        transaction.setReadOnly(true);
        return transaction.execute(status -> {
            JdbcTemplate jdbc = new JdbcTemplate(dataSource);
            jdbc.execute("SET LOCAL row_security = off");
            jdbc.execute("SET LOCAL statement_timeout = '30s'");
            jdbc.execute("SET LOCAL lock_timeout = '5s'");
            jdbc.execute("SET LOCAL idle_in_transaction_session_timeout = '60s'");
            String readOnly = jdbc.queryForObject("SHOW transaction_read_only", String.class);
            if (!"on".equals(readOnly)) throw new IllegalStateException("READ ONLY ist nicht aktiv");
            return work.apply(jdbc);
        });
    }

    private static Ergebnis pruefen(JdbcTemplate jdbc) {
        ObjectMapper mapper = new ObjectMapper();
        MeasurementCatalog catalog = new MeasurementCatalog(mapper);
        MeasurementSelectionRepository selections = new MeasurementSelectionRepository(jdbc);
        EntityRegistryRepository entities = new EntityRegistryRepository(jdbc);
        EinmalAuftragZiel ziel = new EinmalAuftragZiel(entities, new LeadDeviceService(entities),
                new DeviceRepository(jdbc), new UebergabeRepository(jdbc));
        MeasurementSelectionService service = new MeasurementSelectionService(selections, catalog,
                mapper, new MeasurementBudgetProperties(Map.of()), ziel);
        QuelleKadenzRepository kadenzen = new QuelleKadenzRepository(jdbc);
        Instant jetzt = Instant.now();

        List<BoxId> boxen = jdbc.query("""
                SELECT tenant_id, site_id, id
                  FROM device
                 WHERE ausgebaut_am IS NULL
                 ORDER BY tenant_id, site_id, id
                """, (rs, n) -> new BoxId(rs.getObject(1, UUID.class),
                        rs.getObject(2, UUID.class), rs.getObject(3, UUID.class)));
        int geprueft = 0;
        int angenommen = 0;
        int warnungen = 0;
        List<Urteil> abgelehnt = new ArrayList<>();
        Map<String, Integer> gruende = new LinkedHashMap<>();
        for (BoxId box : boxen) {
            var state = service.forPublishing(box.deviceId());
            if (state.selections().isEmpty()) continue;
            geprueft++;
            Set<Messkanal> kanaele = new LinkedHashSet<>();
            state.selections().stream().filter(p -> p.enabled() && p.entityId() != null)
                    .forEach(p -> kanaele.add(new Messkanal(p.entityId(), p.pointKey())));
            List<MeasurementPlan.Entry> plan = MeasurementPlan.compose(state.selections(),
                    kadenzen.jeKanal(kanaele, jetzt));
            List<Kandidat> kandidaten = kandidaten(plan, catalog, mapper);
            Estimate estimate = schaetzen(kandidaten);
            if (estimate.softWarning()) warnungen++;
            if (!estimate.hardRejected()) {
                angenommen++;
                continue;
            }
            estimate.reasons().forEach(reason -> gruende.merge(reason, 1, Integer::sum));
            abgelehnt.add(new Urteil(box, estimate, kleinsterAusweg(kandidaten)));
        }
        return new Ergebnis(boxen.size(), geprueft, angenommen, warnungen,
                List.copyOf(abgelehnt), Map.copyOf(gruende));
    }

    static Estimate pruefePlan(List<MeasurementPlan.Entry> plan, MeasurementCatalog catalog,
            ObjectMapper mapper) {
        return schaetzen(kandidaten(plan, catalog, mapper));
    }

    private static List<Kandidat> kandidaten(List<MeasurementPlan.Entry> plan,
            MeasurementCatalog catalog, ObjectMapper mapper) {
        List<Kandidat> result = new ArrayList<>();
        for (MeasurementPlan.Entry entry : plan) {
            MeasurementRetention retention = new MeasurementRetention(entry.retentionClass(),
                    entry.rawRetentionDays(), entry.longTermCadenceS(), entry.longTermStrategy());
            if (entry.customDefinition() != null) {
                try {
                    Canonical custom = mapper.treeToValue(entry.customDefinition(), Canonical.class);
                    result.add(new Kandidat(entry.pointKey(), true, new Candidate(entry.pointKey(),
                            true, entry.cadenceS(), "custom:" + custom.sourceKind() + ":"
                                    + custom.address(),
                            MeasurementBudget.customRegisterRequestCostMs(), retention, "custom")));
                } catch (Exception e) {
                    result.add(new Kandidat(entry.pointKey(), true, new Candidate(entry.pointKey(),
                            true, entry.cadenceS(), null, 0, retention, "custom")));
                }
                continue;
            }
            MeasurementCatalog.Point point = catalog.resolve(entry.pointKey());
            result.add(new Kandidat(entry.pointKey(), false, new Candidate(entry.pointKey(), true,
                    entry.cadenceS(), point == null ? null : point.pollGroup(),
                    point == null ? MeasurementBudget.requestCostMs(null)
                            : MeasurementBudget.requestCostMs(point.sourceKind(), point.family()),
                    retention, point == null ? null : point.family())));
        }
        return List.copyOf(result);
    }

    private static Estimate schaetzen(List<Kandidat> kandidaten) {
        return MeasurementBudget.estimate(kandidaten.stream().map(Kandidat::candidate).toList());
    }

    private static String kleinsterAusweg(List<Kandidat> kandidaten) {
        List<Ausweg> auswege = new ArrayList<>();
        for (int i = 0; i < kandidaten.size(); i++) {
            Candidate current = kandidaten.get(i).candidate();
            if (current.cadenceS() == null || current.cadenceS() >= 86_400) continue;
            Estimate maximum = mitKadenz(kandidaten, i, 86_400);
            if (maximum.hardRejected()) continue;
            int lower = current.cadenceS() + 1;
            int upper = 86_400;
            while (lower < upper) {
                int middle = lower + (upper - lower) / 2;
                if (mitKadenz(kandidaten, i, middle).hardRejected()) lower = middle + 1;
                else upper = middle;
            }
            Estimate after = mitKadenz(kandidaten, i, lower);
            String art = kandidaten.get(i).custom() ? "Register " : "Messpunkt ";
            auswege.add(new Ausweg(lower - current.cadenceS(), art + kandidaten.get(i).pointKey()
                    + ": " + current.cadenceS() + " s → " + lower + " s ergäbe "
                    + deutsch(after.samplesPerMinute()) + " Samples/min, "
                    + deutsch(after.requestsPerMinute()) + " Anfragen/min und "
                    + deutsch(after.dutyCyclePercent()) + " % Buszeit"));
        }
        if (!auswege.isEmpty()) {
            return auswege.stream().min(Comparator.comparingInt(Ausweg::differenz)
                    .thenComparing(Ausweg::text)).orElseThrow().text();
        }
        for (int i = 0; i < kandidaten.size(); i++) {
            List<Kandidat> ohne = new ArrayList<>(kandidaten);
            Kandidat removed = ohne.remove(i);
            if (!schaetzen(ohne).hardRejected()) {
                return (removed.custom() ? "Register " : "Messpunkt ") + removed.pointKey()
                        + " abwählen";
            }
        }
        return "kein einzelner Ausweg aus dem Vertragsurteil ableitbar";
    }

    private static Estimate mitKadenz(List<Kandidat> kandidaten, int index, int cadence) {
        List<Kandidat> changed = new ArrayList<>(kandidaten);
        Kandidat item = changed.get(index);
        Candidate c = item.candidate();
        changed.set(index, new Kandidat(item.pointKey(), item.custom(), new Candidate(c.pointKey(),
                c.enabled(), cadence, c.pollGroup(), c.requestCostMs(), c.retention(), c.family())));
        return schaetzen(changed);
    }

    static String format(Ergebnis result) {
        StringBuilder out = new StringBuilder();
        out.append("TEIL A — Umfang\n")
                .append("boxen_gesamt: ").append(result.boxenGesamt()).append('\n')
                .append("plaene_geprueft: ").append(result.plaeneGeprueft()).append('\n')
                .append("boxen_ohne_plan: ")
                .append(result.boxenGesamt() - result.plaeneGeprueft()).append("\n\n")
                .append("TEIL B — Vertragsurteil\n")
                .append("angenommen: ").append(result.angenommen()).append('\n')
                .append("mit_warnung: ").append(result.mitWarnung()).append('\n')
                .append("ABGELEHNT: ").append(result.abgelehnt().size()).append("\n\n")
                .append("TEIL C — Ablehnungsgründe\n");
        if (result.ablehnungsgruende().isEmpty()) out.append("keine: 0\n");
        else result.ablehnungsgruende().entrySet().stream().sorted(Map.Entry.comparingByKey())
                .forEach(e -> out.append(e.getKey()).append(": ").append(e.getValue()).append('\n'));
        out.append("\nTEIL D — Abgelehnte Boxen (nur intern)\n");
        if (result.abgelehnt().isEmpty()) out.append("keine\n");
        for (Urteil urteil : result.abgelehnt()) {
            out.append("tenant_id=").append(urteil.box().tenantId())
                    .append(" site_id=").append(urteil.box().siteId())
                    .append(" device_id=").append(urteil.box().deviceId())
                    .append(" | grund=").append(String.join(" ", urteil.estimate().reasons()))
                    .append(" | kleinster_ausweg=").append(urteil.kleinsterAusweg()).append('\n');
        }
        return out.toString();
    }

    private static String deutsch(double value) {
        return String.format(Locale.GERMANY, "%.1f", value);
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Pflichtvariable fehlt: " + name);
        }
        return value;
    }
}
