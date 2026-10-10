'use strict';

// In-process read simulation for MeasurementEdgeProvenanceTest: no MQTT,
// Modbus server, Docker or physical device. Uses the production runtime.
const { MeasurementRuntime } = require('../measurement-runtime');
const config = require('../../../../docs/contracts/v2/examples/mqtt-measurement-config.valid.json');
const entity = '00000000-0000-0000-0000-0000000000a1';

(async () => {
  const batches = [];
  for (const bound of [true, false]) {
    const runtime = new MeasurementRuntime({ readModbus:async () => [50] }, (topic, payload) => {
      if (topic === 'edge/measurements/samples') batches.push(payload);
    }, () => new Date('2026-08-25T12:00:10Z'));
    const plan = runtime.apply({ ...config, selections:config.selections.map((s) => ({ ...s,
      ...(bound ? { entity_id:entity } : {}),
    })) }, { binding:{ entities:{[entity]:{entity_type:'battery-hybrid'}}, sources:{} } });
    if (!plan.applied) throw new Error('simulation plan rejected');
    await runtime.tick();
  }
  process.stdout.write(JSON.stringify(batches));
})().catch((error) => { console.error(error); process.exitCode = 1; });
