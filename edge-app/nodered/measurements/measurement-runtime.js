'use strict';

const { buildPlan, Scheduler } = require('./measurement-planner');
const { resolvePoint, decodeRegisters, decodeDerived, derivedAddresses,
  decodeJSONSamples, decodeOcppSampledValue, templateKey } = require('./measurement-driver');
const { LIMITS, COST_MS, discoveryFor, byteOrderFor, geteiltePunkte, ablehnungenVon,
  leseSchluessel, registerbildFor, registerbilderJeZiel } = require('./measurement-planner');
const wago = require('./wago-registerbild');
const wagoKopf = require('./wago-kopf');
const { WagoEreignisse } = require('./wago-ereignisse');
const { TARGET_PRIMARY } = require('./measurement-binding');
const sourceStatus = require('./data-source-status');
const RESERVATION_MS = Object.freeze({ modbus_holding:4000, modbus_input:4000,
  sunspec_model:4000, http_api_key:4000, rest_json:4000, rpc_json:4000,
  ocpp_sampled_value:0 });

/** The target key one planned selection/block belongs to (default: primary). */
function targetKeyOf(selected) {
  return (selected && selected.target && selected.target.key) || TARGET_PRIMARY;
}

/** Per-target bucket of the words read in this tick. */
function wordsOf(wireWords, targetKey) {
  let bucket = wireWords.get(targetKey);
  if (!bucket) { bucket = new Map(); wireWords.set(targetKey, bucket); }
  return bucket;
}

/**
 * The HTTP poll-group key; must stay identical to the planner's. The planner
 * groups the READ, whose cadence at a shared point is the fastest of its
 * components (`lesetakt`, AP-07 IP-18b); without one it is the selection's own.
 */
function httpGroupKey(selected, lesetakt) {
  const takt = (lesetakt && lesetakt.get(leseSchluesselVon(selected))) || selected.cadence_s;
  return `${targetKeyOf(selected)}:${selected.point.poll_group}:${takt}`;
}

/** The one physical read a planned selection belongs to (target + point). */
function leseSchluesselVon(selected) {
  return leseSchluessel(targetKeyOf(selected), selected.point.point_key);
}

/** One component's sample timer; equals the read timer at a simple point. */
function probenSchluesselVon(selected) {
  return `${leseSchluesselVon(selected)}\u0000${selected.entity_id || ''}`;
}

function withEntity(sample, selected) {
  return selected.entity_id ? { ...sample, entity_id:selected.entity_id } : sample;
}

/**
 * Read-only runtime. Every I/O primitive is injected for bench simulation;
 * there is deliberately no write-register primitive in this module.
 */
class MeasurementRuntime {
  constructor(io, publish, now) {
    this.io = io || {}; this.publish = publish || (() => {}); this.now = now || (() => new Date());
    this.monotonicNow = this.io.monotonicNow || (() => Number(process.hrtime.bigint() / 1000000n));
    this.active = null; this.scheduler = new Scheduler(); this.due = new Map();
    this.probenDue = new Map(); this.lesetakt = new Map();
    this.tickPromise = null; this.requestWindow = []; this.sampleWindow = [];
    this.ocppDue = new Map(); this.applyGeneration = 0;
    this.decoderState = { previous:new Map(), values:new Map() };
    // WAGO register images (AP-05): the heartbeat is counted per controller across ticks
    // (IP-7), and an event is reported once per change of state (IP-8).
    this.herzschlagWacht = new wagoKopf.HerzschlagWacht();
    this.wagoEreignisse = new WagoEreignisse();
  }

