'use strict';

const net = require('net');
const http = require('http');
const https = require('https');
const losslessJSON = require('../lib/lossless-json');

const CONFIG = 'edge/measurements/config';
const INVERTER = 'edge/inverter/config';
const OCPP = 'edge/measurements/ocpp-meter-values';
const OCPP_RESULT = 'edge/measurements/ocpp-configuration-result';
const OCPP_CONFIG = 'edge/measurements/ocpp-configuration';
const CONTROL = 'edge/setpoint';

function request(host, port, frame, expectedLength, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let data = Buffer.alloc(0); let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(timeoutMs || 3000, () => finish(new Error('Zeitüberschreitung')));
    socket.on('connect', () => socket.write(frame));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      const length = expectedLength(data);
      if (length && data.length >= length) finish(null, data.subarray(0, length));
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => finish(new Error('Verbindung vor Antwort beendet')));
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { timeout: 4000, rejectUnauthorized: false }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 1024 * 1024) body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(losslessJSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
  });
}

function shapeShellyStatus(points, status) {
  const selector=points[0]&&points[0].selector||'';
  const endpoint=selector.split('#')[0];
  const method=endpoint.split('?')[0];
  if (method==='Shelly.GetDeviceInfo') return status;
  const prefixes=method.replace(/\.GetStatus$/,'').split('|').map((value)=>value.toLowerCase());
  if (endpoint.includes('id=*')) {
    const responses=[];
    for (const [key,value] of Object.entries(status||{})) {
      const split=key.lastIndexOf(':');
      const prefix=(split<0?key:key.slice(0,split)).toLowerCase();
      const id=Number(split<0?'':key.slice(split+1));
      if (prefixes.includes(prefix)&&Number.isInteger(id)&&value&&typeof value==='object') {
        responses.push(Object.assign({id},value));
      }
    }
    return {__vpResponses:responses};
  }
  for (const prefix of prefixes) if (status&&status[prefix]!==undefined) return status[prefix];
  return status;
}

function inverterJSONEndpoint(selector, serial) {
  let endpoint=String(selector||'').split('#')[0];
  if (!endpoint.includes('{serial}')) return endpoint;
  if (!serial) throw new Error('keine Seriennummer');
  return endpoint.replaceAll('{serial}',encodeURIComponent(String(serial)));
}

async function discoverSunSpec(read) {
  for (const candidate of [40000, 50000, 0]) {
    let sid;
    try { sid = await read({ start:candidate, count:2, source_kind:'sunspec_model' }); }
    catch (_) { continue; }
    if (!Array.isArray(sid) || sid[0] !== 0x5375 || sid[1] !== 0x6e53) continue;
    const models = {}; let address = candidate + 2;
    for (let i=0;i<256 && address-candidate<8192;i++) {
      const header = await read({ start:address, count:2, source_kind:'sunspec_model' });
      if (!Array.isArray(header) || header.length<2) break;
      const id=header[0], length=header[1];
      if (id===0xffff) break;
      if (length>8192) break;
      const model={ base:address+2, length };
      // Model 160's N field is at relative offset 8. Read that live field;
      // never infer a module count from a length or portal selection.
      if (id===160) {
        const count=await read({start:model.base+8,count:1,source_kind:'sunspec_model'});
        const n=Array.isArray(count)?Number(count[0]):NaN;
        if (Number.isInteger(n)&&n>=0&&10+n*20<=length) model.moduleCount=n;
      }
      models[id]=model; address+=2+length;
    }
    return { models };
  }
  return { models:{} };
}

