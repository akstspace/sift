import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
const backend = 'http://127.0.0.1:' + (process.env.SIFT_PORT || '57431')
const devPort = Number(process.env.SIFT_DEV_PORT || '57433')
const devOrigin = `http://127.0.0.1:${devPort}`

// Keep production's loopback/origin protections intact. Only this exact local
// development origin is translated by the development proxy; no bearer token
// is exposed to Vite's client. Visit the service first for its HttpOnly cookie.
const localOnly: Plugin = {
  name: 'sift-local-development',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.headers.host !== `127.0.0.1:${devPort}` ||
          (req.headers.origin && req.headers.origin !== devOrigin) ||
          req.headers['sec-fetch-site'] === 'cross-site') {
        res.statusCode = 403
        res.end('Sift development UI accepts only its local origin')
        return
      }
      next()
    })
  },
}

export default defineConfig({
  plugins: [localOnly, react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: {
    outDir: '../internal/sift/public', emptyOutDir: true,
    // Cache foundational UI/runtime separately from changing application code.
    // Task details are eager so the primary interaction never swaps loading
    // panels. Secondary routes and model-search code remain lazy.
    rolldownOptions: { output: { codeSplitting: { groups: [
      { name: 'react-runtime', test: /node_modules\/(react|react-dom|scheduler)\// },
      { name: 'motion', test: /node_modules\/(motion|motion-dom|motion-utils|framer-motion)\// },
      { name: 'primitives', test: /node_modules\/(radix-ui|@radix-ui)\// },
    ] } } },
  },
  server: {
    host: '127.0.0.1', port: devPort, strictPort: true, cors: false,
    proxy: { '/api': {
      target: backend, changeOrigin: true,
      configure(proxy) {
        proxy.on('proxyReq', (outgoing, request) => {
          if (request.headers.origin === devOrigin) outgoing.setHeader('Origin', backend)
        })
      },
    } },
  },
})