  apply(config, options) {
    const planning = Object.assign({ discovery:this.io.discovery,
      discoveries:this.io.discoveries, binding:this.io.binding,
      ocppCapability:this.io.ocppCapability }, options || {});
    // The per-plant parameters of a register image travel IN the desired config
    // (`registerbilder`, keyed by the controller's component); the planner reads them per
    // target only. Without them every card point is refused, never read at address 0.
    if (!planning.registerbilder) {
      planning.registerbilder = registerbilderJeZiel(config && config.registerbilder,
        planning.binding);
    }
    const candidate = buildPlan(config, planning);
    if (candidate.applied) {
      const changes = candidate.ocppConfiguration || {};
      if (Object.keys(changes).length && typeof this.io.applyOcppConfiguration === 'function') {
        const generation = ++this.applyGeneration;
        candidate.pending = true;
        let result;
        try {
          // Invoke synchronously so accepting a desired OCPP plan always
          // produces the durable Core command before apply() returns.
          result = this.io.applyOcppConfiguration({ revision:config.revision,
            configuration:changes });
        } catch (error) {
          result = Promise.reject(error);
        }
        Promise.resolve(result).then((confirmed) => {
          if (generation !== this.applyGeneration) return;
          if (confirmed && confirmed.applied === false) throw new Error(confirmed.reason || 'rejected');
          this.activate(candidate, config);
          this.publishStatus(config, candidate);
        }).catch(() => {
          if (generation !== this.applyGeneration) return;
          const ocppSelections = candidate.selections.filter((selection) =>
            selection.point.source_kind === 'ocpp_sampled_value');
          const ocppKeys = new Set(ocppSelections.map((selection) => selection.requested_key));
          const fallback = buildPlan(Object.assign({}, config, { selections:(config.selections || [])
            .filter((selection) => !ocppKeys.has(selection.point_key)) }), planning);
          if (fallback.applied) this.activate(fallback, config);
          this.publishStatus(config, { accepted:fallback.accepted || [],
            rejected:(fallback.rejected || []).concat(ablehnungenVon(ocppSelections,
              'ocpp_configuration_incompatible', geteiltePunkte(config.selections))) });
        });
        return candidate;
      }
      this.applyGeneration++;
      this.activate(candidate, config);
    }
    this.publishStatus(config, candidate);
    return candidate;
  }

  activate(candidate, config) {
    // Only carry an explicit selection binding; never infer a component from
    // its transport or target. The planner carries each selection's own
    // entity_id (a shared point names a different one per occurrence); a
    // candidate without it takes the one of its point_key as before.
    const entities = new Map();
    for (const s of config.selections || []) {
      if (!entities.has(s.point_key)) entities.set(s.point_key, s.entity_id);
    }
    candidate.selections = candidate.selections.map((s) => (s.entity_id ? s : { ...s,
      ...(entities.get(s.requested_key) ? { entity_id:entities.get(s.requested_key) } : {}),
    }));
    // One pointer swap is the atomic cutover. No timer from the previous plan
    // survives because due is replaced together with active. `due` times the
    // READ of (target, point) at its fastest cadence, `probenDue` the sample
    // of each component at its own; at a simple point both are the same.
    const lesetakt = new Map();
    for (const s of candidate.selections) {
      const key = leseSchluesselVon(s);
      if (!lesetakt.has(key) || s.cadence_s < lesetakt.get(key)) lesetakt.set(key, s.cadence_s);
    }
    const due = new Map([...lesetakt.keys()].map((key) => [key, 0]));
    this.active = candidate; this.due = due; this.lesetakt = lesetakt;
    this.probenDue = new Map(candidate.selections.map((s) => [probenSchluesselVon(s), 0]));
    this.decoderState = { previous:new Map(), values:new Map() };
  }

  publishStatus(config, candidate) {
    this.publish('edge/measurements/config-status', {
      revision: config.revision, applied_at: this.now().toISOString(),
      accepted: candidate.accepted, rejected: candidate.rejected,
    }, true);
  }

  enqueueControl(run) { this.scheduler.enqueueControl({ kind:'control', run }); }

  tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this._tick().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }

  async _tick() {
    if (!this.active) return [];
    // Applying another plan while I/O awaits must not relabel the old read
    // with the new component, decoder state, catalog or applied revision.
    const plan = this.active; const decoderState = this.decoderState;
    const lesetakt = this.lesetakt;
    const now = this.now(); const ms = now.getTime(); const dueKeys = new Set();
    for (const s of plan.selections) {
      const key = leseSchluesselVon(s);
      if ((this.due.get(key) || 0) <= ms) dueKeys.add(key);
    }
    if (!dueKeys.size) return [];
    // A component's sample is due only together with a read of its point, so
    // a shared point never adds a read beyond its fastest cadence.
    const dueProben = new Set(plan.selections.filter((s) => dueKeys.has(leseSchluesselVon(s))
      && (this.probenDue.get(probenSchluesselVon(s)) || 0) <= ms));
    // Claim due work before the first await. Concurrent/re-entrant ticks can
    // now only join this run and can never issue a second physical read.
    for (const key of dueKeys) this.due.set(key, ms + (lesetakt.get(key) || 1) * 1000);
    for (const s of dueProben) this.probenDue.set(probenSchluesselVon(s), ms + s.cadence_s * 1000);
    const blocks = plan.blocks.filter((b) => b.points.some((p) =>
      dueKeys.has(leseSchluessel(targetKeyOf(b), p))));
    for (const block of blocks) this.scheduler.enqueuePoll({ kind: 'modbus', block });
    for (const group of plan.httpGroups) this.scheduler.enqueuePoll({ kind: 'json', group });
    // ⚠ Wire words are kept PER TARGET. Register 616 of a bound Fronius and
    // register 616 of the primary Deye are different facts; one flat map would
    // decode one device's words with the other's point.
    const samples = []; const wireWords = new Map(); const bilder = new Map();
    for (let task; (task = this.scheduler.next());) {
      if (task.kind === 'control') { await task.run(); continue; }
      if (task.kind === 'modbus') await this.readBlock(task.block, dueKeys, wireWords);
      else if (task.kind === 'json') samples.push(...await this.readJSON(task.group, dueKeys, plan, dueProben, lesetakt));
    }
    for (const prerequisite of plan.decoderPrerequisites || []) {
      if (!dueKeys.has(leseSchluessel(targetKeyOf(prerequisite), prerequisite.trigger_key))) continue;
      const words = wordsOf(wireWords, targetKeyOf(prerequisite));
      const addresses = this.addresses(prerequisite.point, targetKeyOf(prerequisite));
      if (addresses.length && addresses.every((address) => words.has(address))) {
        decodeRegisters(prerequisite.point, addresses.map((address) => words.get(address)),
          this.io.scaleFactors, addresses, this.decoderOptions(prerequisite.point, words,
            targetKeyOf(prerequisite), plan, decoderState));
      }
    }
    // Decode each read ONCE (decoders keep previous values) and hand the
    // result to every due component of that point.
    const dekodiert = new Map();
    for (const selected of plan.selections) {
      if (!dueProben.has(selected)) continue;
      const leseKey = leseSchluesselVon(selected);
      if (dekodiert.has(leseKey)) {
        const sample = dekodiert.get(leseKey);
        if (sample) samples.push(withEntity(sample, selected));
        continue;
      }
      const words = wordsOf(wireWords, targetKeyOf(selected));
      let sample = null;
      if (wago.istRegisterbildPunkt(selected.point)) {
        sample = this.registerbildSample(selected, words, plan, bilder, now);
      } else if (selected.point.address) {
        const addresses = this.addresses(selected.point, targetKeyOf(selected));
        if (addresses.length && addresses.every((address) => words.has(address))) {
          sample = decodeRegisters(selected.point, addresses.map((address) => words.get(address)),
            this.io.scaleFactors, addresses, this.decoderOptions(selected.point, words,
              targetKeyOf(selected), plan, decoderState));
        }
      } else if (derivedAddresses(selected.point).length) sample = decodeDerived(selected.point, words);
      dekodiert.set(leseKey, sample);
      if (sample) samples.push(withEntity(sample, selected));
    }
    if (samples.some((sample) => sample.invalidate_all)) {
      for (const sample of samples.filter(s => s.invalidate_all)) {
        const selected = plan.selections.find(x => x.point.point_key === sample.point_key && x.entity_id === sample.entity_id);
        if (selected) this.reportSource(selected.target, {failed:true,error_class:'implausible',point_key:selected.requested_key}, selected.entity_id);
      }
      return [];
    }
    return this.publishSamples(samples, now, plan);
  }

  /**
   * One card value of a WAGO register image. The image is judged ONCE per controller and tick
   * (IP-7 `pruefeLesung`: signature, version, length, word order, Soll, heartbeat), its events
   * go out once (IP-8), and only a card the head check calls `gelesen` yields a value - read
   * at base address + card offset with the plant's word order. `stale` from a standing
   * heartbeat rides on the sample; a foreign image yields no sample at all.
   */
  registerbildSample(selected, words, plan, bilder, now) {
    const gelesen = this.registerbildLesung(selected.target || { key:TARGET_PRIMARY, sourceId:null },
      words, plan, bilder, now);
    if (!gelesen || gelesen.ergebnis !== 'erkannt') return null;
    const index = wago.karteIndexAus(selected.point.point_key);
    const karte = Number.isInteger(index) ? gelesen.karten[index] : null;
    const familie = selected.point.family === 'wago.pm494' ? 494 : 495;
    if (!karte || karte.ergebnis !== 'gelesen' || karte.kartentyp !== familie) return null;
    const parameter = registerbildFor(plan, targetKeyOf(selected));
    const start = parameter.basisadresse + selected.point.address.offset_words;
    const addresses = Array.from({ length:selected.point.address.width_words }, (_, i) => start + i);
    if (!addresses.every((address) => words.has(address))) return null;
    // Contract §2: `big` stays big, `little` is the catalog's word_little_byte_big.
    const point = { ...selected.point,
      endian:parameter.wortfolge === 'little' ? 'word_little_byte_big' : 'big' };
    const sample = decodeRegisters(point, addresses.map((address) => words.get(address)),
      null, addresses, {});
    return sample && gelesen.qualitaet === 'stale' && sample.quality === 'good'
      ? { ...sample, quality:'stale' } : sample;
  }

  registerbildLesung(target, words, plan, bilder, now) {
    if (bilder.has(target.key)) return bilder.get(target.key);
    const parameter = registerbildFor(plan, target.key);
    let gelesen = null;
    if (parameter) {
      const laenge = (parameter.kopflaenge || wago.KOPFLAENGE_MIN)
        + parameter.kartenzahl * (parameter.kartenblocklaenge || wago.KARTENBLOCKLAENGE_MIN);
      const addresses = Array.from({ length:laenge }, (_, i) => parameter.basisadresse + i);
      if (addresses.every((address) => words.has(address))) {
        gelesen = wagoKopf.pruefeLesung(addresses.map((address) => words.get(address)),
          { steuerung:target.key, parameter, soll:parameter.soll, wacht:this.herzschlagWacht });
        // Findings path of the data source: a foreign image is `layout_changed` (IP-7), and so
        // is every other reason the image does not match its Soll - nothing was re-attached.
        // The read itself was already counted by readBlock.
        if (gelesen.ergebnis !== 'erkannt') {
          const befund = wagoKopf.befund(gelesen);
          this.reportSource(target, { failed:true,
            error_class:befund ? befund.error_class : wagoKopf.FINDING_ERROR_CLASS });
        }
        try {
          const komponente = (_karte, index) => {
            const s = plan.selections.find((x) => targetKeyOf(x) === target.key && x.entity_id
              && wago.karteIndexAus(x.point.point_key) === index);
            return s ? s.entity_id : null;
          };
          const { ereignisse } = this.wagoEreignisse.lesung(gelesen, { datenquelle:target.dataSourceId,
            steuerung:target.key, komponente, zeitpunkt:now });
          for (const nachricht of ereignisse) this.publish(nachricht.topic, nachricht.payload, false);
        } catch (_) { /* an event is an observation; it never costs the samples */ }
      }
    }
    bilder.set(target.key, gelesen);
    return gelesen;
  }

  decoderOptions(point, wireWords, targetKey, plan = this.active, decoderState = this.decoderState) {
    const decoder = point.decoder || {};
    return {
      byteOrder:byteOrderFor(plan || {}, targetKey || TARGET_PRIMARY),
      byteOrderWord:decoder.byte_order && wireWords.get(decoder.byte_order.register),
      variantWord:decoder.variant && wireWords.get(decoder.variant.register),
      previousValues:decoderState.previous,
      decodedValues:decoderState.values,
    };
  }

  reportSource(target, evidence, entityID) {
    if (typeof this.io.sourceStatus !== 'function') return;
    // Monitoring must not turn a completed read into a failed sample delivery.
    try { this.io.sourceStatus({ target, entity_id:entityID, ...evidence }); } catch (_) { /* isolated observer */ }
  }

  async readBlock(block, dueKeys, wireWords) {
    if (typeof this.io.readModbus !== 'function') return [];
    const target = block.target || { key:TARGET_PRIMARY, sourceId:null };
    let words;
    // The target reaches the I/O layer, which resolves the CONNECTION at read
    // time and throws when it cannot. A source that vanished between plan and
    // poll therefore produces a gap, never a read of the primary.
    try { words = await this.runMeasuredRequest(block.source_kind || 'modbus_holding',
      () => this.runBusTask(target, () => this.io.readModbus({ start:block.start,
        count:block.count, source_kind:block.source_kind, target, priority:'measurement',
        ...(block.funktionscode ? { funktionscode:block.funktionscode } : {}) }))); }
    catch (error) { this.reportSource(target, { requests:1, failed:true, error_class:sourceStatus.errorClass(error) }); return []; }
    if (words === MeasurementRuntime.BUDGET_BLOCKED) {
      this.reportSource(target, { failed:true, error_class:'budget' }); return [];
    }
    if (!Array.isArray(words) || words.length < block.count) {
      this.reportSource(target, { requests:1, failed:true, error_class:'invalid_response' }); return [];
    }
    this.reportSource(target, { requests:1 });
    const bucket = wordsOf(wireWords, target.key);
    for (let i = 0; i < block.count; i++) bucket.set(block.start + i, words[i]);
    return [];
  }

  async readJSON(group, dueKeys, plan = this.active, dueProben = null, lesetakt = this.lesetakt) {
    if (typeof this.io.readJSON !== 'function') return [];
    // A planned http group is {key, target}: one request per (target, group).
    const { key, target } = group;
    const inGroup = plan.selections.filter((x) => dueKeys.has(leseSchluesselVon(x))
      && httpGroupKey(x, lesetakt) === key);
    // The request names each point once, also a point shared by components.
    const selected = [...new Map(inGroup.map((x) => [x.point.point_key, x])).values()];
    if (!selected.length) return [];
    // go-e filter combines every selected API key into one request. Shelly RPC
    // groups by component/method through poll_group and one status response.
    const filter = selected.filter((x) => x.point.source_kind === 'http_api_key')
      .map((x) => x.point.selector.split('filter=')[1]).filter(Boolean).join(',');
    let payload;
    try { payload = await this.runMeasuredRequest(selected[0].point.source_kind,
      () => this.io.readJSON({ group:key, target, filter, points:selected.map((x)=>x.point) })); }
    catch (error) { this.reportSource(target, { requests:1, failed:true, error_class:sourceStatus.errorClass(error) }); return []; }
    if (payload === MeasurementRuntime.BUDGET_BLOCKED) {
      this.reportSource(target, { failed:true, error_class:'budget' }); return [];
    }
    this.reportSource(target, { requests:1 });
    const payloads = payload && Array.isArray(payload.__vpResponses)
      ? payload.__vpResponses : [payload];
    const dekodiert = new Map();
    return inGroup.filter((x) => !dueProben || dueProben.has(x)).flatMap((x) => {
      if (!dekodiert.has(x.point.point_key)) {
        dekodiert.set(x.point.point_key, payloads.flatMap((value) => decodeJSONSamples(x.point, value)));
      }
      return dekodiert.get(x.point.point_key).map((sample) => withEntity(sample, x));
    });
  }

  /** OCPP MeterValues is event-driven; it never enters the polling queue. */
  onMeterValues(values, observedAt) {
    if (!this.active || !Array.isArray(values)) return [];
    const accepted = new Set(this.active.accepted); const at = observedAt || this.now();
    const samples = values.map(decodeOcppSampledValue).flatMap((s) => {
      if (!s || !accepted.has(templateKey(s.point_key))) return [];
      // One sample per component of the point, each at its own cadence.
      return this.active.selections.filter((x) => x.requested_key === templateKey(s.point_key))
        .flatMap((selection) => {
          const dueKey = `${s.point_key}\u0000${selection.entity_id || ''}`;
          if (at.getTime() < (this.ocppDue.get(dueKey) || 0)) return [];
          this.ocppDue.set(dueKey, at.getTime() + selection.cadence_s * 1000);
          return [withEntity(s, selection)];
        });
    });
    return this.publishSamples(samples, at);
  }

  addresses(point, targetKey) {
    if (Array.isArray(point.address.registers)) return point.address.registers;
    if (point.address.kind !== 'sunspec_relative') return [];
    const discovery = discoveryFor(this.io, targetKey || TARGET_PRIMARY);
    const model = discovery && discovery.models && discovery.models[point.address.model_id];
    if (!model || !Number.isInteger(model.base) || !Number.isInteger(point.address.offset_words)) return [];
    const start = model.base + point.address.offset_words;
    return Array.from({ length:point.address.width_words }, (_, i) => start + i);
  }

  runBusTask(target, run) {
    return typeof this.io.runBusTask === 'function'
      ? this.io.runBusTask('measurement', run, target) : run();
  }

  trimWindow(window, ms) {
    while (window.length && !window[0].pending
      && (typeof window[0] === 'number' ? window[0] : window[0].at) <= ms - 60000) window.shift();
  }

  consumeRequest(kind) {
    return this.beginRequest(kind) !== null;
  }

  beginRequest(kind) {
    const ms = this.monotonicNow(); this.trimWindow(this.requestWindow, ms);
    if (this.requestWindow.length >= LIMITS.requestsPerMinute) return null;
    // Reserve the whole field timeout before touching the wire. A slow/silent
    // device can therefore never spend capacity that was not admitted. On
    // completion the reservation is reconciled to measured monotonic occupancy.
    const reserve = RESERVATION_MS[kind] ?? (COST_MS[kind] || 4000);
    // A request may outlive its conservative admission reservation. Until it
    // completes, count its live monotonic occupancy so another request cannot
    // enter on the strength of a stale 4 s reservation after the bus has
    // already been occupied longer than that.
    for (const pending of this.requestWindow) if (pending.pending) {
      pending.cost = Math.max(pending.cost, Math.max(1, ms - pending.started));
    }
    const duty = this.requestWindow.reduce((sum, x) => sum + x.cost, 0);
    if ((duty + reserve) / 600 > LIMITS.dutyPercent) return null;
    const ticket = { at:ms, started:ms, cost:reserve, pending:true };
    this.requestWindow.push(ticket);
    return ticket;
  }

  finishRequest(ticket) {
    if (!ticket || !ticket.pending) return;
    ticket.pending = false;
    ticket.cost = Math.max(1, this.monotonicNow() - ticket.started);
  }

  async runMeasuredRequest(kind, run) {
    const ticket = this.beginRequest(kind);
    if (!ticket) return MeasurementRuntime.BUDGET_BLOCKED;
    try { return await run(); }
    finally { this.finishRequest(ticket); }
  }

  publishSamples(samples, at, plan = this.active) {
    const ms = at.getTime(); this.trimWindow(this.sampleWindow, ms);
    const room = Math.max(0, LIMITS.samplesPerMinute - this.sampleWindow.length);
    const kept = samples.slice(0, room); const dropped = samples.length - kept.length;
    for (let i = 0; i < kept.length; i++) this.sampleWindow.push(ms);
    for (const sample of kept) {
      const selected = plan.selections.find(x => x.entity_id === sample.entity_id && (x.point.point_key === sample.point_key || x.requested_key === templateKey(sample.point_key)));
      if (selected) this.reportSource(selected.target, { ...(sample.quality === 'invalid' ? {failed:true,error_class:'implausible'} : {samples:1}), point_key:selected.requested_key }, selected.entity_id);
    }
    for (const sample of samples.slice(room)) {
      const selected = plan.selections.find(x => x.entity_id === sample.entity_id && (x.point.point_key === sample.point_key || x.requested_key === templateKey(sample.point_key)));
      if (selected) this.reportSource(selected.target, { failed:true, error_class:'budget', point_key:selected.requested_key }, selected.entity_id);
    }
    if (kept.length || dropped) this.publish('edge/measurements/samples', {
      catalog_version:plan.catalog_version, observed_at:at.toISOString(), samples:kept,
      ...(Number.isSafeInteger(plan.revision) && plan.revision >= 0
        ? { applied_revision:plan.revision } : {}),
      ...(dropped ? { gap:true, dropped_samples:dropped } : {}),
    }, false);
    return kept;
  }
}

MeasurementRuntime.BUDGET_BLOCKED = Symbol('budget-blocked');

module.exports = { MeasurementRuntime, RESERVATION_MS, httpGroupKey };
