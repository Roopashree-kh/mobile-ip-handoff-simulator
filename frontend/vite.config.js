// Ports are read from config/topology.json so nothing is hard-coded here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const topo = JSON.parse(readFileSync(fileURLToPath(new URL('../config/topology.json', import.meta.url)), 'utf8'));

export default defineConfig({
  plugins: [react()],
  define: { __GATEWAY_PORT__: JSON.stringify(topo.gateway.http_port) },
  server: { port: topo.frontend.dev_port, strictPort: true, host: 'localhost' },
  preview: { port: topo.frontend.dev_port },
  build: { chunkSizeWarningLimit: 1200 },
});
