# edge/node-red - Edge Runtime (thin)

**Runtime:** Node-RED (container, ARM+x86)
**Responsibility (architecture section 6):** read inverters via Modbus TCP/SunSpec (incl. the observed effective §14a limit), publish telemetry over mTLS MQTT, execute the retained cloud schedule slot-by-slot, and hold a self-consumption default on outage. Intelligence stays in the cloud; the edge is deliberately thin.

## The five thin flows (placeholders in `flows.json`)

1. **Acquisition** - Modbus TCP/SunSpec poll incl. the effective grid limit.
2. **Publish** - mTLS MQTT QoS1 to EMQX.
3. **Schedule-Exec** - apply the retained schedule, 15-min slots.
4. **Default-Watchdog** - self-consumption default on cloud/schedule outage.
5. **Guards** - local plausibility checks before any write.

## Run (dev)

```bash
docker build -t voltpilot-edge edge/node-red
docker run --rm -p 1880:1880 voltpilot-edge   # editor at http://localhost:1880
```

## Status

Documentation/placeholder only - no working Modbus. Production: no inbound ports, x.509 device identity, OTA via Mender (A/B + rollback). All future work.
