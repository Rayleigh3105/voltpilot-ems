package com.voltpilot.api;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.function.Consumer;

/** Complete 11-table OCPP seed used by every deletion/offboarding regression. */
final class OcppTestData {
    static final String[] TABLES = {
            "ocpp_station", "ocpp_connector_state", "ocpp_protocol_event",
            "ocpp_connector_status_event", "ocpp_authorization_event", "ocpp_transaction",
            "ocpp_meter_sample", "ocpp_station_status_event", "ocpp_configuration_key",
            "ocpp_configuration_unknown_key", "ocpp_station_capability"
    };

    private OcppTestData() {}

    static void seed(Consumer<String> exec, String tenant, String site, String device) {
        String cp = "DELETE-" + device.substring(0, 8);
        String event = UUID.nameUUIDFromBytes((device + ":ocpp-delete-seed")
                .getBytes(StandardCharsets.UTF_8)).toString();
        exec.accept("INSERT INTO ocpp_station (device_id,charge_point_id,tenant_id,site_id,updated_at) "
                + values(device, cp, tenant, site) + ",now())");
        exec.accept("INSERT INTO ocpp_connector_state (device_id,charge_point_id,connector_id,tenant_id,"
                + "site_id,status,error_code,reported_at) VALUES ('" + device + "','" + cp + "',1,'"
                + tenant + "','" + site + "','Available','NoError',now())");
        exec.accept("INSERT INTO ocpp_protocol_event (occurred_at,event_id,tenant_id,site_id,device_id,"
                + "charge_point_id,direction,message_type,action,payload) VALUES (now(),'" + event + "','"
                + tenant + "','" + site + "','" + device + "','" + cp
                + "','internal','Event','DeletionSeed','{}')");
        exec.accept("INSERT INTO ocpp_connector_status_event (occurred_at,event_id,tenant_id,site_id,"
                + "device_id,charge_point_id,connector_id,status,error_code) VALUES (now(),'" + event + "','"
                + tenant + "','" + site + "','" + device + "','" + cp + "',1,'Available','NoError')");
        exec.accept("INSERT INTO ocpp_authorization_event (occurred_at,event_id,tenant_id,site_id,device_id,"
                + "charge_point_id,correlation_id,id_tag_ref) VALUES (now(),'" + event + "','" + tenant
                + "','" + site + "','" + device + "','" + cp + "','delete-seed','tagref_delete')");
        exec.accept("INSERT INTO ocpp_transaction (device_id,charge_point_id,transaction_id,tenant_id,site_id,"
                + "connector_id,started_at,meter_start,start_id_tag_ref,transaction_data,updated_at) VALUES ('"
                + device + "','" + cp + "',1,'" + tenant + "','" + site
                + "',1,now(),1,'tagref_delete','[]',now())");
        exec.accept("INSERT INTO ocpp_meter_sample (sampled_at,event_id,meter_value_index,sampled_value_index,"
                + "tenant_id,site_id,device_id,charge_point_id,connector_id,source,point_key,measurand,context,"
                + "value_format,phase,location,unit,value_text) VALUES (now(),'" + event + "',0,0,'" + tenant
                + "','" + site + "','" + device + "','" + cp + "',1,'MeterValues','delete-point',"
                + "'Power.Active.Import','Sample.Periodic','Raw','L1','Outlet','W','1')");
        exec.accept("INSERT INTO ocpp_station_status_event (occurred_at,event_id,tenant_id,site_id,device_id,"
                + "charge_point_id,status_kind,status) VALUES (now(),'" + event + "','" + tenant + "','"
                + site + "','" + device + "','" + cp + "','diagnostics','Idle')");
        exec.accept("INSERT INTO ocpp_configuration_key (device_id,charge_point_id,configuration_key,tenant_id,"
                + "site_id,value,readonly,reported_at) VALUES ('" + device + "','" + cp + "','Rig.Mode','"
                + tenant + "','" + site + "','seed',true,now())");
        exec.accept("INSERT INTO ocpp_configuration_unknown_key (device_id,charge_point_id,configuration_key,"
                + "tenant_id,site_id,reported_at) VALUES ('" + device + "','" + cp + "','Unknown.Seed','"
                + tenant + "','" + site + "',now())");
        exec.accept("INSERT INTO ocpp_station_capability (device_id,charge_point_id,feature_profile,tenant_id,"
                + "site_id,reported_at) VALUES ('" + device + "','" + cp + "','SmartCharging','" + tenant
                + "','" + site + "',now())");
    }

    private static String values(String device, String cp, String tenant, String site) {
        return "VALUES ('" + device + "','" + cp + "','" + tenant + "','" + site + "'";
    }

    static String countByDeviceSql(String device) {
        return countSql("device_id", device);
    }

    static String countBySiteSql(String site) {
        return countSql("site_id", site);
    }

    static String countByTenantSql(String tenant) {
        return countSql("tenant_id", tenant);
    }

    private static String countSql(String column, String id) {
        StringBuilder sql = new StringBuilder("SELECT sum(n) FROM (");
        for (int i = 0; i < TABLES.length; i++) {
            if (i > 0) sql.append(" UNION ALL ");
            sql.append("SELECT count(*) n FROM ").append(TABLES[i])
                    .append(" WHERE ").append(column).append(" = '").append(id).append("'");
        }
        return sql.append(") ocpp_counts").toString();
    }
}
