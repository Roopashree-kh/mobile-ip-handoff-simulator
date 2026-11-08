import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { connect } from './lib/ws.js';
import { getState, setState } from './lib/store.js';
import { compileFilter } from './lib/util.js';
import './index.css';

connect();
createRoot(document.getElementById('root')).render(<App />);

// Deep links for screenshots and the report: #analytics opens the drawer,
// #inspect=<filter> selects the newest packet that matches the filter.
const hash = decodeURIComponent(location.hash.slice(1));
if (hash === 'analytics') setState({ analyticsOpen: true });
const m = hash.match(/^inspect=(.+)$/);
if (m) {
  const f = compileFilter(m[1]);
  const t = setInterval(() => {
    const hit = [...getState().packets].reverse().find(f);
    if (hit) { setState({ selectedNo: hit.no }); clearInterval(t); }
  }, 300);
}
