// Scenario runner. A scenario is a JSON file in config/scenarios with a list of steps:
//   { "wait": ms }                                  pause
//   { "target": "MN", "cmd": "handoff", "args": {} } control command to one agent ("ALL" for every agent)
//   { "set": { feature: value } }                    change simulator features everywhere
//   { "reset": true }                                reset every agent and the metrics
//   { "phase": "label" | null }                      tag following latency samples (side-by-side results)
//   { "repeat": n, "steps": [...] }                  loop
//   { "summary": true }                              emit the phase comparison table
// Any step may carry "note", which is shown on the dashboard as the scenario narration.
'use strict';

const fs = require('fs');
const path = require('path');

function loadScenarios(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    s.id = s.id || path.basename(f, '.json');
    return s;
  });
}

class ScenarioRunner {
  /** hooks: { command(target, cmd, args), set(features), reset(), phase(label), summary(), emit(event) } */
  constructor(hooks) {
    this.hooks = hooks;
    this.token = 0;
    this.current = null;
  }

  status() {
    return this.current ? { id: this.current.id, title: this.current.title, step: this.step, total: this.total } : null;
  }

  stop(reason = 'stopped') {
    if (!this.current) return;
    const s = this.current;
    this.token += 1;
    this.current = null;
    this.hooks.phase(null);
    this.hooks.emit({ kind: 'scenario', node: 'GATEWAY', summary: `Scenario "${s.title}" ${reason}`, scenario: s.id, state: reason });
  }

  async run(scenario) {
    this.stop('interrupted by another scenario');
    const token = ++this.token;
    this.current = scenario;
    this.step = 0;
    this.total = countSteps(scenario.steps);
    this.hooks.emit({ kind: 'scenario', node: 'GATEWAY', summary: `Scenario "${scenario.title}" started: ${scenario.description}`,
      scenario: scenario.id, state: 'running' });
    try {
      await this.exec(scenario.steps, token);
    } catch (e) {
      if (e.message !== 'cancelled') throw e;
      return;
    }
    if (token === this.token) this.stop('finished');
  }

  async exec(steps, token) {
    for (const st of steps) {
      if (token !== this.token) throw new Error('cancelled');
      if (st.repeat) {
        for (let i = 0; i < st.repeat; i += 1) await this.exec(st.steps, token);
        continue;
      }
      this.step += 1;
      if (st.note) this.hooks.emit({ kind: 'scenario', node: 'GATEWAY', summary: st.note, scenario: this.current.id, state: 'step', step: this.step, total: this.total });
      if (st.reset) this.hooks.reset();
      if (st.set) this.hooks.set(st.set);
      if ('phase' in st) this.hooks.phase(st.phase);
      if (st.target && st.cmd) this.hooks.command(st.target, st.cmd, st.args || {});
      if (st.summary) this.hooks.summary();
      if (st.wait) await sleep(st.wait);
    }
  }
}

function countSteps(steps) {
  return steps.reduce((n, s) => n + (s.repeat ? s.repeat * countSteps(s.steps) : 1), 0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { loadScenarios, ScenarioRunner };
