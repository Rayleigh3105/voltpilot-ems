// Test fixture only: same exact committed main set as UemsProduktionsreihenfolgeMigrationTest.
import java.util.Map;
import org.flywaydb.core.Flyway;

class FixtureMigrate {
    public static void main(String[] args) {
        Flyway.configure()
            .dataSource(System.getenv("FIXTURE_JDBC"), "voltpilot", "fixture_password")
            .locations("filesystem:" + System.getenv("FIXTURE_MIGRATIONS"))
            .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "fixture_app_password",
                                "adminDbUser", "voltpilot_admin", "adminDbPassword", "fixture_admin_password"))
            .load().migrate();
    }
}
