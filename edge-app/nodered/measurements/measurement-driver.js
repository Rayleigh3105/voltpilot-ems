'use strict';

const catalogDocument = require('./catalog.json');
const catalog = new Map(catalogDocument.points.map((p) => [p.point_key, p]));

function templateKey(key) {
  return key.replace(/\[[^\]]+\]/g, '[*]');
}

function resolvePoint(key, discovery) {
  let point = catalog.get(key);
  if (!point) point = catalog.get(templateKey(key));
  if (!point) return null;
  const moduleMatch = key.match(/^sunspec\.model_160\.module\[(\d+)]\./);
  if (moduleMatch) {
    const n = Number(discovery && discovery.models && discovery.models[160] && discovery.models[160].moduleCount);
    if (!Number.isInteger(n) || Number(moduleMatch[1]) >= n) return null;
    const address = Object.assign({}, point.address);
    address.offset_words = evalDynamicOffset(address.offset_words, Number(moduleMatch[1]));
    point = Object.assign({}, point, { point_key: key, address });
  }
  return point;
}

function evalDynamicOffset(expr, index) {
  if (Number.isInteger(expr)) return expr;
  const m = String(expr).match(/^(\d+)\+index\*(\d+)\+(\d+)$/);
  if (!m) throw new Error('invalid dynamic SunSpec offset');
  return Number(m[1]) + index * Number(m[2]) + Number(m[3]);
}

function wordsRaw(words) {
  if (words.length === 1) return words[0] & 0xffff;
  return words.map((v) => (v & 0xffff).toString(16).padStart(4, '0')).join('');
}

function derivedAddresses(point) {
  return [...new Set((point.derived_from || []).map((source) => {
    const match = String(source).match(/^holding:0x([0-9a-f]+)$/i);
    return match ? parseInt(match[1], 16) : null;
  }).filter(Number.isInteger))].sort((a, b) => a - b);
}

/**
 * Decode only derivations whose vendor rule is unambiguous in the packaged
 * catalog. The exact address=word vector remains raw in every case; rules with
 * firmware lookups/alternatives deliberately omit decoded instead of guessing.
 */
function decodeDerived(point, wireWords) {
  const addresses = derivedAddresses(point);
  if (!addresses.length || addresses.some((address) => !wireWords.has(address))) return null;
  const raw = addresses.map((address) => `${address.toString(16).padStart(4, '0')}=`
    + `${(wireWords.get(address) & 0xffff).toString(16).padStart(4, '0')}`).join(',');
  const out = { point_key: point.point_key, raw, quality: 'good' };
  const decoder = point.decoder || {};
  if (decoder.rule !== 1 || !Array.isArray(decoder.sensors)
      || decoder.sensors.some((sensor) => sensor.enabled_lookup || sensor.mppt
        || !Array.isArray(sensor.registers) || sensor.registers.flat(Infinity).some((r) => !Number.isInteger(r)))) {
    return out;
  }
  let total = 0;
  for (const sensor of decoder.sensors) {
    let value;
    if (sensor.multiply && Array.isArray(sensor.multiply.registers)
        && sensor.registers.length === 1 && sensor.multiply.registers.length === 1) {
      value = wireWords.get(sensor.registers[0]) * wireWords.get(sensor.multiply.registers[0]);
    } else if (sensor.registers.length === 1) value = wireWords.get(sensor.registers[0]);
    else return out; // multiword vendor rules use rule 3/4 and remain raw-only.
    total += sensor.operator === 'subtract' ? -value : value;
  }
  const scale = point.scale || { kind: 'none' };
  if (scale.kind === 'factor') total *= Number(scale.value);
  else if (scale.kind === 'divisor') total /= Number(scale.value);
  else if (scale.kind !== 'none') return out;
  const validation = decoder.validation || {};
  if (validation.min != null && total < validation.min
      || validation.max != null && total > validation.max) out.quality = 'invalid';
  else if (Number.isFinite(total)) out.decoded = total;
  return out;
}