module.exports = function (RED) {
  function VpMeasurements(config) {
    RED.nodes.createNode(this, config);
    const node = this; const core = RED.nodes.getNode(config.core);
    if (!core) { node.status({ fill:'red', shape:'ring', text:'kein vp-core' }); return; }
    const global = node.context().global;
    const Runtime = global.get('vpMeasurementRuntime');
    const modbus = global.get('vpMeasurementModbus');
    const deye = global.get('vpMeasurementDeye');
    const busArbiter = global.get('vpSharedBusArbiter');
    if (!Runtime || !Runtime.MeasurementRuntime || !modbus || !deye || !busArbiter) {
      node.status({ fill:'red', shape:'ring', text:'Messruntime fehlt' }); return;
    }
    let inverter = null; let txid = 0; let sequence = 0; let desired = null;
    const ocppPending = new Map();
    const io = {
      // The setpoint lane announces control before the existing write flow
      // touches the device. Measurement requests yield a bounded exclusive
      // window, so control communication cannot queue behind catalog polling.
      runBusTask: async (_priority, run) => {
        const conn=inverter&&inverter.connection||{};
        return busArbiter.runPoll(busArbiter.targetKey(conn,
          inverter&&inverter.communication==='solarman_v5'?8899:502),run);
      },
      readModbus: async ({ start, count, source_kind }) => {
        const conn = inverter && inverter.connection || {};
        if (!conn.ip) throw new Error('keine Geräteverbindung');
        if (inverter.communication === 'solarman_v5') {
          const frame = deye.buildReadRequest({ loggerSerial:conn.serial,
            sequence:sequence++, slaveId:Number(conn.mb_slave_id) || 1, startReg:start, count });
          const response = await request(conn.ip, Number(conn.port) || 8899, frame,
            deye.expectedFrameLength, 4000);
          return deye.readRegistersFromResponse(response, { expectLoggerSerial:conn.serial,
            expectSlaveId:Number(conn.mb_slave_id) || 1 });
        }
        const fc = source_kind === 'modbus_input' ? 4 : 3;
        const requestId = txid++ & 0xffff;
        const frame = modbus.buildReadRequest({ txid:requestId, unitId:Number(conn.unit_id) || 1,
          addr:start, count, fc });
        const response = await request(conn.ip, Number(conn.port) || 502, frame,
          modbus.expectedFrameLength, 3000);
        return modbus.parseReadResponse(response, { expectTxid:requestId,
          expectUnit:Number(conn.unit_id) || 1, expectFn:fc });
      },
      readJSON: async ({ filter, points }) => {
        const conn = inverter && inverter.connection || {};
        if (!conn.ip) throw new Error('keine Geräteverbindung');
        const source = points[0].source_kind;
        const endpoint=inverterJSONEndpoint(points[0].selector,conn.serial);
        const path = source === 'http_api_key' ? '/api/status'
          : source === 'rest_json' ? endpoint
          : endpoint.startsWith('Shelly.GetDeviceInfo') ? '/rpc/Shelly.GetDeviceInfo'
          : '/rpc/Shelly.GetStatus';
        const url = new URL((conn.insecure_tls ? 'https' : 'http') + '://' + conn.ip + ':'
          + (Number(conn.port) || (conn.insecure_tls ? 443 : 80)) + path);
        if (filter) url.searchParams.set('filter', filter);
        const payload=await getJSON(url);
        return source==='rpc_json'?shapeShellyStatus(points,payload):payload;
      },
      ocppCapability: { supported:true, readonly:false, maxLength:1024 },
      applyOcppConfiguration: ({ revision, configuration }) => new Promise((resolve) => {
        ocppPending.set(revision, resolve);
        core.client.publish(OCPP_CONFIG, JSON.stringify({ revision, values:configuration }),
          { qos:1, retain:true });
      }),
    };
    const runtime = new Runtime.MeasurementRuntime(io, (topic, payload, retained) => {
      core.client.publish(topic, JSON.stringify(payload), { qos:1, retain:!!retained });
    });
    const measurementOptions = () => ({
      byteOrder:inverter && inverter.connection && inverter.connection.byte_order,
    });
    const subscribe = () => core.client.subscribe([CONFIG, INVERTER, OCPP, OCPP_RESULT, CONTROL], { qos:1 });
    if (core.client.connected) subscribe();
    core.client.on('connect', subscribe);
    const onMessage = (topic, raw) => {
      try {
        const value = JSON.parse(raw.toString());
        if (topic === OCPP_RESULT) {
          const resolve = ocppPending.get(value.revision);
          if (resolve) { ocppPending.delete(value.revision); resolve(value); }
          return;
        }
        if (topic === CONTROL) {
          // The actual control executors acquire the same process-wide lease
          // and keep it through readback; this signal only wakes the runtime's
          // own priority queue for backwards-compatible injected tasks.
          runtime.enqueueControl(async () => {});
          return;
        }
        if (topic === INVERTER) {
          inverter = value;
          if (['fronius_sunspec','sunspec_tcp'].includes(inverter.communication)) {
            discoverSunSpec(io.readModbus).then((discovery) => {
              io.discovery=discovery;
              if (desired) runtime.apply(desired, measurementOptions());
            }).catch((error)=>node.warn('SunSpec-Erkennung: '+error.message));
          }
          if (desired && !['fronius_sunspec','sunspec_tcp'].includes(inverter.communication)) {
            runtime.apply(desired, measurementOptions());
          }
          return;
        }
        if (topic === CONFIG) {
          desired = value;
          const plan = runtime.apply(value, measurementOptions());
          node.status(plan.pending ? { fill:'blue',shape:'ring',text:'OCPP-Abgleich Revision ' + value.revision }
            : plan.applied ? { fill:'green',shape:'dot',text:'Revision ' + value.revision }
            : { fill:'yellow',shape:'ring',text:'Plan abgelehnt' });
        } else if (topic === OCPP) {
          const values = value.samples || value;
          runtime.onMeterValues(values, value.observed_at ? new Date(value.observed_at) : undefined);
        }
      } catch (error) { node.warn('Messruntime: ' + error.message); }
    };
    core.client.on('message', onMessage);
    const timer = setInterval(() => runtime.tick().catch((error) => node.warn(error.message)), 250);
    node.on('close', (done) => {
      clearInterval(timer); core.client.removeListener('message', onMessage);
      core.client.removeListener('connect', subscribe); done();
    });
  }
  RED.nodes.registerType('vp-measurements', VpMeasurements);
};

module.exports.request = request;
module.exports.getJSON = getJSON;
module.exports.discoverSunSpec = discoverSunSpec;
module.exports.shapeShellyStatus = shapeShellyStatus;
module.exports.inverterJSONEndpoint = inverterJSONEndpoint;