function baseNumber(point, words) {
  const b = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => b.writeUInt16BE(w & 0xffff, i * 2));
  switch (point.value_type) {
    case 'int16': case 'sunssf': return b.readInt16BE(0);
    case 'uint16': case 'enum16': case 'bitfield16': case 'count': return b.readUInt16BE(0);
    case 'int32': return point.endian === 'word_little_byte_big'
      ? Buffer.from([b[2], b[3], b[0], b[1]]).readInt32BE(0) : b.readInt32BE(0);
    case 'uint32': case 'acc32': case 'bitfield32': return point.endian === 'word_little_byte_big'
      ? Buffer.from([b[2], b[3], b[0], b[1]]).readUInt32BE(0) : b.readUInt32BE(0);
    case 'float32': return b.readFloatBE(0);
    case 'string': return b.toString('ascii').replace(/\0+$/, '');
    default: return null;
  }
}

/** Decode once at the edge. Unknown/conditional scale deliberately omits decoded. */
function decodeRegisters(point, words, scaleFactors) {
  const width = point.address && point.address.width_words;
  if (!Array.isArray(words) || !width || words.length !== width) return null;
  const raw = wordsRaw(words);
  let decoded = baseNumber(point, words);
  if (decoded === null || (typeof decoded === 'number' && !Number.isFinite(decoded))) {
    return { point_key: point.point_key, raw, quality: 'invalid' };
  }
  const scale = point.scale || { kind: 'none' };
  if (scale.kind === 'factor') decoded *= Number(scale.value);
  else if (scale.kind === 'divisor') decoded /= Number(scale.value);
  else if (scale.kind === 'sunssf') {
    const sf = scaleFactors && scaleFactors[scale.point];
    if (!Number.isInteger(sf) || sf === -32768) decoded = undefined;
    else decoded *= Math.pow(10, sf);
  } else if (!['none', 'protocol_value'].includes(scale.kind)) decoded = undefined;
  const out = { point_key: point.point_key, raw, quality: 'good' };
  if (decoded !== undefined) out.decoded = decoded;
  return out;
}

function pathValue(root, selector) {
  const clean = selector.replace(/^\$\.?/, '').replace(/\[(\d+)]/g, '.$1');
  return clean.split(/[./]/).filter(Boolean).reduce((v, key) => v == null ? undefined : v[key], root);
}

function decodeJSON(point, payload) {
  let selector = point.selector;
  if (selector.includes('?filter=')) selector = selector.split('?filter=')[1];
  else if (selector.includes('#')) selector = selector.split('#')[1];
  const indices = [...point.point_key.matchAll(/\[(\d+)]/g)].map((m) => m[1]);
  for (const index of indices) selector = selector.replace('[*]', `[${index}]`);
  const value = pathValue(payload, selector);
  if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) return null;
  if (!['number', 'string', 'boolean'].includes(typeof value)) return null;
  return { point_key: point.point_key, raw: value, decoded: value, quality: 'good' };
}

function ocppPointKey(value) {
  const slug = (v) => String(v == null ? 'none' : v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const measurand = String(value.measurand || 'Energy.Active.Import.Register').toLowerCase();
  return `ocpp.1_6.metervalues.${measurand}`
    + `.context[${slug(value.context || 'Sample.Periodic')}].format[${slug(value.format || 'Raw')}]`
    + `.phase[${slug(value.phase || 'none')}].location[${slug(value.location || 'Outlet')}]`
    + `.unit[${slug(value.unit || 'none')}]`;
}

function decodeOcppSampledValue(value) {
  const key = ocppPointKey(value);
  const point = resolvePoint(key);
  if (!point) return null;
  const raw = value.value;
  if (!['number', 'string'].includes(typeof raw)) return null;
  const out = { point_key: key, raw, quality: 'good' };
  if ((value.format || 'Raw') === 'SignedData') {
    out.signed_data = String(raw); out.signed_data_format = 'OCPP1.6/SignedData';
  } else {
    const n = Number(raw); if (Number.isFinite(n)) out.decoded = n;
  }
  return out;
}

module.exports = { catalogDocument, resolvePoint, decodeRegisters, decodeJSON,
  decodeDerived, derivedAddresses, decodeOcppSampledValue, ocppPointKey, templateKey,
  _helpers: { templateKey, evalDynamicOffset, pathValue } };
